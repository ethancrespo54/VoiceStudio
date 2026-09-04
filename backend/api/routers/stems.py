"""Six-stem separation endpoints — the backend for the stem desk.

Splits one audio file into vocals, drums, bass, guitar, piano and other, so a
mixing desk can fade each instrument independently. Distinct from the dub
pipeline's separation, which produces vocals + no_vocals and must stay that way
for dubbing to work; see ``services/stem_split`` for why the two are separate.

Admin-gated like the rest of the local-only surface: separation spawns a
subprocess and writes into the app data directory, and a run costs minutes of
CPU or GPU — an unauthenticated caller could pin the host by posting files.

Routes:
  POST /stems/separate        multipart upload, streams SSE progress
  GET  /stems/{job}           manifest of what a finished job produced
  GET  /stems/{job}/{stem}    one stem WAV
  DELETE /stems/{job}         drop a job's audio from disk

The SSE contract mirrors the dub prep stream (plain ``data: {...}`` lines, a
``type`` on every event) so the frontend's existing stage tracker can consume
it without a second parser:

  {"type": "start",    "job_id": "...", "stems": [...]}
  {"type": "progress", "percent": 0-100}
  {"type": "done",     "job_id": "...", "stems": {"vocals": "/stems/<job>/vocals", ...}}
  {"type": "error",    "error": "..."}

``done`` and ``error`` are terminal and mutually exclusive.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from api.dependencies import require_admin
from core.config import STEMS_DIR, stem_file_path, stem_job_dir

logger = logging.getLogger("omnivoice.api")
router = APIRouter(dependencies=[Depends(require_admin)])

#: Bound each allocation while persisting the upload. Lossless album tracks run
#: to hundreds of megabytes and ``await UploadFile.read()`` with no size would
#: mirror the whole file in process memory first. Same reasoning as batch.py.
_UPLOAD_CHUNK_BYTES = 1024 * 1024

#: Accepted container extensions. demucs reads whatever ffmpeg can decode, but
#: an unbounded extension is a path-shaped value from the request; pinning the
#: set keeps the saved filename predictable.
_AUDIO_EXTS = {".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".aiff", ".aif"}


def _svc():
    # Late import so a missing torch/demucs surfaces as a 500 with detail on the
    # first separation rather than an app-boot failure.
    from services import stem_split

    return stem_split


def _event(event_type: str, **fields) -> str:
    """One SSE ``data:`` line, matching dub_pipeline.prep_event's shape."""
    return f"data: {json.dumps({'type': event_type, **fields})}\n\n"


async def _save_upload(upload: UploadFile, destination: str) -> None:
    try:
        with open(destination, "wb") as output:
            while chunk := await upload.read(_UPLOAD_CHUNK_BYTES):
                output.write(chunk)
    except BaseException:
        try:
            if os.path.exists(destination):
                os.unlink(destination)
        except OSError:
            logger.warning("Could not remove incomplete stem upload", exc_info=True)
        raise


@router.post("/stems/separate")
async def stems_separate(
    file: UploadFile = File(...),
    request: Request = None,
):
    """Separate an uploaded track into six stems, streaming progress as SSE.

    The upload is persisted before the stream opens, so a failure to write the
    file is a plain HTTP error the client can retry, rather than an error event
    inside a 200 response that a naive consumer would treat as success.
    """
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _AUDIO_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio type {ext or '(none)'}; expected one of "
            f"{', '.join(sorted(_AUDIO_EXTS))}",
        )

    job_id = uuid.uuid4().hex[:16]
    job_dir = stem_job_dir(job_id)
    os.makedirs(job_dir, exist_ok=True)
    source = os.path.join(job_dir, f"source{ext}")

    try:
        await _save_upload(file, source)
    except Exception as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        logger.warning("Stem upload failed for job %s: %s", job_id, e)
        raise HTTPException(status_code=500, detail=f"Could not store upload: {e}") from e

    svc = _svc()

    async def stream():
        yield _event("start", job_id=job_id, stems=list(svc.SIX_STEMS))

        # separate_six_stems reports progress by callback; the generator needs
        # it as yielded events. A queue bridges the two without the callback
        # having to know it is feeding an SSE stream.
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def on_progress(pct: int) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, pct)

        task = asyncio.create_task(
            svc.separate_six_stems(job_id, source, job_dir, on_progress=on_progress)
        )

        try:
            while True:
                drain = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait(
                    {drain, task}, return_when=asyncio.FIRST_COMPLETED
                )
                if drain in done:
                    yield _event("progress", percent=drain.result())
                    continue
                drain.cancel()
                # The separation finished; flush any percents still queued so the
                # bar reaches its final value before `done`.
                while not queue.empty():
                    yield _event("progress", percent=queue.get_nowait())
                break

            stems = await task
        except asyncio.CancelledError:
            task.cancel()
            raise
        except Exception as e:
            logger.warning("Stem separation failed for job %s: %s", job_id, e)
            yield _event("error", error=str(e))
            return

        yield _event(
            "done",
            job_id=job_id,
            stems={name: f"/stems/{job_id}/{name}" for name in stems},
        )

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/stems/{job_id}")
def stems_manifest(job_id: str):
    """What a finished job has on disk. 404 when the job is unknown."""
    try:
        job_dir = stem_job_dir(job_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not os.path.isdir(job_dir):
        raise HTTPException(status_code=404, detail=f"No stem job {job_id}")

    svc = _svc()
    present = {}
    for name in svc.SIX_STEMS:
        path = os.path.join(job_dir, f"{name}.wav")
        if os.path.exists(path):
            present[name] = {
                "url": f"/stems/{job_id}/{name}",
                "bytes": os.path.getsize(path),
            }
    return {"job_id": job_id, "complete": len(present) == len(svc.SIX_STEMS), "stems": present}


@router.get("/stems/{job_id}/{stem_name}")
def stems_download(job_id: str, stem_name: str):
    """Serve one stem WAV.

    Restricted to the six known stem names rather than anything that resolves
    inside the job directory. The uploaded ``source.<ext>`` also lives there,
    and a route documented as serving stems should not hand back the original
    track because the caller guessed its name.
    """
    if stem_name not in _svc().SIX_STEMS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown stem {stem_name!r}; expected one of {', '.join(_svc().SIX_STEMS)}",
        )
    try:
        path = stem_file_path(job_id, stem_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"No stem {stem_name} for job {job_id}")
    return FileResponse(path, media_type="audio/wav")


@router.delete("/stems/{job_id}")
def stems_delete(job_id: str):
    """Drop a job's audio. Separations are large; this is how a UI reclaims disk."""
    try:
        job_dir = stem_job_dir(job_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not os.path.isdir(job_dir):
        raise HTTPException(status_code=404, detail=f"No stem job {job_id}")
    # Never let a traversal-shaped id delete outside the stems root.
    if os.path.realpath(job_dir) == os.path.realpath(STEMS_DIR):
        raise HTTPException(status_code=400, detail="Refusing to delete the stems root")
    shutil.rmtree(job_dir, ignore_errors=True)
    return {"deleted": job_id}
