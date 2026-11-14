"""Windowless, self-contained Windows launcher for the Pulse portable folder."""
from __future__ import annotations

import argparse
import atexit
import ctypes
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser


def notify(message: str, error: bool = False, quiet: bool = False) -> None:
    logging.error(message) if error else logging.info(message)
    if quiet:
        return
    if os.name == "nt":
        ctypes.windll.user32.MessageBoxW(None, message, "Pulse — Local Studio", 0x10 if error else 0x40)
    else:
        print(message, file=sys.stderr if error else sys.stdout)


def local_json(url: str, token: str | None = None) -> dict:
    headers = {"X-Pulse-Token": token} if token else {}
    request = urllib.request.Request(url, headers=headers, method="POST" if token else "GET")
    # A system HTTP proxy must never redirect local project data off the machine.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=1.5) as response:
        return json.load(response)


def acquire_workspace_mutex(key: str) -> bool:
    """Atomically permit one live process per data folder, including startup."""
    if os.name != "nt":
        return True
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.restype = ctypes.c_int
    handle = kernel.CreateMutexW(None, False, "Local\\PulseWorkspace-" + key)
    last_error = ctypes.get_last_error()
    if not handle:
        raise ctypes.WinError(last_error)
    if last_error == 183:  # ERROR_ALREADY_EXISTS
        kernel.CloseHandle(handle)
        return False
    # Keeping the kernel handle open retains the named object until this
    # process exits; a crash also releases it without leaving a stale lock.
    atexit.register(kernel.CloseHandle, handle)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Pulse portable local video studio")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--port", type=int)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--stop", action="store_true")
    args = parser.parse_args()
    root = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    data = (args.data_dir or root / "data").resolve()
    runtime = data / "runtime"
    try:
        runtime.mkdir(parents=True, exist_ok=True)
    except OSError:
        notify("Pulse cannot save here. Extract the complete folder to a writable location such as Documents or a USB drive, then open Pulse.exe again.", True, args.no_browser)
        return 1
    logfile = runtime / "pulse.log"
    logging.basicConfig(filename=logfile, encoding="utf-8", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    # PyInstaller windowed mode does not supply stdout/stderr; Uvicorn expects
    # file-like streams even with access logging disabled.
    if sys.stdout is None:
        sys.stdout = logfile.open("a", encoding="utf-8", buffering=1)
    if sys.stderr is None:
        sys.stderr = logfile.open("a", encoding="utf-8", buffering=1)
    os.environ["PULSE_APP_ROOT"] = str(root)
    os.environ["PULSE_DATA_DIR"] = str(data)
    os.environ["PULSE_PORTABLE"] = "1"
    os.environ["PATH"] = str(root / "bin") + os.pathsep + os.environ.get("PATH", "")
    key = hashlib.sha256(str(data).casefold().encode("utf-8")).hexdigest()[:24]
    record_path = runtime / "server.json"
    try:
        record = json.loads(record_path.read_text("utf-8"))
        existing_url = f"http://127.0.0.1:{int(record['port'])}"
        health = local_json(existing_url + "/api/health")
        existing = health.get("workspaceKey") == key and health.get("portable") is True
    except (OSError, ValueError, KeyError, urllib.error.URLError):
        existing = False
    if args.stop:
        if not existing:
            notify("This Pulse folder is already stopped.", quiet=args.no_browser)
            return 0
        try:
            local_json(existing_url + "/api/runtime/stop", record["token"])
            return 0
        except urllib.error.HTTPError as exc:
            try:
                reason = json.loads(exc.read()).get("detail", "Unable to stop Pulse.")
            except ValueError:
                reason = "Unable to stop Pulse. Check data/runtime/pulse.log."
            notify(reason, True, args.no_browser)
            return 1
    if existing:
        if not args.no_browser:
            webbrowser.open(existing_url)
        return 0
    try:
        owns_workspace = acquire_workspace_mutex(key)
    except OSError:
        notify("Pulse could not lock this workspace. Check folder permissions and try again.", True, args.no_browser)
        return 1
    if not owns_workspace:
        # Another double-click can arrive before FastAPI finishes importing.
        # Wait for that instance instead of running two writers on one folder.
        for _ in range(100):
            try:
                record = json.loads(record_path.read_text("utf-8"))
                existing_url = f"http://127.0.0.1:{int(record['port'])}"
                health = local_json(existing_url + "/api/health")
                if health.get("workspaceKey") == key and health.get("portable") is True:
                    if not args.no_browser:
                        webbrowser.open(existing_url)
                    return 0
            except (OSError, ValueError, KeyError, urllib.error.URLError):
                pass
            time.sleep(.15)
        notify("This Pulse workspace is already starting. Wait a few seconds, then open Pulse.exe again. If it does not open, check data/runtime/pulse.log.", True, args.no_browser)
        return 1
    if not (root / "dist" / "index.html").is_file():
        notify("The app folder is incomplete. Extract the whole Pulse folder from the ZIP, including dist and _internal.", True, args.no_browser)
        return 1
    for name in ("ffmpeg.exe", "ffprobe.exe"):
        if getattr(sys, "frozen", False) and not (root / "bin" / name).is_file():
            notify(f"Missing bin/{name}. Extract the whole Pulse portable ZIP again.", True, args.no_browser)
            return 1
    ports = [args.port] if args.port is not None else range(8765, 8786)
    listener = None
    for port in ports:
        if not 1024 <= port <= 65535:
            notify("Choose a port between 1024 and 65535.", True, args.no_browser)
            return 1
        candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if os.name == "nt":
                candidate.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            candidate.bind(("127.0.0.1", port))
            candidate.listen(128)
            listener = candidate
            break
        except OSError:
            candidate.close()
    if listener is None:
        notify("Pulse could not find a free local port. Close the other Pulse copy or restart Windows and try again.", True, args.no_browser)
        return 1
    port = listener.getsockname()[1]
    token = secrets.token_urlsafe(32)
    os.environ["PULSE_RUNTIME_TOKEN"] = token
    try:
        import uvicorn
        from backend.app import app
        config = uvicorn.Config(app, host="127.0.0.1", port=port, loop="asyncio", http="h11",
                                ws="none", access_log=False, log_config=None, lifespan="on")
        server = uvicorn.Server(config)
        app.state.stop_runtime = lambda: setattr(server, "should_exit", True)
        app.state.runtime_port = port
        record_path.write_text(json.dumps({"pid": os.getpid(), "port": port, "workspaceKey": key,
                                           "token": token}, indent=2), "utf-8")
        url = f"http://127.0.0.1:{port}"
        logging.info("Pulse started at %s with data in %s", url, data)

        def open_when_ready() -> None:
            for _ in range(100):
                if server.started:
                    webbrowser.open(url)
                    return
                if server.should_exit:
                    return
                time.sleep(.1)

        if not args.no_browser:
            threading.Thread(target=open_when_ready, daemon=True, name="pulse-browser").start()
        server.run(sockets=[listener])
        return 0
    except Exception:
        logging.exception("Pulse failed to start")
        notify("Pulse could not start. Details are in data/runtime/pulse.log.", True, args.no_browser)
        return 1
    finally:
        listener.close()
        # An existing app copy's record is never removed or modified.
        try:
            if json.loads(record_path.read_text("utf-8")).get("pid") == os.getpid():
                record_path.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass


if __name__ == "__main__":
    from multiprocessing import freeze_support
    freeze_support()
    raise SystemExit(main())
