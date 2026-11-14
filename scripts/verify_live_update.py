"""Verify a real GitHub update on an isolated, genuinely frozen older Pulse.

Preparation never edits the real application or user data. It builds a source
clone whose runtime version is older, then copies a previous synthetic test's
three media assets and edit graph into that app. A later run clicks the actual
update UI and downloads the published GitHub release without API mocks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
CHECKS = ROOT / "data" / "portable-checks"
CREATE_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def read_json(path: Path):
    return json.loads(path.read_text("utf-8"))


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")


def request(base: str, path: str, *, token: str | None = None, timeout: float = 2):
    headers = {"X-Pulse-Token": token} if token else {}
    req = urllib.request.Request(base + path, method="POST" if token else "GET", headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as response:
        return json.load(response)


def assert_port_free(port: int) -> None:
    with socket.socket() as sock:
        sock.settimeout(.3)
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            raise AssertionError(f"Port {port} belongs to another process; refusing to reuse it.")


def minimal_environment() -> dict:
    env = dict(os.environ)
    windows = Path(env.get("SystemRoot", r"C:\Windows"))
    env["PATH"] = str(windows / "System32") + os.pathsep + str(windows)
    for key in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "PULSE_DATA_DIR", "PULSE_APP_ROOT", "PULSE_RUNTIME_TOKEN"):
        env.pop(key, None)
    for tool in ("python", "node", "ffmpeg", "ffprobe"):
        assert shutil.which(tool, path=env["PATH"]) is None, f"External {tool} unexpectedly visible."
    return env


def synthetic_fixture(selected: str | None) -> Path:
    if selected:
        return Path(selected).resolve()
    completed = []
    for report in CHECKS.glob("run-*/verification.json"):
        try:
            if read_json(report).get("passed") is not True:
                continue
            for data in report.parent.glob("Moved Pulse*/data"):
                metadata = list((data / "media").glob("*/metadata.json"))
                names = {read_json(file)["name"] for file in metadata}
                if len(metadata) == 3 and names == {"portable-red.mov", "portable-blue.mov", "portable-kicks.wav"}:
                    completed.append((report.stat().st_mtime, data.resolve()))
        except (OSError, ValueError, KeyError):
            continue
    if not completed:
        raise AssertionError("No successful synthetic portable fixture was found. Run scripts/verify_portable.py --browser first, or pass --fixture-data with its isolated data folder under data/portable-checks.")
    return max(completed, key=lambda candidate: candidate[0])[1]


def prepare(args) -> Path:
    if sys.platform != "win32":
        raise AssertionError("Build and run this frozen update test on Windows x64.")
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.old_version):
        raise AssertionError("Use an old version in major.minor.patch form.")
    source = synthetic_fixture(args.fixture_data)
    # The known verification namespace contains synthetic fixtures only. Never
    # turn the user's main data/media library into an update test workspace.
    assert source.is_relative_to(CHECKS.resolve()), f"Fixture must stay inside {CHECKS}"
    media_files = list((source / "media").glob("*/metadata.json"))
    assert len(media_files) == 3, "Expected exactly the two MOVs and synthetic kick WAV."
    assert list((source / "projects").glob("*.pulse.json")), "Synthetic project fixture is missing."
    check = (CHECKS / f"live-update-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}").resolve()
    assert check.is_relative_to(CHECKS.resolve())
    clone = check / "old-source"
    clone.mkdir(parents=True)
    for directory in ("backend", "dist", "packaging"):
        shutil.copytree(ROOT / directory, clone / directory,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.spec"))
    for filename in ("portable_runtime.py", "updater_runtime.py", "README.md"):
        shutil.copy2(ROOT / filename, clone / filename)
    (clone / "scripts").mkdir()
    shutil.copy2(ROOT / "scripts" / "build_portable.py", clone / "scripts" / "build_portable.py")
    version_file = clone / "backend" / "version.py"
    original = version_file.read_text("utf-8")
    target = re.search(r'^VERSION\s*=\s*[\'"]([^\'"]+)', original, re.MULTILINE)
    assert target, "Current source runtime VERSION is missing."
    edited, count = re.subn(r'^VERSION\s*=.*$', f'VERSION = "{args.old_version}"', original,
                           count=1, flags=re.MULTILINE)
    assert count == 1
    version_file.write_text(edited, "utf-8")
    python = ROOT / ".venv" / "Scripts" / "python.exe"
    subprocess.run([str(python), str(clone / "scripts" / "build_portable.py"), "--without-data", "--no-zip"],
                   cwd=clone, check=True)
    app = clone / "release" / "Pulse"
    assert (app / "Pulse.exe").is_file() and (app / "bin" / "PulseUpdater.exe").is_file()
    for directory in ("media", "projects", "exports"):
        if (source / directory).is_dir():
            shutil.copytree(source / directory, app / "data" / directory)
    note = app / "keep-my-personal-note.txt"
    note.write_text(f"Unrelated root file must survive updates. {uuid.uuid4()}\n", "utf-8")
    prepared = check / "prepared.json"
    save_json(prepared, {"app": str(app), "oldVersion": args.old_version,
                        "targetVersion": args.target_version or target.group(1), "port": args.port,
                        "sourceFixture": str(source), "preparedAt": time.time()})
    print(f"Prepared frozen old-version fixture: {prepared}", flush=True)
    return prepared


def stop_test_app(app: Path, base: str, expected_key: str, original: subprocess.Popen | None) -> None:
    # A failed browser assertion can land between the old process exiting and
    # the helper launching its replacement. Let an already-started transaction
    # settle before cleanup, so its later restart cannot leave an orphan server.
    plans = sorted((app / "data" / "updates").glob("*/plan.json"), key=lambda path: path.stat().st_mtime)[-1:]
    def settled(plan: Path) -> bool:
        for result in (plan.with_name("result.json"), app / "data" / "updates" / "last-result.json"):
            try:
                receipt = read_json(result)
                if receipt.get("transactionId") == plan.parent.name and receipt.get("status") in {"complete", "error", "rolled-back"}:
                    return True
            except (OSError, ValueError):
                pass
        try:
            return read_json(plan.with_name("cancelled.json")).get("cancelled") is True
        except (OSError, ValueError):
            return False
    settle = time.monotonic() + 180
    while any(not settled(plan) for plan in plans):
        if time.monotonic() >= settle:
            raise AssertionError("The isolated update helper did not settle during cleanup; inspect its local updater.log.")
        time.sleep(.3)
    try:
        health = request(base, "/api/health")
    except (OSError, ValueError):
        if original is not None and original.poll() is None:
            original.terminate()
            original.wait(timeout=15)
        return
    if health.get("workspaceKey") != expected_key:
        raise AssertionError("Cleanup found another workspace on this port; no stop request was sent.")
    record = read_json(app / "data" / "runtime" / "server.json")
    request(base, "/api/runtime/stop", token=record["token"])
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            request(base, "/api/health", timeout=1)
        except (OSError, ValueError):
            return
        time.sleep(.2)
    raise AssertionError("The isolated updated app did not stop after its authenticated stop request.")


def run_live(prepared_path: Path, target_version: str | None = None) -> dict:
    prepared_path = prepared_path.resolve()
    assert prepared_path.is_relative_to(CHECKS.resolve()), "Prepared fixture must be in the isolated test namespace."
    prepared = read_json(prepared_path)
    if target_version is not None:
        assert re.fullmatch(r"\d+\.\d+\.\d+", target_version), "Target must use major.minor.patch."
        prepared["targetVersion"] = target_version
    app = Path(prepared["app"]).resolve()
    check = prepared_path.parent
    assert app.is_relative_to(check), "Prepared app escaped its isolated test directory."
    port = int(prepared["port"])
    base = f"http://127.0.0.1:{port}"
    assert_port_free(port)
    data = app / "data"
    expected_key = hashlib.sha256(str(data).casefold().encode("utf-8")).hexdigest()[:24]
    env = minimal_environment()
    report = {"testDirectory": str(check), "app": str(app), "oldVersion": prepared["oldVersion"],
              "targetVersion": prepared["targetVersion"], "runtimePATH": env["PATH"], "checks": []}
    before_media = {str(path.relative_to(data / "media")): digest(path)
                    for path in (data / "media").rglob("*") if path.is_file()}
    before_exports = {str(path.relative_to(data / "exports")): digest(path)
                      for path in (data / "exports").rglob("*") if path.is_file()}
    note_hash = digest(app / "keep-my-personal-note.txt")
    executable_hash = digest(app / "Pulse.exe")
    original = None
    try:
        original = subprocess.Popen([str(app / "Pulse.exe"), "--no-browser", "--port", str(port)],
                                    cwd=app, env=env, creationflags=CREATE_FLAGS)
        until = time.monotonic() + 60
        while time.monotonic() < until:
            if original.poll() is not None:
                raise AssertionError(f"Old frozen fixture exited before readiness: {original.returncode}")
            try:
                health = request(base, "/api/health", timeout=1)
                if health.get("ok") and health.get("workspaceKey") == expected_key:
                    assert health.get("portable") is True and health.get("version") == prepared["oldVersion"], health
                    break
            except (OSError, ValueError):
                pass
            time.sleep(.2)
        else:
            raise AssertionError("Old frozen fixture did not start.")
        report["checks"].append("genuine old frozen binary starts with Windows-only PATH")
        assert len(request(base, "/api/media")["media"]) == 3
        node = shutil.which("node")
        assert node, "The external browser test runner needs Node; the app process itself does not."
        browser_report = check / "browser-result.json"
        browser_env = dict(os.environ, PULSE_LIVE_UPDATE_TEST="1", PULSE_TEST_URL=base,
                           PULSE_LIVE_UPDATE_OLD=prepared["oldVersion"], PULSE_LIVE_UPDATE_TARGET=prepared["targetVersion"],
                           PULSE_LIVE_UPDATE_REPORT=str(browser_report))
        result = subprocess.run([node, str(ROOT / "node_modules" / "@playwright" / "test" / "cli.js"),
                                 "test", "tests/live_update.spec.ts"], cwd=ROOT, env=browser_env,
                                timeout=600, creationflags=CREATE_FLAGS)
        assert result.returncode == 0, "Live GitHub update browser flow failed; see trace and local update logs."
        browser_result = read_json(browser_report)
        assert browser_result["passed"] is True
        health = request(base, "/api/health")
        assert health["version"] == prepared["targetVersion"] and health["workspaceKey"] == expected_key
        assert digest(app / "Pulse.exe") != executable_hash, "Frozen executable did not change."
        report["checks"].extend(["real GitHub latest-release and manifest lookup", "actual UI Update now request",
                                  "download verification, standalone helper replacement and healthy restart"])
        after_media = {str(path.relative_to(data / "media")): digest(path)
                       for path in (data / "media").rglob("*") if path.is_file()}
        after_exports = {str(path.relative_to(data / "exports")): digest(path)
                         for path in (data / "exports").rglob("*") if path.is_file()}
        assert after_media == before_media, "A media original, proxy or metadata file changed during updating."
        assert after_exports == before_exports, "An existing export changed during updating."
        assert digest(app / "keep-my-personal-note.txt") == note_hash, "Updater replaced an unrelated root file."
        receipt = read_json(data / "updates" / "last-result.json")
        assert receipt["status"] == "complete" and receipt["version"] == prepared["targetVersion"], receipt
        assert receipt["previousVersion"] == prepared["oldVersion"]
        report["checks"].extend(["all synthetic media and existing exports remain byte-identical",
                                  "unrelated root file preserved", "project graph restored after browser reload",
                                  "completion receipt records old and new versions"])
        report.update(passed=True, browser=browser_result, receipt=receipt)
        return report
    except BaseException as error:
        report.update(passed=False, error=f"{type(error).__name__}: {error}")
        receipt_file = data / "updates" / "last-result.json"
        if receipt_file.is_file():
            report["receipt"] = read_json(receipt_file)
        raise
    finally:
        try:
            stop_test_app(app, base, expected_key, original)
            report["cleanup"] = "isolated application stopped"
        finally:
            save_json(check / "verification.json", report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--prepared", type=Path, help="Run an already prepared fixture after its target release is published.")
    parser.add_argument("--fixture-data", help="Synthetic three-media fixture data; defaults to the latest successful isolated portable verification.")
    parser.add_argument("--old-version", default="1.1.9")
    parser.add_argument("--target-version")
    parser.add_argument("--port", type=int, default=8890)
    arguments = parser.parse_args()
    fixture = arguments.prepared or prepare(arguments)
    if arguments.prepare_only:
        print(json.dumps({"prepared": str(fixture)}, ensure_ascii=False))
    else:
        print(json.dumps(run_live(fixture, arguments.target_version), ensure_ascii=False, indent=2))
