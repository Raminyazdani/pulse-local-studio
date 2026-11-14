"""Standalone update helper. This module intentionally imports only Python stdlib.

The helper runs from data/updates/<transaction>, outside the runtime being
replaced. Only application-owned paths can enter the transaction; user media,
projects, exports and unrelated files never enter its replacement set.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.request
import uuid
import zipfile

APP_DIRS = {"_internal", "bin", "dist", "licenses"}
APP_FILES = {name.casefold(): name for name in (
    "Pulse.exe", "build-info.json", "Start Pulse.cmd", "Stop Pulse.cmd",
    "Developer README.md", "README.md", "راهنمای اجرا.txt", "THIRD-PARTY.txt")}
RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
            *(f"lpt{i}" for i in range(1, 10))}
MAX_UNPACKED = 4 * 1024**3
CREATE_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def version_tuple(value: str) -> tuple[int, int, int]:
    if not isinstance(value, str) or not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", value):
        raise ValueError("Updates require a stable major.minor.patch version.")
    return tuple(map(int, value.split(".")))


def safe_member(name: str, is_directory: bool = False) -> str:
    if not name or "\\" in name or "\x00" in name or name.startswith("/"):
        raise ValueError("Unsafe path in update archive.")
    parts = name.rstrip("/").split("/")
    if any(not part or part in {".", ".."} or part[-1] in {" ", "."} or
           any(character in part for character in '<>:"|?*') or
           part.split(".")[0].casefold() in RESERVED for part in parts):
        raise ValueError("Unsafe Windows filename in update archive.")
    first = parts[0].casefold()
    if len(parts) == 1 and first in APP_FILES and not is_directory:
        return APP_FILES[first]
    if first in APP_DIRS and (len(parts) > 1 or is_directory):
        parts[0] = first
        return "/".join(parts)
    raise ValueError("Update archive contains a path outside the application runtime.")


def validate_archive(path: Path) -> list[tuple[str, str]]:
    """Return original-ZIP-name -> safe application-relative filename pairs."""
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > 20000:
            raise ValueError("Invalid update archive entry count.")
        names = [entry.filename.rstrip("/") for entry in entries if entry.filename.rstrip("/")]
        prefix = all(name.split("/")[0].casefold() == "pulse" for name in names)
        found: dict[str, bool] = {}
        files: list[tuple[str, str]] = []
        unpacked = 0
        for entry in entries:
            # ZipInfo normalizes Windows backslashes and truncates NULs while
            # reading. Validate the original wire name before that normalization.
            if getattr(entry, "orig_filename", entry.filename) != entry.filename:
                raise ValueError("Unsafe path in update archive.")
            name = entry.filename
            if prefix:
                if "/" not in name.rstrip("/"):
                    if entry.is_dir():
                        continue
                    raise ValueError("Update archive has an invalid root folder.")
                name = name.split("/", 1)[1]
            if entry.flag_bits & 1 or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("Encrypted files and symbolic links are not allowed in updates.")
            safe = safe_member(name, entry.is_dir())
            folded = safe.casefold()
            if folded in found:
                raise ValueError("Duplicate or case-colliding update archive paths.")
            for ancestor in PurePosixPath(folded).parents:
                if str(ancestor) != "." and found.get(str(ancestor)) is False:
                    raise ValueError("Update file collides with an archive directory.")
            if not entry.is_dir() and any(key.startswith(folded + "/") for key in found):
                raise ValueError("Update file collides with an archive directory.")
            found[folded] = entry.is_dir()
            unpacked += entry.file_size
            if entry.file_size < 0 or unpacked > MAX_UNPACKED:
                raise ValueError("The update archive exceeds the safe extracted size limit.")
            if not entry.is_dir():
                files.append((entry.filename, safe))
        paths = {safe.casefold() for _, safe in files}
        required = {"pulse.exe", "dist/index.html", "bin/ffmpeg.exe", "bin/ffprobe.exe", "bin/pulseupdater.exe"}
        if not required.issubset(paths) or not any(path.startswith("_internal/") for path in paths):
            raise ValueError("Update archive is incomplete.")
        return files


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def checked_target(root: Path, relative: str) -> Path:
    safe = safe_member(relative, relative.casefold() in APP_DIRS)
    target = root.joinpath(*safe.split("/"))
    if not target.resolve().is_relative_to(root):
        raise ValueError("Application path escapes the installation folder.")
    cursor = target
    while cursor != root:
        if cursor.is_symlink() or getattr(cursor, "is_junction", lambda: False)():
            raise ValueError("Update targets cannot be links or junctions.")
        cursor = cursor.parent
    return target


def move_path(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(50):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt == 49:
                raise
            time.sleep(.1)


def wait_for_parent(pid: int, expected_executable: Path, timeout: float = 90) -> None:
    if pid <= 0:
        raise ValueError("Invalid parent process.")
    if os.name != "nt":
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(.1)
        raise RuntimeError("Pulse did not stop. No application files were replaced.")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
    handle = kernel.OpenProcess(0x00100000 | 0x1000, False, pid)
    if not handle:
        if ctypes.get_last_error() == 87:  # Process already exited.
            return
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        length = ctypes.c_ulong(len(buffer))
        if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(length)):
            raise ctypes.WinError(ctypes.get_last_error())
        if Path(buffer.value).resolve() != expected_executable.resolve():
            raise ValueError("Update parent does not belong to this Pulse installation.")
        if kernel.WaitForSingleObject(handle, int(timeout * 1000)) != 0:
            raise RuntimeError("Pulse did not stop. No application files were replaced.")
    finally:
        kernel.CloseHandle(handle)


def launch_app(root: Path, data: Path, port: int):
    return subprocess.Popen([str(root / "Pulse.exe"), "--no-browser", "--port", str(port), "--data-dir", str(data)],
                            cwd=root, creationflags=CREATE_FLAGS)


def wait_ready(process, data: Path, port: int, version: str, timeout: float = 45) -> bool:
    key = hashlib.sha256(str(data).casefold().encode("utf-8")).hexdigest()[:24]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=1) as response:
                health = json.load(response)
            if health.get("portable") is True and health.get("workspaceKey") == key and health.get("version") == version and health.get("ok"):
                return True
        except (OSError, ValueError):
            pass
        if process.poll() not in (None, 0):
            return False
        time.sleep(.2)
    return False


def terminate_process(process) -> None:
    if process is not None and process.poll() is None:
        process.terminate()
        process.wait(timeout=15)


def apply_plan(plan_path: Path, *, wait_parent: bool = True) -> dict:
    """Validate again, replace app-owned units and roll back if the new app fails."""
    plan_path = plan_path.resolve()
    plan = json.loads(plan_path.read_text("utf-8"))
    root, data = Path(plan["appRoot"]).resolve(), Path(plan["dataDir"]).resolve()
    stage = plan_path.parent
    if (plan.get("schema") != 1 or stage.parent != data / "updates" or
            str(uuid.UUID(stage.name)) != stage.name or plan_path.name != "plan.json"):
        raise ValueError("Update plan is outside its staging directory.")
    if not (root / "Pulse.exe").is_file() or not (root / "build-info.json").is_file():
        raise ValueError("Update target is not a complete portable Pulse installation.")
    version_tuple(plan["version"])
    if version_tuple(plan["version"]) <= version_tuple(plan["currentVersion"]):
        raise ValueError("Refusing to install an older or equal application version.")
    port = plan["port"]
    if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("Invalid update restart port.")
    archive = stage / "package.zip"
    if sha256_file(archive) != plan["sha256"] or archive.stat().st_size != plan["size"]:
        raise ValueError("Downloaded update checksum or size did not match its release manifest.")
    files = validate_archive(archive)
    units = sorted({relative.split("/")[0] for _, relative in files}, key=lambda value: value.casefold())
    for unit in units:
        target = checked_target(root, unit)
        if target == data or data.is_relative_to(target):
            raise ValueError("Application runtime overlaps the user data folder.")
    # Normally data/updates is on the application's volume. An external --data-dir
    # needs a same-volume transaction directory for atomic directory replacement.
    work = stage if stage.drive.casefold() == root.drive.casefold() else root / (".pulse-update-" + stage.name)
    if work != stage and (not work.resolve().is_relative_to(root) or work.exists()):
        raise ValueError("Unsafe or already existing update transaction directory.")
    work.mkdir(parents=True, exist_ok=True)
    unpacked, backup, failed = work / "new", work / "backup", work / "failed"
    if unpacked.exists() or backup.exists() or failed.exists():
        raise ValueError("This update transaction has already been applied.")
    unpacked.mkdir()
    with zipfile.ZipFile(archive) as package:
        for original, relative in files:
            target = unpacked.joinpath(*relative.split("/"))
            if not target.resolve().is_relative_to(unpacked.resolve()):
                raise ValueError("Extraction path escaped the update stage.")
            target.parent.mkdir(parents=True, exist_ok=True)
            with package.open(original) as source, target.open("xb") as destination:
                shutil.copyfileobj(source, destination, length=1024 * 1024)
    # The running app stays open until this handshake: bootloader, plan, hash,
    # archive and complete extraction have all succeeded before it shuts down.
    if (stage / "cancelled.json").exists():
        raise RuntimeError("The update was cancelled before application replacement.")
    write_json(stage / "helper-ready.json", {"ready": True, "version": plan["version"], "sha256": plan["sha256"]})
    if wait_parent:
        wait_for_parent(int(plan["parentPid"]), root / "Pulse.exe")
    if (stage / "cancelled.json").exists():
        raise RuntimeError("The update was cancelled before application replacement.")
    receipt = {"transactionId": stage.name, "version": plan["version"],
               "previousVersion": plan["currentVersion"], "timestamp": time.time(), "backupPath": str(backup)}
    ledger: list[tuple[str, bool]] = []
    process = None
    try:
        for unit in units:
            target = checked_target(root, unit)
            existed = target.exists()
            ledger.append((unit, existed))
            if existed:
                move_path(target, backup / unit)
            move_path(unpacked / unit, target)
        process = launch_app(root, data, port)
        if not wait_ready(process, data, port, plan["version"]):
            raise RuntimeError("The new version did not become ready.")
        receipt.update(status="complete", message=f"Updated to {plan['version']}. Your projects and media were preserved.")
    except Exception as exc:
        logging.exception("Update failed; restoring previous application runtime")
        terminate_process(process)
        rollback_errors = []
        for unit, existed in reversed(ledger):
            target = checked_target(root, unit)
            try:
                if (backup / unit).exists() or not existed:
                    if target.exists():
                        move_path(target, failed / unit)
                    if existed:
                        move_path(backup / unit, target)
            except Exception as rollback_error:
                rollback_errors.append(str(rollback_error))
        if rollback_errors:
            receipt.update(status="error", message="Update and automatic restore failed. The previous runtime backup is retained.", error=str(exc), rollbackErrors=rollback_errors)
        else:
            try:
                process = launch_app(root, data, port)
                recovered = wait_ready(process, data, port, plan["currentVersion"])
                receipt.update(status="rolled-back", message="Update failed; the previous version was restored. Your projects and media were preserved.", error=str(exc), restarted=recovered)
            except Exception as restart_error:
                receipt.update(status="rolled-back", message="The previous version was restored. Open Pulse.exe again.", error=f"{exc}; {restart_error}", restarted=False)
    write_json(data / "updates" / "last-result.json", receipt)
    write_json(stage / "result.json", receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description="Pulse portable update helper")
    parser.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(filename=args.plan.resolve().parent / "updater.log", level=logging.INFO,
                        encoding="utf-8", format="%(asctime)s %(levelname)s %(message)s")
    try:
        result = apply_plan(args.plan)
        return 0 if result["status"] == "complete" else 1
    except Exception:
        logging.exception("Pulse update could not start; no unverified package was installed")
        # Validation/wait failures happen before any runtime replacement. Put a
        # local receipt where the original application can report the reason.
        try:
            plan = json.loads(args.plan.read_text("utf-8"))
            stage = args.plan.resolve().parent
            data = Path(plan["dataDir"]).resolve()
            if stage.parent == data / "updates" and str(uuid.UUID(stage.name)) == stage.name:
                write_json(data / "updates" / "last-result.json", {"status": "error", "transactionId": stage.name,
                    "version": plan.get("version"), "timestamp": time.time(), "message": "Update could not start. The installed application and user data were not changed. See the update log."})
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
