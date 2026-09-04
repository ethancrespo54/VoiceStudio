"""Six-stem separation must actually produce six stems.

The failure this pins is silent. ``demucs.separate`` accepts ``--two-stems``
alongside a six-source model without complaint: the run succeeds, the exit code
is 0, and four of the six stems are simply never written. Nothing in the logs
says so. A caller that trusted the exit code would ship a mixing desk with a
guitar fader that does nothing.

So the command shape is asserted directly (``--two-stems`` absent, the 6s model
named), and the collector refuses a partial set rather than returning whatever
happened to land on disk.

These tests run without torch or demucs installed — the module resolves both
lazily, and the subprocess runner is injected.
"""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from services import stem_split  # noqa: E402
from services.stem_split import (  # noqa: E402
    SIX_STEM_MODEL,
    SIX_STEMS,
    StemSeparationError,
    build_demucs_cmd,
    collect_stems,
    parse_progress,
    stem_output_dir,
)


# --------------------------------------------------------------- command shape

def test_command_never_passes_two_stems():
    """--two-stems caps the output at two files whatever model is named."""
    cmd = build_demucs_cmd("/tmp/song.wav", "/tmp/out")
    assert "--two-stems" not in cmd


def test_command_names_the_six_source_model():
    cmd = build_demucs_cmd("/tmp/song.wav", "/tmp/out")
    assert "-n" in cmd
    assert cmd[cmd.index("-n") + 1] == "htdemucs_6s"


def test_command_carries_source_and_output():
    cmd = build_demucs_cmd("/tmp/song.wav", "/tmp/out")
    assert "/tmp/song.wav" in cmd
    assert cmd[cmd.index("-o") + 1] == "/tmp/out"


def test_device_is_omitted_when_unresolved():
    """demucs picks its own default; passing -d None would be a literal 'None'."""
    cmd = build_demucs_cmd("/tmp/song.wav", "/tmp/out", device=None)
    assert "-d" not in cmd


def test_device_is_passed_when_given():
    cmd = build_demucs_cmd("/tmp/song.wav", "/tmp/out", device="cuda")
    assert cmd[cmd.index("-d") + 1] == "cuda"


def test_six_stems_are_the_expected_set():
    assert set(SIX_STEMS) == {"vocals", "drums", "bass", "guitar", "piano", "other"}
    assert len(SIX_STEMS) == 6


# ------------------------------------------------------------------ output dir

def test_output_dir_follows_model_and_input_basename():
    """demucs names the directory after its INPUT, not the job."""
    got = stem_output_dir("/jobs/j1", "/jobs/j1/audio_hq.wav")
    assert got == os.path.join("/jobs/j1", SIX_STEM_MODEL, "audio_hq")


def test_output_dir_strips_only_the_extension():
    got = stem_output_dir("/out", "/in/my.song.v2.flac")
    assert got.endswith(os.path.join(SIX_STEM_MODEL, "my.song.v2"))


# -------------------------------------------------------------------- collector

def _write_stems(root, names):
    os.makedirs(root, exist_ok=True)
    for n in names:
        with open(os.path.join(root, f"{n}.wav"), "wb") as fh:
            fh.write(b"RIFF")


def test_collect_returns_all_six(tmp_path):
    d = tmp_path / "stems"
    _write_stems(d, SIX_STEMS)
    got = collect_stems(str(d))
    assert set(got) == set(SIX_STEMS)
    assert all(os.path.exists(p) for p in got.values())


def test_collect_refuses_a_partial_set(tmp_path):
    """The two-stem regression: exit 0, two files, four silently absent."""
    d = tmp_path / "stems"
    _write_stems(d, ["vocals", "no_vocals"])
    with pytest.raises(StemSeparationError) as err:
        collect_stems(str(d))
    msg = str(err.value)
    assert "missing" in msg
    for absent in ("drums", "bass", "guitar", "piano", "other"):
        assert absent in msg


def test_collect_names_every_missing_stem(tmp_path):
    d = tmp_path / "stems"
    _write_stems(d, ["vocals", "drums", "bass", "other"])
    with pytest.raises(StemSeparationError) as err:
        collect_stems(str(d))
    assert "guitar" in str(err.value)
    assert "piano" in str(err.value)


# --------------------------------------------------------------------- progress

@pytest.mark.parametrize(
    "line,expected",
    [
        ("  42%|████      | 21/50", 42),
        ("100%|██████████| 50/50", 100),
        ("0%|          | 0/50", 0),
        ("Separating track /tmp/song.wav", None),
        ("", None),
    ],
)
def test_progress_parsing(line, expected):
    assert parse_progress(line) == expected


def test_progress_is_clamped():
    assert parse_progress("120%|") == 100


# ------------------------------------------------------------------ integration

class _FakeRunner:
    """Stands in for run_proc_streaming_stderr with a scripted stderr."""

    def __init__(self, lines, rc=0, stderr=b"", on_cmd=None):
        self.lines, self.rc, self.stderr, self.on_cmd = lines, rc, stderr, on_cmd

    def __call__(self, job_id, cmd, *, timeout=1800.0):
        if self.on_cmd:
            self.on_cmd(cmd)

        async def gen():
            for line in self.lines:
                yield ("stderr", line)
            yield ("done", self.rc, self.stderr)

        return gen()


def test_separate_reports_each_percent_once(tmp_path):
    out = tmp_path / "job"
    produced = out / SIX_STEM_MODEL / "song"
    _write_stems(produced, SIX_STEMS)

    seen = []
    runner = _FakeRunner(["10%|", "10%|", "55%|", "55%|", "100%|"])
    asyncio.run(
        stem_split.separate_six_stems(
            "job1", str(tmp_path / "song.wav"), str(out),
            runner=runner, on_progress=seen.append, device="cpu",
        )
    )
    assert seen == [10, 55, 100], "duplicate percents must not re-fire"


def test_separate_flattens_paths_and_removes_scaffolding(tmp_path):
    out = tmp_path / "job"
    produced = out / SIX_STEM_MODEL / "song"
    _write_stems(produced, SIX_STEMS)

    got = asyncio.run(
        stem_split.separate_six_stems(
            "job1", str(tmp_path / "song.wav"), str(out),
            runner=_FakeRunner(["100%|"]), device="cpu",
        )
    )
    assert set(got) == set(SIX_STEMS)
    for name, path in got.items():
        assert path == os.path.join(str(out), f"{name}.wav")
        assert os.path.exists(path)
    assert not os.path.exists(os.path.join(str(out), SIX_STEM_MODEL))


def test_separate_raises_on_nonzero_exit(tmp_path):
    runner = _FakeRunner([], rc=1, stderr=b"CUDA out of memory")
    with pytest.raises(StemSeparationError) as err:
        asyncio.run(
            stem_split.separate_six_stems(
                "job1", str(tmp_path / "song.wav"), str(tmp_path / "out"),
                runner=runner, device="cpu",
            )
        )
    assert "CUDA out of memory" in str(err.value)


def test_separate_raises_when_stems_are_short(tmp_path):
    """Exit 0 is not proof of six stems."""
    out = tmp_path / "job"
    _write_stems(out / SIX_STEM_MODEL / "song", ["vocals", "no_vocals"])
    with pytest.raises(StemSeparationError):
        asyncio.run(
            stem_split.separate_six_stems(
                "job1", str(tmp_path / "song.wav"), str(out),
                runner=_FakeRunner(["100%|"]), device="cpu",
            )
        )


def test_separate_builds_a_six_stem_command(tmp_path):
    """End-to-end guard that the shipped command never regains --two-stems."""
    out = tmp_path / "job"
    _write_stems(out / SIX_STEM_MODEL / "song", SIX_STEMS)
    seen = {}
    runner = _FakeRunner(["100%|"], on_cmd=lambda c: seen.setdefault("cmd", c))
    asyncio.run(
        stem_split.separate_six_stems(
            "job1", str(tmp_path / "song.wav"), str(out),
            runner=runner, device="cpu",
        )
    )
    assert "--two-stems" not in seen["cmd"]
    assert SIX_STEM_MODEL in seen["cmd"]


def test_keeps_nested_layout_when_cleanup_disabled(tmp_path):
    out = tmp_path / "job"
    produced = out / SIX_STEM_MODEL / "song"
    _write_stems(produced, SIX_STEMS)
    got = asyncio.run(
        stem_split.separate_six_stems(
            "job1", str(tmp_path / "song.wav"), str(out),
            runner=_FakeRunner(["100%|"]), device="cpu", cleanup=False,
        )
    )
    assert got["vocals"] == os.path.join(str(produced), "vocals.wav")
    assert os.path.exists(os.path.join(str(out), SIX_STEM_MODEL))


# ------------------------------------------------------------ real path helpers

def test_config_helpers_contain_job_traversal():
    """The router monkeypatches these; the shipped ones must contain too.

    The property is that a path outside the root is never RETURNED. Two
    outcomes satisfy it: separators sanitise to a flat name inside the root
    (``../../etc`` -> ``.._.._etc``), or the realpath check rejects the id
    outright and raises. ``..`` takes the second route — dots survive the
    character filter, exactly as in ``dub_seg_path`` — and the routes turn that
    ValueError into a 400.
    """
    from core.config import STEMS_DIR, stem_job_dir

    root = os.path.realpath(STEMS_DIR)
    for evil in ["../../etc", "..", "/etc/passwd", "a/../../b"]:
        try:
            got = stem_job_dir(evil)
        except ValueError:
            continue  # rejected outright — contained
        assert got == root or got.startswith(root + os.sep), f"{evil!r} escaped to {got}"


def test_dotdot_job_id_is_rejected_not_resolved():
    """Pins the raise, so a future sanitiser change cannot silently return the parent."""
    from core.config import stem_job_dir

    with pytest.raises(ValueError, match="escapes STEMS_DIR"):
        stem_job_dir("..")


def test_config_helpers_contain_stem_traversal():
    from core.config import STEMS_DIR, stem_file_path

    root = os.path.realpath(STEMS_DIR)
    for evil in ["../../passwd", "../source", "/etc/shadow"]:
        try:
            got = stem_file_path("job1", evil)
        except ValueError:
            continue
        assert got.startswith(root + os.sep), f"{evil!r} escaped to {got}"


def test_config_helper_round_trips_a_real_stem_name():
    from core.config import stem_file_path, stem_job_dir

    assert stem_file_path("job1", "vocals") == os.path.join(stem_job_dir("job1"), "vocals.wav")


# ------------------------------------------------------- dub pipeline untouched

def test_dub_pipeline_still_requests_two_stems():
    """Dubbing needs vocals + no_vocals. If this fails, dubbing is broken.

    Guards the reason this module exists at all: the six-stem work must not have
    been implemented by editing the dubbing call.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(os.path.dirname(here), "services", "dub_pipeline.py")
    with open(src, encoding="utf-8") as fh:
        body = fh.read()
    assert '"--two-stems", "vocals"' in body
    assert '"-n", "htdemucs"' in body
