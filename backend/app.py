from __future__ import annotations

import asyncio
import mimetypes
import hashlib
import os
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .media import DATA, MEDIA, ROOT, SourceSignalConflict, analyze_media, get_media, import_media, list_media, media_directory, original_path, public_media, safe_remove_import, save_video_signals, video_signal_media
from .render import JOBS, get_job, start_export
from .projects import list_projects, load_project, load_active_project, save_project, set_active_project
from .version import VERSION
from .updates import update_status, start_check, start_install, is_installing

app = FastAPI(title="Pulse local media engine", version=VERSION, docs_url="/api/docs")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173",
                                               "http://localhost:8765", "http://127.0.0.1:8765"],
                   allow_methods=["GET", "POST", "PUT"], allow_headers=["Content-Type"])
app.state.active_media_operations = 0
MEDIA_UPDATE_ADMISSION = threading.RLock()


@app.middleware("http")
async def protect_update_operations(request: Request, call_next):
    path = request.url.path
    media_operation = ((request.method == "POST" and (path in {"/api/media", "/api/export"} or path.startswith("/api/analyze/"))) or
                       (request.method == "PUT" and path.startswith("/api/media/") and path.endswith("/signals")))
    if not media_operation:
        return await call_next(request)
    with MEDIA_UPDATE_ADMISSION:
        if is_installing():
            return JSONResponse({"detail": "Pulse is updating. Wait for the update to finish."}, status_code=409)
        app.state.active_media_operations += 1
    try:
        return await call_next(request)
    finally:
        with MEDIA_UPDATE_ADMISSION:
            app.state.active_media_operations -= 1


def require_local_update_request(request: Request) -> None:
    from urllib.parse import urlsplit
    if request.url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(403, "Updates are available only from the local Pulse editor.")
    origin = request.headers.get("origin")
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme != "http" or parsed.netloc.casefold() != request.url.netloc.casefold():
            raise HTTPException(403, "Open the local Pulse editor to request an update.")
    if request.headers.get("content-type", "").split(";", 1)[0].strip().casefold() != "application/json":
        raise HTTPException(415, "Send update actions as application/json.")


@app.get("/api/updates")
def updates_state():
    return update_status()


@app.post("/api/updates/check")
def check_updates(request: Request):
    require_local_update_request(request)
    try:
        return start_check()
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.post("/api/updates/install")
def install_update(request: Request):
    require_local_update_request(request)
    # Checking idle state and claiming the updater must be one admission
    # operation: a second browser may submit an import at the same moment.
    with MEDIA_UPDATE_ADMISSION:
        if app.state.active_media_operations or any(job.get("status") in {"queued", "rendering"} for job in JOBS.values()):
            raise HTTPException(409, "Wait for imports, audio analysis and film exports to finish before updating.")
        stop = getattr(app.state, "stop_runtime", None)
        if not stop:
            raise HTTPException(409, "Run the portable edition to install an update.")
        try:
            return start_install(stop, getattr(app.state, "runtime_port", request.url.port or 8765))
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(409, str(exc))


class AnalysisRequest(BaseModel):
    sensitivity: float = Field(default=1, ge=.2, le=4)
    minInterval: float = Field(default=.2, ge=.05, le=2)


class ExportRequest(BaseModel):
    project: dict
    settings: dict = Field(default_factory=dict)


@app.get("/api/health")
def health():
    return {"ok": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")), "engine": "FFmpeg",
            "version": VERSION, "storage": "local", "ffmpeg": bool(shutil.which("ffmpeg")),
            "portable": os.environ.get("PULSE_PORTABLE") == "1",
            "workspaceKey": hashlib.sha256(str(DATA).casefold().encode("utf-8")).hexdigest()[:24]}


@app.post("/api/runtime/stop")
def stop_runtime(request: Request):
    import secrets
    expected = os.environ.get("PULSE_RUNTIME_TOKEN")
    supplied = request.headers.get("x-pulse-token", "")
    if not expected or not secrets.compare_digest(expected, supplied):
        raise HTTPException(403, "This stop request does not belong to this Pulse instance.")
    if any(job.get("status") in {"queued", "rendering"} for job in JOBS.values()):
        raise HTTPException(409, "A film is still rendering. Wait for export to finish, then stop Pulse.")
    callback = getattr(app.state, "stop_runtime", None)
    if not callback:
        raise HTTPException(409, "Use this installation's stop launcher.")
    callback()
    return {"stopping": True}


@app.get("/api/media")
def media_list():
    return {"media": [public_media(item) for item in list_media()]}


@app.get("/api/media/{media_id}/signals")
def source_signal_file(media_id: str):
    try:
        media = video_signal_media(media_id)
        return {"media": public_media(media), "signals": media.get("sourceSignals", [])}
    except FileNotFoundError:
        raise HTTPException(404, "Video media not found.")
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc))


@app.put("/api/media/{media_id}/signals")
async def source_signal_save(media_id: str, request: Request):
    try:
        import json
        content = await request.body()
        if len(content) > 4 * 1024 * 1024:
            raise HTTPException(413, "Video source labels exceed the 4 MB request limit.")
        payload = json.loads(content)
        if not isinstance(payload, dict) or "signals" not in payload or set(payload) - {"signals", "expectedSignals"}:
            raise ValueError("Send a signals array and optional expectedSignals baseline.")
        if "expectedSignals" in payload and payload["expectedSignals"] is None:
            raise ValueError("expectedSignals must be an array when provided.")
        media = await asyncio.to_thread(save_video_signals, media_id, payload["signals"], payload.get("expectedSignals"))
        return {"media": media}
    except FileNotFoundError:
        raise HTTPException(404, "Video media not found.")
    except SourceSignalConflict as exc:
        raise HTTPException(409, str(exc))
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(400, str(exc))
    except OSError as exc:
        raise HTTPException(507, "Cannot save the video labels. Check free space and folder permissions.") from exc


@app.get("/api/projects")
def project_list():
    return list_projects()


@app.get("/api/projects/active")
def active_project():
    try:
        return {"project": load_active_project()}
    except (ValueError, OSError) as exc:
        raise HTTPException(409, str(exc))


@app.get("/api/projects/{project_id}")
def project_file(project_id: str):
    try:
        return {"project": load_project(project_id)}
    except FileNotFoundError:
        raise HTTPException(404, "Project not found.")
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.put("/api/projects/{project_id}")
async def project_save(project_id: str, request: Request):
    try:
        content = await request.body()
        if len(content) > 50 * 1024 * 1024:
            raise HTTPException(413, "This project file exceeds the 50 MB limit.")
        import json
        project = json.loads(content)
        return await asyncio.to_thread(save_project, project_id, project)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(400, str(exc))
    except OSError as exc:
        raise HTTPException(507, "Cannot save the project folder. Check available disk space and folder permissions.") from exc


@app.post("/api/projects/active")
async def choose_project(request: Request):
    try:
        payload = await request.json()
        return set_active_project(payload["id"])
    except FileNotFoundError:
        raise HTTPException(404, "Project not found.")
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(400, str(exc))


def store_upload(file: UploadFile) -> dict:
    media_id = str(uuid.uuid4())
    directory = MEDIA / media_id
    directory.mkdir()
    name = Path(file.filename or "Untitled media").name
    extension = Path(name).suffix.lower()
    if len(extension) > 12 or not all(character.isalnum() or character == "." for character in extension):
        extension = ".bin"
    destination = directory / f"original{extension}"
    try:
        with destination.open("wb") as output:
            shutil.copyfileobj(file.file, output, length=1024*1024)
        return import_media(destination, name, media_id)
    except Exception:
        safe_remove_import(directory)
        raise


@app.post("/api/media")
async def upload_media(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(400, "Choose at least one media file.")
    imported, errors = [], []
    for file in files:
        try:
            imported.append(await asyncio.to_thread(store_upload, file))
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            detail = str(exc)
            if isinstance(exc, subprocess.CalledProcessError):
                detail = (exc.stderr or b"").decode("utf-8", errors="replace")[-600:] or "Unsupported or damaged media."
            errors.append({"name": file.filename, "error": detail})
        finally:
            await file.close()
    if not imported:
        raise HTTPException(400, errors[0]["error"] if errors else "No media was imported.")
    return {"media": imported, "errors": errors}


@app.get("/api/files/{media_id}/{variant}")
def media_file(media_id: str, variant: str):
    try:
        media = get_media(media_id)
        directory = media_directory(media_id)
        if variant == "original":
            path = original_path(media_id)
        elif variant == "proxy":
            path = directory / media["_proxy"]
        elif variant == "thumbnail":
            path = directory / "thumbnail.jpg"
        else:
            raise FileNotFoundError()
        if not path.is_file():
            raise FileNotFoundError()
    except (FileNotFoundError, KeyError):
        raise HTTPException(404, "Media file not found.")
    return FileResponse(path, media_type=mimetypes.guess_type(path)[0] or "application/octet-stream",
                        headers={"Cache-Control": "private, max-age=31536000, immutable"})


@app.post("/api/analyze/{media_id}")
async def analyze(media_id: str, parameters: AnalysisRequest):
    try:
        return await asyncio.to_thread(analyze_media, media_id, parameters.sensitivity, parameters.minInterval)
    except FileNotFoundError:
        raise HTTPException(404, "Media not found.")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except subprocess.SubprocessError:
        raise HTTPException(400, "FFmpeg could not decode the audio in this file.")


@app.post("/api/export")
def export(request: ExportRequest):
    try:
        return {"id": start_export(request.project, request.settings)}
    except FileNotFoundError:
        raise HTTPException(400, "A project source is missing. Re-import it before exporting.")
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        raise HTTPException(400, str(exc))


@app.get("/api/export/{job_id}")
def export_status(job_id: str):
    try:
        return {key: value for key, value in get_job(job_id).items() if not key.startswith("_")}
    except FileNotFoundError:
        raise HTTPException(404, "Export not found.")


@app.get("/api/export/{job_id}/download")
def export_download(job_id: str):
    try:
        job = get_job(job_id)
    except FileNotFoundError:
        raise HTTPException(404, "Export not found.")
    if job["status"] != "complete":
        raise HTTPException(409, "The export is not ready yet.")
    # Older exports recorded an absolute workstation path. A portable copy
    # resolves the output inside its own export directory after relocation.
    path = DATA / "exports" / job_id / Path(job["_path"]).name
    if not path.is_file():
        raise HTTPException(404, "Export file is missing.")
    return FileResponse(path, filename=path.name, media_type="video/quicktime" if path.suffix == ".mov" else "video/mp4")


@app.get("/{path:path}")
def frontend(path: str):
    if path.startswith("api/"):
        raise HTTPException(404, "API endpoint not found.")
    dist = (ROOT / "dist").resolve()
    target = (dist / path).resolve()
    if target.is_relative_to(dist) and target.is_file():
        return FileResponse(target)
    if (dist / "index.html").is_file():
        return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})
    return JSONResponse({"message": "Build the frontend with npm run build, then open this address again.",
                         "api": "/api/docs"}, status_code=503)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
