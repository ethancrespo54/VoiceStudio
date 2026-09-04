"""Six-stem instrument separation — vocals, drums, bass, guitar, piano, other.

This is deliberately NOT a change to the demucs call in ``dub_pipeline``.

That call runs ``--two-stems vocals -n htdemucs`` and produces exactly
``vocals.wav`` + ``no_vocals.wav``. Dubbing depends on that shape: the vocal
track is transcribed and replaced, and ``no_vocals.wav`` is the background bed
the new dub is mixed back under. ``no_vocals_path`` is stored on the job and
read across ``dub_pipeline`` and ``dub_export``. Switching that call to a
six-source model would delete ``no_vocals.wav`` from the output and break
dubbing, because six-stem mode has no combined-background stem — it has five
instrument stems that would have to be summed back together to reconstruct one.

So the six-stem path lives here, separately, and the dub pipeline is untouched.
Both call the same ``demucs.separate`` entry point with different models.

Two things differ from the dubbing invocation:

  1. ``-n htdemucs_6s`` instead of ``htdemucs``. The 6s model is the only
     bundled demucs model that emits guitar and piano as their own stems;
     every other variant folds them into ``other``.
  2. No ``--two-stems``. That flag is what caps the output at two files, and
     passing it alongside a six-source model silently gives you two stems
     back — the model loads, the run succeeds, and the extra four are
     discarded. That failure is silent, which is why
     :func:`build_demucs_cmd` is tested for its absence.

Quality note, so callers do not misread the output: ``htdemucs_6s`` derives
guitar and piano by splitting what the four-source model leaves in ``other``.
Vocals, drums and bass come out at the usual quality; guitar and piano are
noticeably rougher, piano especially. That is the model's ceiling, not a
defect in this code.

Local-first: ``htdemucs_6s`` weights are a separate download from ``htdemucs``,
fetched by demucs on first use. Callers that must not hit the network should
check :func:`is_model_cached` first and surface the download as an explicit
user action.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
from typing import AsyncIterator, Callable, Iterable

SIX_STEM_MODEL = "htdemucs_6s"

#: Emitted by ``htdemucs_6s``, one WAV each. Order is presentation order for a
#: mixing desk (voice on top, rhythm section, then harmony), not demucs' own.
SIX_STEMS: tuple[str, ...] = ("vocals", "drums", "bass", "guitar", "piano", "other")

#: demucs writes a tqdm bar to stderr as "  42%|████      | …".
_PCT_RE = re.compile(r"(\d{1,3})%")


class StemSeparationError(RuntimeError):
    """Separation did not produce a usable six-stem set."""


def parse_progress(line: str) -> int | None:
    """Extract an integer percent from one demucs stderr line, else None.

    Clamped to 0..100: demucs has been seen to emit >100 briefly when a run
    is resumed, and a progress bar that jumps past full reads as a bug to the
    user even when the separation is fine.
    """
    m = _PCT_RE.search(line)
    if not m:
        return None
    return max(0, min(100, int(m.group(1))))


def build_demucs_cmd(
    src: str,
    out_dir: str,
    *,
    model: str = SIX_STEM_MODEL,
    device: str | None = None,
) -> list[str]:
    """Command line for a six-stem separation of ``src`` into ``out_dir``.

    ``--two-stems`` is intentionally absent; see the module docstring. ``device``
    is resolved lazily by the caller so this module stays importable without
    torch installed.
    """
    cmd = [sys.executable, "-m", "demucs.separate", "-n", model]
    if device:
        cmd += ["-d", device]
    cmd += [src, "-o", out_dir]
    return cmd


def stem_output_dir(out_dir: str, src: str, *, model: str = SIX_STEM_MODEL) -> str:
    """Where demucs puts the stems: ``<out_dir>/<model>/<src basename>/``.

    The basename carries no extension. This mirrors the derivation in
    ``dub_pipeline`` — demucs names the directory after its INPUT file, so a
    caller that passes ``audio_hq.wav`` gets ``audio_hq/``, not ``audio/``.
    """
    stem_name = os.path.splitext(os.path.basename(src))[0]
    return os.path.join(out_dir, model, stem_name)


def collect_stems(
    produced_dir: str,
    *,
    stems: Iterable[str] = SIX_STEMS,
) -> dict[str, str]:
    """Map stem name -> path, raising if any stem is missing.

    A partial set is never returned. Missing stems mean either the wrong model
    ran or ``--two-stems`` leaked back into the command, and both produce audio
    that silently lacks instruments the caller has already promised the user.
    """
    found: dict[str, str] = {}
    missing: list[str] = []
    for name in stems:
        path = os.path.join(produced_dir, f"{name}.wav")
        if os.path.exists(path):
            found[name] = path
        else:
            missing.append(name)
    if missing:
        raise StemSeparationError(
            f"demucs produced {len(found)} of {len(found) + len(missing)} stems; "
            f"missing: {', '.join(missing)}"
        )
    return found


def is_model_cached(model: str = SIX_STEM_MODEL) -> bool:
    """True when the model's weights are already on disk.

    Used to gate the first-run download behind explicit user action rather than
    stalling a separation for minutes on an unannounced fetch.
    """
    roots = [
        os.path.join(os.path.expanduser("~"), ".cache", "torch", "hub", "checkpoints"),
        os.environ.get("TORCH_HOME", ""),
        os.environ.get("DEMUCS_MODELS", ""),
    ]
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for entry in os.listdir(root):
            if model in entry:
                return True
    return False


def resolve_device() -> str | None:
    """Best available torch device, or None when torch is unavailable.

    Imported lazily and defensively: this module is useful (and testable) on a
    machine with no torch, and demucs picks its own default when ``-d`` is
    omitted.
    """
    try:
        from services.model_manager import get_best_device  # noqa: PLC0415

        return get_best_device()
    except Exception:
        return None


async def separate_six_stems(
    job_id: str,
    src: str,
    out_dir: str,
    *,
    runner: Callable[..., AsyncIterator[tuple]] | None = None,
    on_progress: Callable[[int], None] | None = None,
    device: str | None = None,
    model: str = SIX_STEM_MODEL,
    timeout: float = 1800.0,
    cleanup: bool = True,
) -> dict[str, str]:
    """Separate ``src`` into six stems under ``out_dir``. Returns name -> path.

    Streams demucs' progress through ``on_progress`` as integer percents, each
    reported once, so a caller can drive an SSE stage without re-parsing stderr.

    ``runner`` defaults to ``dub_pipeline.run_proc_streaming_stderr`` and exists
    to be injected in tests — importing it eagerly would pull the dubbing module
    and its torch dependencies into every import of this one.

    Raises StemSeparationError on a nonzero exit or an incomplete stem set.
    """
    if runner is None:
        from services.dub_pipeline import run_proc_streaming_stderr  # noqa: PLC0415

        runner = run_proc_streaming_stderr

    if device is None:
        device = resolve_device()

    cmd = build_demucs_cmd(src, out_dir, model=model, device=device)

    rc = -1
    stderr_full = b""
    last_pct = -1
    async for evt in runner(job_id, cmd, timeout=timeout):
        if evt[0] == "stderr":
            pct = parse_progress(evt[1])
            if pct is not None and pct != last_pct:
                last_pct = pct
                if on_progress:
                    on_progress(pct)
        elif evt[0] == "done":
            rc, stderr_full = evt[1], evt[2]

    if rc != 0:
        detail = stderr_full.decode(errors="replace")[:500] if stderr_full else "no stderr"
        raise StemSeparationError(f"demucs exited {rc}: {detail}")

    produced = stem_output_dir(out_dir, src, model=model)
    stems = collect_stems(produced)

    if cleanup:
        # Lift the stems out of demucs' nested <model>/<basename>/ layout so the
        # caller owns flat paths, then drop the scaffolding.
        flat: dict[str, str] = {}
        for name, path in stems.items():
            dest = os.path.join(out_dir, f"{name}.wav")
            shutil.move(path, dest)
            flat[name] = dest
        shutil.rmtree(os.path.join(out_dir, model), ignore_errors=True)
        return flat

    return stems
