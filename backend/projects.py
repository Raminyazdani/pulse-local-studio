"""Atomic, folder-relative project storage for the local and portable editor.

Project files contain the edit graph and relative media URLs. Actual source files
remain in the sibling media directory and are never moved by this module.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from .media import DATA

PROJECTS = DATA / "projects"
LOCK = threading.RLock()
LOGGER = logging.getLogger("pulse.projects")
ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
                  *(f"LPT{i}" for i in range(1, 10))}
TOLERANCE = 1e-5


def checked_id(value: object) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value) or value.upper() in RESERVED_NAMES:
        raise ValueError("Project ID must contain 1–128 letters, numbers, underscores or hyphens.")
    return value


def _object(value, label: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object.")
    return value


def _array(value, label: str) -> list:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array.")
    return value


def _string(value, label: str, nonempty: bool = False) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ValueError(f"{label} must be a {'nonempty ' if nonempty else ''}string.")
    return value


def _number(value, label: str, minimum: float = 0, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number.")
    try:
        valid = math.isfinite(value) and value >= minimum and (not positive or value > 0)
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError(f"{label} must be a finite {'positive' if positive else 'nonnegative'} number.")
    return value


def _flag(data: dict, key: str, label: str) -> None:
    if key in data and not isinstance(data[key], bool):
        raise ValueError(f"{label} must be true or false.")


def _json_values(value, depth: int = 0) -> None:
    """Reject non-JSON/non-finite unknown fields while retaining valid metadata."""
    if depth > 64:
        raise ValueError("Project data is nested too deeply.")
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("Project object keys must be strings.")
            _json_values(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _json_values(item, depth + 1)
    elif value is None or isinstance(value, (str, bool)):
        return
    elif isinstance(value, (int, float)):
        try:
            valid = math.isfinite(value)
        except OverflowError:
            valid = False
        if not valid:
            raise ValueError("Project data must contain finite numbers.")
    else:
        raise ValueError("Project data must be JSON serializable.")


def _times(values, label: str, maximum: float) -> None:
    for value in _array(values, label):
        if _number(value, label) > maximum + TOLERANCE:
            raise ValueError(f"{label} contains a time outside its source.")


def _media_url(value, media_id: str, label: str) -> None:
    parsed = urlsplit(_string(value, label, True))
    if (parsed.scheme or parsed.netloc or parsed.fragment or
            parsed.path not in {f"/api/files/{media_id}/{variant}" for variant in ("proxy", "original", "thumbnail")}):
        raise ValueError(f"{label} must reference this workspace's relative media API.")


def _beat_config(value) -> None:
    data = _object(value, "Beat configuration")
    every = _number(data.get("every", 1), "Beat interval", 1)
    offset = _number(data.get("offset", 0), "Beat offset")
    if int(every) != every or int(offset) != offset or offset >= every:
        raise ValueError("Beat interval and offset must be integers, with offset smaller than interval.")
    pattern = data.get("pattern", "")
    if pattern == "":
        return
    if isinstance(pattern, str):
        pattern = list(re.sub(r"[\s,;|]+", "", pattern))
        if not pattern or any(item not in ("0", "1") for item in pattern) or "1" not in pattern:
            raise ValueError("Beat pattern needs 0/1 entries and at least one kept beat.")
    elif isinstance(pattern, list):
        if not pattern or any(type(item) is not int or item not in (0, 1) for item in pattern) or 1 not in pattern:
            raise ValueError("Beat pattern needs 0/1 entries and at least one kept beat.")
    else:
        raise ValueError("Beat pattern must be a string or an array of 0/1 entries.")


def validate_project(value, expected_id: str | None = None) -> dict:
    """Validate the edit graph without requiring media to be mounted or decoded.

    Unavailable files must not prevent a saved edit from being opened/recovered.
    File presence and codec validation remain the renderer's responsibility.
    """
    data = _object(value, "Project")
    _json_values(data)
    project_id = checked_id(data.get("id"))
    if expected_id is not None and project_id != checked_id(expected_id):
        raise ValueError("Project ID does not match the requested project.")
    _string(data.get("name"), "Project name")
    if "version" in data and (type(data["version"]) is not int or data["version"] != 1):
        raise ValueError("This project version is not supported.")
    if data.get("aspect", "16:9") not in ("16:9", "9:16", "1:1"):
        raise ValueError("Unknown project aspect ratio.")
    media = {}
    for entry in _array(data.get("media"), "Project media"):
        asset = _object(entry, "Media")
        media_id = checked_id(asset.get("id"))
        if media_id in media:
            raise ValueError("Project contains duplicate media IDs.")
        media[media_id] = asset
        _string(asset.get("name"), "Media name")
        if asset.get("kind") not in ("audio", "video", "image"):
            raise ValueError("Unknown media kind.")
        duration = _number(asset.get("duration"), "Media duration")
        _flag(asset, "hasAudio", "Media audio flag")
        if "hasAudio" not in asset:
            raise ValueError("Media must specify whether it has audio.")
        _media_url(asset.get("url"), media_id, "Media URL")
        for key in ("originalUrl", "proxyUrl", "thumbnailUrl"):
            if asset.get(key) is not None:
                _media_url(asset[key], media_id, key)
        for key in ("width", "height", "fps", "size"):
            if key in asset:
                _number(asset[key], f"Media {key}")
        if asset.get("bpm") is not None:
            _number(asset["bpm"], "Media BPM")
        if "beats" in asset:
            _times(asset["beats"], "Detected beats", duration)
        if "waveform" in asset:
            for amplitude in _array(asset["waveform"], "Waveform"):
                _number(amplitude, "Waveform amplitude")
    tracks = {}
    for entry in _array(data.get("tracks"), "Project tracks"):
        track = _object(entry, "Track")
        track_id = checked_id(track.get("id"))
        if track_id in tracks:
            raise ValueError("Project contains duplicate track IDs.")
        tracks[track_id] = track
        _string(track.get("name"), "Track name")
        if track.get("kind") not in ("audio", "video"):
            raise ValueError("Unknown track kind.")
        for key in ("muted", "hidden", "locked"):
            _flag(track, key, f"Track {key}")
    clip_ids = set()
    for entry in _array(data.get("clips"), "Project clips"):
        clip = _object(entry, "Clip")
        clip_id = checked_id(clip.get("id"))
        if clip_id in clip_ids:
            raise ValueError("Project contains duplicate clip IDs.")
        clip_ids.add(clip_id)
        _string(clip.get("name"), "Clip name")
        track_id = checked_id(clip.get("trackId"))
        if track_id not in tracks:
            raise ValueError("A clip references a missing track.")
        start = _number(clip.get("start"), "Clip start")
        segments = _array(clip.get("segments"), "Clip segments")
        if not segments:
            raise ValueError("A clip needs at least one source segment.")
        duration = 0.
        for entry in segments:
            segment = _object(entry, "Source segment")
            media_id = checked_id(segment.get("mediaId"))
            if media_id not in media:
                raise ValueError("A clip references missing media.")
            asset = media[media_id]
            if (tracks[track_id]["kind"] == "audio") != (asset["kind"] == "audio"):
                raise ValueError("A clip is on an incompatible track.")
            source_in = _number(segment.get("in"), "Source in")
            source_out = _number(segment.get("out"), "Source out")
            if source_out <= source_in or (asset["kind"] != "image" and source_out > asset["duration"] + TOLERANCE):
                raise ValueError("A clip has an invalid source range.")
            speed = _number(segment.get("speed", 1), "Source speed", positive=True)
            duration += (source_out - source_in) / speed
            _number(segment.get("volume", 1), "Source volume")
            _flag(segment, "muted", "Source mute")
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("A clip has an invalid source duration.")
        _number(clip.get("volume", 1), "Clip volume")
        _flag(clip, "muted", "Clip mute")
        _times(clip.get("signals"), "Video signals", duration)
        if "beatEdits" in clip:
            _times(clip["beatEdits"], "Manual beats", duration)
        if "beatConfig" in clip:
            _beat_config(clip["beatConfig"])
        output_duration = duration
        if "warp" in clip:
            warp = _array(clip["warp"], "Speed map")
            if warp:
                if len(warp) < 2:
                    raise ValueError("A speed map needs at least two points.")
                previous = None
                for entry in warp:
                    point = _object(entry, "Speed map point")
                    source = _number(point.get("source"), "Speed map source")
                    target = _number(point.get("target"), "Speed map target")
                    if previous is None:
                        if abs(source) > TOLERANCE or abs(target) > TOLERANCE:
                            raise ValueError("A speed map must start at zero.")
                    elif source <= previous[0] or target <= previous[1]:
                        raise ValueError("Speed map points must increase strictly.")
                    previous = source, target
                if abs(previous[0] - duration) > TOLERANCE:
                    raise ValueError("A speed map must cover the full source duration.")
                output_duration = previous[1]
        if not math.isfinite(start + output_duration) or start + output_duration > 86400:
            raise ValueError("Project duration cannot exceed 24 hours.")
    # JSON roundtrip prevents caller mutation after validation and keeps unknown
    # source color/preview metadata intact rather than dropping new fields.
    return json.loads(json.dumps(data, ensure_ascii=False, allow_nan=False))


def _path(name: str) -> Path:
    PROJECTS.mkdir(parents=True, exist_ok=True)
    directory = PROJECTS.resolve()
    result = directory / name
    if result.is_symlink() or not result.resolve().is_relative_to(directory):
        raise ValueError("Project storage path is not inside this workspace.")
    return result


def _project_path(project_id: str) -> Path:
    return _path(f"{checked_id(project_id)}.pulse.json")


def _atomic_bytes(path: Path, content: bytes) -> None:
    temporary = _path(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_json(path: Path, value: dict, backup: bool = True) -> None:
    content = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    if backup and path.is_file():
        try:
            previous = path.read_bytes()
            parsed = json.loads(previous.decode("utf-8-sig"))
            if path.name.endswith(".pulse.json"):
                validate_project(parsed, path.name.removesuffix(".pulse.json"))
            else:
                checked_id(_object(parsed, "Project state").get("activeProjectId"))
            _atomic_bytes(_path(f"{path.name}.bak"), previous)
        except ValueError:
            # A recovered project must not overwrite its last valid backup
            # with the damaged primary file on the next autosave.
            LOGGER.warning("Keeping previous backup of invalid file %s", path.name)
        except OSError:
            LOGGER.warning("Could not update project backup %s", path.name, exc_info=True)
    _atomic_bytes(path, content)


def _load_project(project_id: str) -> tuple[dict, Path]:
    path = _project_path(project_id)
    backup = _path(f"{path.name}.bak")
    errors = []
    for candidate in (path, backup):
        if not candidate.is_file():
            continue
        try:
            value = validate_project(json.loads(candidate.read_text("utf-8-sig")), project_id)
            if candidate == backup:
                LOGGER.warning("Recovered project %s from its previous backup", project_id)
            return value, candidate
        except (ValueError, OSError) as exc:
            errors.append(str(exc))
    if errors:
        raise ValueError(f"Project {project_id} could not be read: {errors[0]}")
    raise FileNotFoundError("Project not found.")


def load_project(project_id: str) -> dict:
    with LOCK:
        return _load_project(project_id)[0]


def _project_summaries() -> list[dict]:
    directory = _path("state.json").parent
    names = {path.name.removesuffix(".bak").removesuffix(".pulse.json")
             for pattern in ("*.pulse.json", "*.pulse.json.bak") for path in directory.glob(pattern)}
    summaries = []
    for project_id in names:
        try:
            value, path = _load_project(project_id)
            summaries.append(dict(id=value["id"], name=value["name"], updated=path.stat().st_mtime))
        except (ValueError, OSError):
            LOGGER.warning("Skipping unreadable project %s", project_id)
    return sorted(summaries, key=lambda item: (-item["updated"], item["id"]))


def _active_id(projects: list[dict]) -> str | None:
    known = {item["id"] for item in projects}
    for filename in ("state.json", "state.json.bak"):
        path = _path(filename)
        try:
            project_id = checked_id(json.loads(path.read_text("utf-8-sig"))["activeProjectId"])
            if project_id in known:
                return project_id
        except (ValueError, OSError, KeyError, TypeError):
            continue
    return projects[0]["id"] if projects else None


def list_projects() -> dict:
    with LOCK:
        projects = _project_summaries()
        return dict(projects=projects, activeProjectId=_active_id(projects))


def load_active_project() -> dict | None:
    with LOCK:
        projects = _project_summaries()
        project_id = _active_id(projects)
        return _load_project(project_id)[0] if project_id else None


def set_active_project(project_id: str) -> dict:
    with LOCK:
        _load_project(project_id)
        _write_json(_path("state.json"), {"activeProjectId": project_id})
        return {"id": project_id}


def save_project(project_id: str, project: dict) -> dict:
    validated = validate_project(project, project_id)
    with LOCK:
        path = _project_path(project_id)
        _write_json(path, validated)
        _write_json(_path("state.json"), {"activeProjectId": project_id})
        return {"id": project_id, "updated": path.stat().st_mtime}
