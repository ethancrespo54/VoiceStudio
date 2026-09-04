"""Six-stem separation endpoints.

Two things here are security-shaped rather than feature-shaped, and both are
pinned: ``job_id`` and ``stem_name`` are request-supplied and land in a
filesystem path, so a traversal attempt must be contained rather than served;
and the delete route must never be able to reach the stems root.

The rest pins the SSE contract the frontend consumes — a ``type`` on every
event, progress percents in order, and ``done``/``error`` terminal and mutually
exclusive — because a stream that 200s and then errors inside the body is easy
to consume as success by accident.

Runs without demucs or torch: the separation service is stubbed.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from api.dependencies import require_admin  # noqa: E402
from api.routers import stems as stems_router  # noqa: E402
from services.stem_split import SIX_STEMS, StemSeparationError  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    """App with only the stems router, auth stubbed, data dir redirected."""
    root = tmp_path / "stem_jobs"
    root.mkdir()

    def fake_job_dir(job_id):
        import re

        safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(job_id))
        base = os.path.realpath(str(root))
        full = os.path.realpath(os.path.join(base, safe))
        if full != base and not full.startswith(base + os.sep):
            raise ValueError(f"stem job path escapes STEMS_DIR: {job_id!r}")
        return full

    def fake_file_path(job_id, stem_name):
        import re

        safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(stem_name))
        base = os.path.realpath(fake_job_dir(job_id))
        full = os.path.realpath(os.path.join(base, f"{safe}.wav"))
        if not full.startswith(base + os.sep):
            raise ValueError("stem file path escapes its job dir")
        return full

    monkeypatch.setattr(stems_router, "stem_job_dir", fake_job_dir)
    monkeypatch.setattr(stems_router, "stem_file_path", fake_file_path)
    monkeypatch.setattr(stems_router, "STEMS_DIR", str(root))

    app = FastAPI()
    app.include_router(stems_router.router)
    app.dependency_overrides[require_admin] = lambda: None
    c = TestClient(app)
    c.stem_root = root
    return c


class _FakeService:
    """Stands in for services.stem_split without demucs installed."""

    SIX_STEMS = SIX_STEMS

    def __init__(self, percents=(10, 60, 100), fail=None):
        self.percents, self.fail = percents, fail

    async def separate_six_stems(self, job_id, src, out_dir, *, on_progress=None, **kw):
        for p in self.percents:
            if on_progress:
                on_progress(p)
        if self.fail:
            raise self.fail
        produced = {}
        for name in SIX_STEMS:
            path = os.path.join(out_dir, f"{name}.wav")
            with open(path, "wb") as fh:
                fh.write(b"RIFF____WAVE")
            produced[name] = path
        return produced


def _events(response):
    """Parse an SSE body into a list of dicts."""
    out = []
    for line in response.text.splitlines():
        if line.startswith("data: "):
            out.append(json.loads(line[6:]))
    return out


def _upload(name="song.wav", data=b"RIFF____WAVE"):
    return {"file": (name, data, "audio/wav")}


# ------------------------------------------------------------------- SSE shape

def test_separate_streams_start_progress_done(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    r = client.post("/stems/separate", files=_upload())
    assert r.status_code == 200

    events = _events(r)
    assert events[0]["type"] == "start"
    assert events[0]["stems"] == list(SIX_STEMS)
    assert [e["percent"] for e in events if e["type"] == "progress"] == [10, 60, 100]
    assert events[-1]["type"] == "done"
    assert set(events[-1]["stems"]) == set(SIX_STEMS)


def test_done_urls_point_at_the_download_route(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    events = _events(client.post("/stems/separate", files=_upload()))
    done = events[-1]
    job = done["job_id"]
    assert done["stems"]["guitar"] == f"/stems/{job}/guitar"


def test_every_event_carries_a_type(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    for e in _events(client.post("/stems/separate", files=_upload())):
        assert "type" in e


def test_failure_emits_error_and_no_done(client, monkeypatch):
    monkeypatch.setattr(
        stems_router, "_svc",
        lambda: _FakeService(fail=StemSeparationError("demucs exited 1: CUDA OOM")),
    )
    events = _events(client.post("/stems/separate", files=_upload()))
    assert events[-1]["type"] == "error"
    assert "CUDA OOM" in events[-1]["error"]
    assert not any(e["type"] == "done" for e in events)


def test_partial_stem_failure_is_an_error_not_a_done(client, monkeypatch):
    """Exit 0 with four stems missing must not read as success."""
    monkeypatch.setattr(
        stems_router, "_svc",
        lambda: _FakeService(fail=StemSeparationError("missing: guitar, piano")),
    )
    events = _events(client.post("/stems/separate", files=_upload()))
    assert events[-1]["type"] == "error"
    assert "guitar" in events[-1]["error"]


# ---------------------------------------------------------------- upload guard

@pytest.mark.parametrize("name", ["song.txt", "song.exe", "song", "song.pdf"])
def test_rejects_non_audio_extensions(client, monkeypatch, name):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    r = client.post("/stems/separate", files={"file": (name, b"x", "audio/wav")})
    assert r.status_code == 400
    assert "Unsupported audio type" in r.json()["detail"]


@pytest.mark.parametrize("name", ["song.wav", "song.flac", "song.mp3", "song.m4a"])
def test_accepts_common_audio_extensions(client, monkeypatch, name):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    assert client.post("/stems/separate", files={"file": (name, b"x", "audio/wav")}).status_code == 200


def test_rejected_upload_leaves_no_job_dir(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    client.post("/stems/separate", files={"file": ("song.txt", b"x", "text/plain")})
    assert list(client.stem_root.iterdir()) == []


# -------------------------------------------------------------------- manifest

def test_manifest_reports_a_complete_job(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    job = _events(client.post("/stems/separate", files=_upload()))[-1]["job_id"]

    r = client.get(f"/stems/{job}")
    assert r.status_code == 200
    body = r.json()
    assert body["complete"] is True
    assert set(body["stems"]) == set(SIX_STEMS)
    assert body["stems"]["vocals"]["bytes"] > 0


def test_manifest_marks_an_incomplete_job(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    job = _events(client.post("/stems/separate", files=_upload()))[-1]["job_id"]
    os.unlink(client.stem_root / job / "piano.wav")

    body = client.get(f"/stems/{job}").json()
    assert body["complete"] is False
    assert "piano" not in body["stems"]


def test_manifest_404s_for_unknown_job(client):
    assert client.get("/stems/nosuchjob").status_code == 404


# -------------------------------------------------------------------- download

def test_download_serves_a_stem(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    job = _events(client.post("/stems/separate", files=_upload()))[-1]["job_id"]

    r = client.get(f"/stems/{job}/vocals")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content == b"RIFF____WAVE"


def test_download_404s_for_missing_stem(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    job = _events(client.post("/stems/separate", files=_upload()))[-1]["job_id"]
    assert client.get(f"/stems/{job}/theremin").status_code == 404


# --------------------------------------------------------------- path traversal

@pytest.mark.parametrize("job", ["../../etc", "..%2f..%2fetc", "....//etc"])
def test_traversal_in_job_id_never_escapes(client, job):
    """Sanitised to a flat name, so the worst case is a 404, never a read."""
    r = client.get(f"/stems/{job}")
    assert r.status_code in (400, 404)


@pytest.mark.parametrize("stem", ["../source", "../../../etc/passwd"])
def test_traversal_in_stem_name_never_escapes(client, monkeypatch, stem):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    job = _events(client.post("/stems/separate", files=_upload()))[-1]["job_id"]
    r = client.get(f"/stems/{job}/{stem}")
    assert r.status_code in (400, 404)


def test_stem_name_cannot_reach_the_uploaded_source(client, monkeypatch):
    """`source.wav` sits in the job dir but is not a stem, so it is not served."""
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    job = _events(client.post("/stems/separate", files=_upload()))[-1]["job_id"]
    assert (client.stem_root / job / "source.wav").exists(), "precondition: source is on disk"

    r = client.get(f"/stems/{job}/source")
    assert r.status_code == 404
    assert "Unknown stem" in r.json()["detail"]


def test_download_rejects_any_name_outside_the_six(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    job = _events(client.post("/stems/separate", files=_upload()))[-1]["job_id"]
    for name in ["no_vocals", "source", "manifest", "accompaniment"]:
        assert client.get(f"/stems/{job}/{name}").status_code == 404


# ---------------------------------------------------------------------- delete

def test_delete_removes_the_job(client, monkeypatch):
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    job = _events(client.post("/stems/separate", files=_upload()))[-1]["job_id"]
    assert (client.stem_root / job).exists()

    assert client.delete(f"/stems/{job}").json() == {"deleted": job}
    assert not (client.stem_root / job).exists()


def test_delete_404s_for_unknown_job(client):
    assert client.delete("/stems/nosuchjob").status_code == 404


def test_delete_cannot_reach_the_stems_root(client, monkeypatch):
    """A job id that sanitises to the root must not wipe every separation."""
    monkeypatch.setattr(stems_router, "_svc", lambda: _FakeService())
    _events(client.post("/stems/separate", files=_upload()))
    before = list(client.stem_root.iterdir())

    for evil in [".", "..", "../"]:
        client.delete(f"/stems/{evil}")
    assert list(client.stem_root.iterdir()) == before
