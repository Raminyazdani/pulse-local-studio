"""Exercise the frozen Windows bundle without installed Python/Node/FFmpeg.

The verification runner itself uses Python and optionally Playwright. The app
process receives a Windows-only PATH. All edits/media are synthetic and live
under a unique test directory; the packaged user library is inspected read-only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CREATE_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def command(program: Path | str, arguments: list[str], *, env: dict | None = None,
            timeout: float = 90) -> bytes:
    result = subprocess.run([str(program), *arguments], capture_output=True, timeout=timeout,
                            creationflags=CREATE_FLAGS, env=env)
    if result.returncode:
        raise AssertionError(f"{program} failed ({result.returncode}): "
                             f"{result.stderr.decode('utf-8', errors='replace')[-4000:]}")
    return result.stdout


def request(base: str, path: str, value=None, method: str | None = None, timeout=60):
    body = json.dumps(value, ensure_ascii=False).encode("utf-8") if value is not None else None
    req = urllib.request.Request(base + path, data=body, method=method,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def upload(base: str, path: Path) -> dict:
    boundary = f"pulse-{uuid.uuid4().hex}"
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; '
            f'filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
    body += path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(base + "/api/media", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=120) as response:
        result = json.load(response)
    if result.get("errors") or len(result.get("media", [])) != 1:
        raise AssertionError(f"Import failed: {result}")
    return result["media"][0]


def port_available(port: int):
    with socket.socket() as sock:
        sock.settimeout(.25)
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            raise AssertionError(f"Test port {port} is occupied; refusing to use another app's server.")


def start(app: Path, port: int, env: dict) -> subprocess.Popen:
    port_available(port)
    process = subprocess.Popen([str(app / "Pulse.exe"), "--no-browser", "--port", str(port)],
                               cwd=app.parent, env=env, creationflags=CREATE_FLAGS)
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            logs = []
            for file in (app / "data").glob("**/*.log"):
                logs.append(f"{file.name}: {file.read_text('utf-8', errors='replace')[-2000:]}")
            raise AssertionError(f"Frozen app exited {process.returncode}: {'; '.join(logs)}")
        try:
            health = request(base, "/api/health", timeout=1)
            if health.get("ok"):
                assert health.get("portable") is True, health
                return process
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(.2)
    process.terminate()
    raise AssertionError("Frozen app failed to become ready within 60 seconds.")


def start_concurrently(app: Path, port: int, env: dict) -> subprocess.Popen:
    """Two simultaneous clicks must leave exactly one server for this folder."""
    port_available(port)
    children = [subprocess.Popen([str(app / "Pulse.exe"), "--no-browser", "--port", str(port)],
                                 cwd=app.parent, env=env, creationflags=CREATE_FLAGS)
                for _ in range(2)]
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 60
    try:
        while time.monotonic() < deadline:
            alive = [process for process in children if process.poll() is None]
            if not alive:
                raise AssertionError(f"Both concurrent launches exited: {[p.returncode for p in children]}")
            health = None
            try:
                health = request(base, "/api/health", timeout=1)
            except (OSError, urllib.error.URLError):
                pass
            if health and health.get("ok") and len(alive) == 1:
                winner = alive[0]
                loser = next(process for process in children if process is not winner)
                assert loser.returncode == 0, f"Repeated launch reported an error: {loser.returncode}"
                assert health.get("portable") is True
                record = json.loads((app / "data" / "runtime" / "server.json").read_text("utf-8"))
                assert record["pid"] == winner.pid, "Runtime record belongs to an orphaned or wrong server."
                return winner
            time.sleep(.15)
        raise AssertionError("Concurrent double launch did not settle to a single running server.")
    except BaseException:
        for child in children:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=15)
        raise


def stop(app: Path, port: int, process: subprocess.Popen | None, env: dict):
    if process is None or process.poll() is not None:
        return
    result = subprocess.run([str(app / "Pulse.exe"), "--stop", "--no-browser", "--port", str(port)],
                            cwd=app.parent, env=env, capture_output=True, timeout=25,
                            creationflags=CREATE_FLAGS)
    if result.returncode:
        process.terminate()
        process.wait(timeout=15)
        raise AssertionError(f"Portable stop failed: {result.stderr.decode(errors='replace')}")
    process.wait(timeout=25)


def create_fixtures(directory: Path, ffmpeg: Path, env: dict) -> list[Path]:
    directory.mkdir(parents=True)
    paths = []
    for color in ("red", "blue"):
        path = directory / f"portable-{color}.mov"
        command(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                         f"color=c={color}:s=320x180:r=30:d=2", "-f", "lavfi", "-i",
                         "sine=frequency=440:sample_rate=48000:duration=2", "-c:v", "libx264",
                         "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", str(path)], env=env)
        paths.append(path)
    path = directory / "portable-kicks.wav"
    rate = 22050
    samples = [0] * (rate * 6)
    for beat in (index / 2 for index in range(1, 12)):
        start = round(beat * rate)
        for index in range(round(rate * .12)):
            t = index / rate
            samples[start + index] = round(.8 * math.sin(2 * math.pi * 70 * t) * math.exp(-35 * t) * 32767)
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, rate, len(samples), "NONE", "not compressed"))
        output.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    paths.append(path)
    return paths


def make_project(media: list[dict]) -> dict:
    red, blue, music = media
    return {
        "id": "project-portable-roundtrip", "version": 1, "name": "پروژه قابل حمل", "aspect": "16:9",
        "media": media,
        "tracks": [
            {"id": "track-video", "name": "Video", "kind": "video", "muted": False, "hidden": False, "locked": False},
            {"id": "track-audio", "name": "Soundtrack", "kind": "audio", "muted": False, "hidden": False, "locked": False},
        ],
        "clips": [
            {"id": "clip-portable-video", "name": "Portable merged sequence", "trackId": "track-video",
             "start": .375, "segments": [{"mediaId": red["id"], "in": 0, "out": 2, "speed": 1},
                                          {"mediaId": blue["id"], "in": 0, "out": 2, "speed": 1}],
             "signals": [.25, 1.25, 3.25], "muted": True, "volume": 1,
             "warp": [{"source": 0, "target": 0}, {"source": .25, "target": .125},
                      {"source": 1.25, "target": .625}, {"source": 3.25, "target": 1.125},
                      {"source": 4, "target": 1.3125}]},
            {"id": "clip-portable-audio", "name": "Portable kick track", "trackId": "track-audio", "start": 0,
             "segments": [{"mediaId": music["id"], "in": 0, "out": 6, "speed": 1}],
             "signals": [], "muted": False, "volume": .7, "beatConfig": {"every": 2, "offset": 0},
             "beatEdits": [.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]},
        ],
    }


def verify_media_files(base: str, media: list[dict]):
    for item in media:
        for key in ("originalUrl", "proxyUrl"):
            req = urllib.request.Request(base + item[key], headers={"Range": "bytes=0-31"})
            with urllib.request.urlopen(req, timeout=15) as response:
                assert response.status == 206, (item["name"], key, response.status)
                assert len(response.read()) == 32


def export_project(base: str, project: dict) -> dict:
    export = request(base, "/api/export", {"project": project, "settings": {
        "width": 320, "height": 180, "fps": 30, "quality": "high", "format": "mp4"}})
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        job = request(base, f"/api/export/{export['id']}")
        if job["status"] == "error":
            raise AssertionError(f"Frozen FFmpeg render failed: {job}")
        if job["status"] == "complete":
            return job
        time.sleep(.25)
    raise AssertionError("Portable export timed out.")


def verify_bundle_library(bundle: Path, expected: int | None) -> int:
    files = list((bundle / "data" / "media").glob("*/metadata.json"))
    if expected is not None:
        assert len(files) == expected, f"Expected {expected} packaged media; found {len(files)}."
    for file in files:
        item = json.loads(file.read_text("utf-8"))
        assert (file.parent / item["_original"]).is_file(), f"Missing original: {item['name']}"
        assert (file.parent / item["_proxy"]).is_file(), f"Missing proxy: {item['name']}"
    return len(files)


def run(args) -> dict:
    bundle = Path(args.bundle).resolve()
    assert (bundle / "Pulse.exe").is_file(), f"Build missing: {bundle / 'Pulse.exe'}"
    bundled_count = verify_bundle_library(bundle, args.expected_media)
    checks = (ROOT / "data" / "portable-checks").resolve()
    check = checks / f"run-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    app = check / "First Pulse Folder"
    moved = check / "Moved Pulse آزمایش"
    for path in (check, app, moved):
        assert path.resolve().is_relative_to(checks), f"Unsafe test destination: {path}"
    check.mkdir(parents=True)
    # No user edits/files enter the mutable test workspace. Runtime files and
    # bundled executables are copied exactly, then the complete test app moves.
    shutil.copytree(bundle, app, ignore=shutil.ignore_patterns("data", "*.log"))
    env = dict(os.environ)
    windows = Path(env.get("SystemRoot", r"C:\Windows"))
    env["PATH"] = str(windows / "System32") + os.pathsep + str(windows)
    for key in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "PULSE_DATA_DIR", "PULSE_APP_ROOT"):
        env.pop(key, None)
    assert shutil.which("python", path=env["PATH"]) is None
    assert shutil.which("node", path=env["PATH"]) is None
    assert shutil.which("ffmpeg", path=env["PATH"]) is None
    fixtures = create_fixtures(check / "fixtures", app / "bin" / "ffmpeg.exe", env)
    base = f"http://127.0.0.1:{args.port}"
    process = None
    report = {"bundle": str(bundle), "testDirectory": str(check), "bundledMedia": bundled_count,
              "runtimePATH": env["PATH"], "externalRuntimeRequired": False, "checks": []}
    try:
        process = start_concurrently(app, args.port, env)
        assert request(base, "/api/media")["media"] == []
        media = [upload(base, path) for path in fixtures]
        analysis = request(base, f"/api/analyze/{media[2]['id']}", {"sensitivity": 1, "minInterval": .22})
        assert len(analysis["beats"]) == 11, analysis
        assert abs(analysis["bpm"] - 120) < 1, analysis
        media[2].update(analysis)
        project = make_project(media)
        request(base, f"/api/projects/{project['id']}", project, method="PUT")
        saved = request(base, "/api/projects/active")["project"]
        assert saved == project, "Project save changed source/warp/beat fields."
        disk_project = app / "data" / "projects" / f"{project['id']}.pulse.json"
        assert disk_project.is_file(), f"Project did not reach the portable folder: {disk_project}"
        assert json.loads(disk_project.read_text("utf-8")) == project
        verify_media_files(base, media)
        before_move_export = export_project(base, project)
        with urllib.request.urlopen(base + before_move_export["url"], timeout=30) as response:
            before_move_bytes = response.read()
        assert len(before_move_bytes) > 1000
        first_key = request(base, "/api/health").get("workspaceKey")
        report["checks"].extend(["minimal Windows PATH startup", "concurrent double launch leaves one server",
                                  "bundled FFmpeg MOV import",
                                  "synthetic kick detection", "file-backed warped project save",
                                  "original/proxy byte ranges"])
        stop(app, args.port, process, env)
        process = None
        # Verified absolute paths above; rename stays inside this test workspace.
        # Windows may briefly retain an image/scanner handle after process exit.
        # Retry the same rename without copying/deleting any application data.
        for attempt in range(100):
            try:
                app.rename(moved)
                break
            except PermissionError:
                if attempt == 99:
                    raise
                time.sleep(.2)
        app = moved
        process = start(app, args.port, env)
        assert request(base, "/api/health").get("workspaceKey") != first_key
        restored = request(base, "/api/projects/active")["project"]
        assert restored == project, "Project did not survive relocation with its media references."
        verify_media_files(base, media)
        with urllib.request.urlopen(base + before_move_export["url"], timeout=30) as response:
            assert response.read() == before_move_bytes, "Existing export download broke after moving its absolute old path."
        report["checks"].append("relaunch from path containing spaces and Persian Unicode")
        report["checks"].append("relocated project and media reference recovery")
        report["checks"].append("previously completed export download after relocation")

        job = export_project(base, restored)
        output = check / "portable-warped-film.mp4"
        with urllib.request.urlopen(base + job["url"], timeout=30) as response:
            output.write_bytes(response.read())
        ffprobe = app / "bin" / "ffprobe.exe"
        info = json.loads(command(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)], env=env))
        video = next(item for item in info["streams"] if item["codec_type"] == "video")
        assert (video["width"], video["height"], video["codec_name"]) == (320, 180, "h264")
        assert abs(float(info["format"]["duration"]) - 6) < .05
        ffmpeg = app / "bin" / "ffmpeg.exe"
        colors = []
        for timestamp in ("0.7", "1.4"):
            raw = command(ffmpeg, ["-v", "error", "-ss", timestamp, "-i", str(output), "-frames:v", "1",
                                   "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], env=env)
            colors.append(list(raw[:3]))
        assert colors[0][0] > colors[0][2] + 100, colors
        assert colors[1][2] > colors[1][0] + 100, colors
        audio = command(ffmpeg, ["-v", "error", "-ss", "0.8", "-t", "0.08", "-i", str(output),
                                 "-vn", "-ac", "1", "-f", "f32le", "pipe:1"], env=env)
        peak = max((abs(value[0]) for value in struct.iter_unpack("<f", audio)), default=0)
        assert peak < .01, f"Muted source video tone leaked into export: {peak}"
        report["checks"].append("real piecewise export, decoded color boundaries, duration and mute")
        report["output"] = str(output)

        if args.browser:
            node = shutil.which("node")
            assert node, "Node test runner is missing (the frozen app itself did not need Node)."
            browser_env = dict(os.environ, PULSE_TEST_URL=base, PULSE_PORTABLE_TEST="1")
            result = subprocess.run([node, str(ROOT / "node_modules" / "@playwright" / "test" / "cli.js"),
                                     "test", "tests/portable.spec.ts"], cwd=ROOT, env=browser_env,
                                    timeout=150, creationflags=CREATE_FLAGS)
            assert result.returncode == 0, "Portable browser checks failed."
            report["checks"].append("browser loads disk project, plays warped MOVs and autosaves to disk")
            editing_env = dict(browser_env, PULSE_EDIT_TEST="1",
                               PULSE_EDIT_WORKSPACE_KEY=hashlib.sha256(
                                   str((app / "data").resolve()).casefold().encode("utf-8")
                               ).hexdigest()[:24])
            result = subprocess.run([node, str(ROOT / "node_modules" / "@playwright" / "test" / "cli.js"),
                                     "test", "tests/editing.spec.ts"], cwd=ROOT, env=editing_env,
                                    timeout=600, creationflags=CREATE_FLAGS)
            assert result.returncode == 0, "Precision editing browser checks failed."
            report["checks"].append("browser reversible trim, stable waveform, source slip, frame preview and retained retime recovery")
            editing_env["PULSE_BEAT_TEST"] = "1"
            result = subprocess.run([node, str(ROOT / "node_modules" / "@playwright" / "test" / "cli.js"),
                                     "test", "tests/beat-workbench.spec.ts", "tests/workspace.spec.ts"], cwd=ROOT, env=editing_env,
                                    timeout=600, creationflags=CREATE_FLAGS)
            assert result.returncode == 0, "Beat workbench or configurable workspace browser checks failed."
            report["checks"].append("browser audible bass groups, beat selection/deletion, exact filter-repeat and configurable panel layout")
        report["passed"] = True
        return report
    finally:
        stop(app, args.port, process, env)
        (check / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", default=str(ROOT / "portable" / "Pulse"))
    parser.add_argument("--port", type=int, default=8877)
    parser.add_argument("--expected-media", type=int)
    parser.add_argument("--browser", action="store_true")
    arguments = parser.parse_args()
    print(json.dumps(run(arguments), ensure_ascii=False, indent=2))
