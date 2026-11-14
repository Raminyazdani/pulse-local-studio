"""Updater checks with real ZIP/file transactions; process and network boundaries are stubbed."""
from __future__ import annotations

import copy
import io
import json
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch
import uuid
import zipfile

import updater_runtime as helper
from . import updates


class FakeProcess:
    def __init__(self):
        self.stopped = False

    def poll(self):
        return 0 if self.stopped else None

    def terminate(self):
        self.stopped = True

    def wait(self, timeout=None):
        self.stopped = True
        return 0


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pulse-update-tests-")
        self.base = Path(self.temporary.name)
        self.root = self.base / "Pulse قابل حمل"
        self.root.mkdir()
        self.data = self.root / "data"
        self.data.mkdir()
        self.repository = "Raminyazdani/pulse-local-studio"
        major, minor, revision = helper.version_tuple(updates.VERSION)
        self.next_version = f"{major}.{minor}.{revision + 1}"
        self.units = {"Pulse.exe": b"old executable", "_internal/python312.dll": b"old dll",
                      "bin/ffmpeg.exe": b"old ffmpeg", "bin/ffprobe.exe": b"old probe",
                      "bin/PulseUpdater.exe": b"old helper", "dist/index.html": b"old UI",
                      "licenses/notice.txt": b"old license", "build-info.json": b'{"version":"old"}'}
        for name, content in self.units.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        for name in ("media/original.mov", "projects/private.pulse.json", "exports/film.mp4"):
            path = self.data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"PRIVATE DATA " + name.encode())
        (self.root / "my-notes.txt").write_text("Unrelated personal notes", "utf-8")
        self.original_data = {str(path.relative_to(self.data)): path.read_bytes()
                              for path in self.data.rglob("*") if path.is_file()}
        self.stack = [patch.object(updates, "ROOT", self.root), patch.object(updates, "DATA", self.data),
                      patch.object(updates, "GITHUB_REPOSITORY", self.repository)]
        for item in self.stack:
            item.start()
        updates.STATE.clear()
        updates.STATE.update(status="idle", progress=0)
        updates.MANIFEST = None
        updates.LAST_RECEIPT = None

    def tearDown(self):
        for item in reversed(self.stack):
            item.stop()
        self.temporary.cleanup()

    def package(self, *, extras=None, prefix="Pulse/"):
        stage = self.data / "updates" / str(uuid.uuid4())
        stage.mkdir(parents=True)
        archive = stage / "package.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for name in self.units:
                output.writestr(prefix + name, b"NEW " + name.encode())
            for name, value in extras or []:
                output.writestr(name, value)
        plan = dict(schema=1, appRoot=str(self.root), dataDir=str(self.data), version=self.next_version,
                    currentVersion=updates.VERSION, parentPid=99999999, port=8877,
                    sha256=helper.sha256_file(archive), size=archive.stat().st_size)
        helper.write_json(stage / "plan.json", plan)
        return stage, archive, plan

    def manifest(self, archive: Path):
        name = "Pulse-Portable-Windows-x64.zip"
        return {"repository": self.repository, "version": self.next_version,
                "asset": {"name": name, "url": f"https://github.com/{self.repository}/releases/download/v{self.next_version}/{name}",
                          "size": archive.stat().st_size, "sha256": helper.sha256_file(archive)}}

    def assert_private_data_preserved(self):
        for name, value in self.original_data.items():
            self.assertEqual((self.data / name).read_bytes(), value)
        self.assertEqual((self.root / "my-notes.txt").read_text("utf-8"), "Unrelated personal notes")

    def test_success_transaction_replaces_runtime_and_preserves_all_user_files(self):
        stage, _, _ = self.package()
        with patch.object(helper, "launch_app", return_value=FakeProcess()), patch.object(helper, "wait_ready", return_value=True):
            result = helper.apply_plan(stage / "plan.json", wait_parent=False)
        self.assertEqual(result["status"], "complete")
        for name, old in self.units.items():
            self.assertEqual((self.root / name).read_bytes(), b"NEW " + name.encode())
            self.assertEqual((stage / "backup" / name).read_bytes(), old)
        self.assert_private_data_preserved()
        self.assertEqual(json.loads((self.data / "updates/last-result.json").read_text("utf-8"))["version"], self.next_version)

    def test_failed_new_app_rolls_back_real_files_and_restarts_previous_version(self):
        stage, _, _ = self.package()
        failed_process, recovered_process = FakeProcess(), FakeProcess()
        with patch.object(helper, "launch_app", side_effect=[failed_process, recovered_process]) as launch, patch.object(helper, "wait_ready", side_effect=[False, True]):
            result = helper.apply_plan(stage / "plan.json", wait_parent=False)
        self.assertEqual(result["status"], "rolled-back")
        self.assertTrue(result["restarted"])
        self.assertTrue(failed_process.stopped)
        self.assertEqual(launch.call_count, 2)
        for name, old in self.units.items():
            self.assertEqual((self.root / name).read_bytes(), old)
        self.assert_private_data_preserved()

    def test_partial_replacement_failure_restores_runtime_without_deleting_data(self):
        stage, _, _ = self.package()
        real_move = helper.move_path
        failed = False

        def fail_one_new_unit(source, destination):
            nonlocal failed
            if source.name.casefold() == "bin" and source.parent.name.casefold() == "new" and not failed:
                failed = True
                raise OSError("simulated locked runtime")
            return real_move(source, destination)

        with patch.object(helper, "move_path", side_effect=fail_one_new_unit), patch.object(helper, "launch_app", return_value=FakeProcess()), patch.object(helper, "wait_ready", return_value=True):
            result = helper.apply_plan(stage / "plan.json", wait_parent=False)
        self.assertEqual(result["status"], "rolled-back")
        self.assertTrue(failed, "The filesystem failure injection did not reach the runtime replacement.")
        for name, old in self.units.items():
            self.assertEqual((self.root / name).read_bytes(), old)
        self.assert_private_data_preserved()

    def test_bad_checksum_and_downgrade_never_replace_files(self):
        stage, _, plan = self.package()
        plan["sha256"] = "0" * 64
        helper.write_json(stage / "plan.json", plan)
        with self.assertRaisesRegex(ValueError, "checksum"):
            helper.apply_plan(stage / "plan.json", wait_parent=False)
        plan["version"] = updates.VERSION
        helper.write_json(stage / "plan.json", plan)
        with self.assertRaisesRegex(ValueError, "older or equal"):
            helper.apply_plan(stage / "plan.json", wait_parent=False)
        self.assertEqual((self.root / "Pulse.exe").read_bytes(), self.units["Pulse.exe"])
        self.assert_private_data_preserved()

    def test_archive_rejects_traversal_userdata_links_and_windows_collisions(self):
        dangerous = ["Pulse/data/projects/private.pulse.json", "Pulse/../data/override", "Pulse/bin/CON.txt",
                     "Pulse/bin/a.exe:stream", "Pulse/bin/trailing. ", "Pulse/DIST/index.html"]
        for member in dangerous:
            with self.subTest(member=member):
                _, archive, _ = self.package(extras=[(member, b"malicious")])
                with self.assertRaises(ValueError):
                    helper.validate_archive(archive)
        _, archive, _ = self.package()
        with zipfile.ZipFile(archive, "a") as output:
            link = zipfile.ZipInfo("Pulse/bin/link")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            output.writestr(link, "../../data")
        with self.assertRaisesRegex(ValueError, "symbolic links"):
            helper.validate_archive(archive)
        _, archive, _ = self.package()
        with zipfile.ZipFile(archive, "a") as output:
            raw = zipfile.ZipInfo("placeholder")
            # ZipInfo normally normalizes the Windows separator when writing.
            # Assignment after construction creates the actual unsafe wire name.
            raw.filename = "Pulse/bin\\escape.exe"
            output.writestr(raw, b"malicious")
        with self.assertRaisesRegex(ValueError, "Unsafe path"):
            helper.validate_archive(archive)
        self.assert_private_data_preserved()

    def test_incomplete_package_and_unsafe_plan_are_rejected(self):
        archive = self.base / "incomplete.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("Pulse/Pulse.exe", b"only executable")
        with self.assertRaisesRegex(ValueError, "incomplete"):
            helper.validate_archive(archive)
        stage, _, plan = self.package()
        plan["dataDir"] = str(self.base / "outside")
        helper.write_json(stage / "plan.json", plan)
        with self.assertRaisesRegex(ValueError, "staging"):
            helper.apply_plan(stage / "plan.json", wait_parent=False)

    def test_manifest_and_redirects_only_allow_configured_https_github_release(self):
        _, archive, _ = self.package()
        good = self.manifest(archive)
        self.assertEqual(updates.validate_manifest(good, self.repository, self.next_version), good)
        for url in ("http://github.com/owner/repo", "https://evil.example/file.zip",
                    f"https://github.com/wrong/repo/releases/download/v1.0/file.zip",
                    "https://user:password@github.com/file", "https://github.com:444/file"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                updates.validate_url(url, self.repository)
        self.assertEqual(updates.validate_url("https://release-assets.githubusercontent.com/file?signature=abc", self.repository, redirect=True),
                         "https://release-assets.githubusercontent.com/file?signature=abc")
        wrong = copy.deepcopy(good)
        wrong["repository"] = "another/repository"
        with self.assertRaises(ValueError):
            updates.validate_manifest(wrong, self.repository, self.next_version)

    def test_check_uses_published_asset_manifest_and_rejects_digest_mismatch(self):
        _, archive, _ = self.package()
        manifest = self.manifest(archive)
        release = {"tag_name": "v" + self.next_version, "body": "Update notes", "assets": [
            {"name": "pulse-update.json", "browser_download_url": f"https://github.com/{self.repository}/releases/download/v{self.next_version}/pulse-update.json"},
            {"name": manifest["asset"]["name"], "browser_download_url": manifest["asset"]["url"],
             "size": manifest["asset"]["size"], "digest": "sha256:" + manifest["asset"]["sha256"]}]}
        with patch.object(updates, "fetch_json", side_effect=[release, manifest]):
            updates._check()
        self.assertEqual(updates.STATE["status"], "available")
        self.assertEqual(updates.MANIFEST["version"], self.next_version)
        release["assets"][1]["digest"] = "sha256:" + "0" * 64
        with patch.object(updates, "fetch_json", side_effect=[release, manifest]):
            updates._check()
        self.assertEqual(updates.STATE["status"], "error")
        self.assertIn("digest", updates.STATE["error"])

    def test_current_release_is_up_to_date_without_package_download(self):
        with patch.object(updates, "fetch_json", return_value={"tag_name": "v" + updates.VERSION}) as fetch:
            updates._check()
        self.assertEqual(updates.STATE["status"], "up-to-date")
        self.assertEqual(fetch.call_count, 1)
        self.assertIsNone(updates.MANIFEST)

    def test_historical_completion_receipt_never_hides_a_new_available_release(self):
        _, archive, _ = self.package()
        manifest = self.manifest(archive)
        helper.write_json(self.data / "updates/last-result.json", {"transactionId": "old-install", "status": "complete",
            "version": updates.VERSION, "timestamp": 1, "message": "Previous update finished"})
        release = {"tag_name": "v" + self.next_version, "assets": [
            {"name": "pulse-update.json", "browser_download_url": f"https://github.com/{self.repository}/releases/download/v{self.next_version}/pulse-update.json"},
            {"name": manifest["asset"]["name"], "browser_download_url": manifest["asset"]["url"],
             "size": manifest["asset"]["size"], "digest": "sha256:" + manifest["asset"]["sha256"]}]}
        updates.STATE.update(status="checking")
        # Simulate a click before the first status GET on a freshly restarted app.
        with patch.object(updates, "fetch_json", side_effect=[release, manifest]):
            updates._check()
        status = updates.update_status()
        self.assertEqual(status["status"], "available")
        self.assertEqual(status["latestVersion"], self.next_version)

    def test_download_verifies_package_before_helper_launch_and_shutdown(self):
        _, archive, _ = self.package()
        manifest = self.manifest(archive)
        ready = Mock()
        def prepared_helper(arguments, **kwargs):
            path = Path(arguments[-1])
            plan = json.loads(path.read_text("utf-8"))
            helper.write_json(path.parent / "helper-ready.json", {"ready": True, "version": plan["version"], "sha256": plan["sha256"]})
            return FakeProcess()

        with patch.object(updates, "open_github", return_value=io.BytesIO(archive.read_bytes())), patch.object(updates.subprocess, "Popen", side_effect=prepared_helper) as launch:
            updates._install(manifest, ready, 8877)
        self.assertEqual(updates.STATE["status"], "installing")
        ready.assert_called_once()
        launch.assert_called_once()
        args = launch.call_args.args[0]
        plan = json.loads(Path(args[-1]).read_text("utf-8"))
        self.assertEqual(plan["appRoot"], str(self.root))
        self.assertEqual(Path(args[0]).parent, Path(args[-1]).parent)
        self.assert_private_data_preserved()

    def test_extraction_failure_before_handshake_leaves_original_app_running(self):
        _, archive, _ = self.package()
        manifest = self.manifest(archive)
        ready = Mock()

        def failed_helper(arguments, **kwargs):
            with patch.object(helper.zipfile.ZipFile, "open", side_effect=OSError("disk full while extracting")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    helper.apply_plan(Path(arguments[-1]), wait_parent=False)
            process = FakeProcess()
            process.stopped = True
            return process

        with patch.object(updates, "open_github", return_value=io.BytesIO(archive.read_bytes())), patch.object(updates.subprocess, "Popen", side_effect=failed_helper):
            updates._install(manifest, ready, 8877)
        self.assertEqual(updates.STATE["status"], "error")
        ready.assert_not_called()
        for name, old in self.units.items():
            self.assertEqual((self.root / name).read_bytes(), old)
        self.assert_private_data_preserved()

    def test_helper_ready_handshake_precedes_parent_wait_and_runtime_mutation(self):
        stage, _, _ = self.package()

        def parent_exit(pid, executable):
            self.assertTrue((stage / "helper-ready.json").is_file())
            for name, old in self.units.items():
                self.assertEqual((self.root / name).read_bytes(), old)

        with patch.object(helper, "wait_for_parent", side_effect=parent_exit), patch.object(helper, "launch_app", return_value=FakeProcess()), patch.object(helper, "wait_ready", return_value=True):
            result = helper.apply_plan(stage / "plan.json")
        self.assertEqual(result["status"], "complete")

    def test_download_corruption_does_not_launch_helper_or_stop_app(self):
        _, archive, _ = self.package()
        manifest = self.manifest(archive)
        ready = Mock()
        broken = bytearray(archive.read_bytes())
        broken[20] ^= 1
        with patch.object(updates, "open_github", return_value=io.BytesIO(broken)), patch.object(updates.subprocess, "Popen") as launch:
            updates._install(manifest, ready, 8877)
        self.assertEqual(updates.STATE["status"], "error")
        ready.assert_not_called()
        launch.assert_not_called()
        self.assert_private_data_preserved()

    def test_local_receipt_reports_completed_or_restored_update_without_network(self):
        helper.write_json(self.data / "updates/last-result.json", {"transactionId": "test", "status": "complete", "version": updates.VERSION,
                                                                  "timestamp": 1, "message": "Update complete"})
        with patch.dict("os.environ", {"PULSE_PORTABLE": "1"}), patch.object(updates, "open_github") as fetch:
            status = updates.update_status()
            self.assertEqual(status["status"], "up-to-date")
            fetch.assert_not_called()
        helper.write_json(self.data / "updates/last-result.json", {"transactionId": "test2", "status": "rolled-back", "timestamp": 2,
                                                                  "message": "Previous version restored"})
        self.assertEqual(updates.update_status()["status"], "error")

    def test_http_update_actions_require_local_json_and_refuse_busy_or_source_instances(self):
        import importlib
        from fastapi.testclient import TestClient
        server = importlib.import_module("backend.app")
        client = TestClient(server.app, base_url="http://127.0.0.1:8765")
        with patch.object(server, "start_check", return_value={"status": "checking"}) as check:
            self.assertEqual(client.post("/api/updates/check", json={}, headers={"Origin": "https://attacker.example"}).status_code, 403)
            self.assertEqual(client.post("/api/updates/check", content="{}", headers={"Content-Type": "text/plain"}).status_code, 415)
            self.assertEqual(client.post("/api/updates/check", json={}, headers={"Host": "attacker.example"}).status_code, 403)
            check.assert_not_called()
            response = client.post("/api/updates/check", json={}, headers={"Origin": "http://127.0.0.1:8765"})
            self.assertEqual(response.json()["status"], "checking")
            check.assert_called_once()
        with patch.object(server, "start_install", return_value={"status": "installing"}) as install:
            with patch.object(server.app.state, "stop_runtime", None, create=True):
                self.assertEqual(client.post("/api/updates/install", json={}).status_code, 409)
            stop = Mock()
            with patch.object(server.app.state, "stop_runtime", stop, create=True), patch.object(server.app.state, "runtime_port", 8877, create=True):
                with patch.object(server, "JOBS", {"job": {"status": "rendering"}}):
                    self.assertEqual(client.post("/api/updates/install", json={}).status_code, 409)
                with patch.object(server.app.state, "active_media_operations", 1):
                    self.assertEqual(client.post("/api/updates/install", json={}).status_code, 409)
                install.assert_not_called()
                with patch.object(server, "JOBS", {}):
                    self.assertEqual(client.post("/api/updates/install", json={}).status_code, 200)
                install.assert_called_once_with(stop, 8877)

    def test_http_media_counter_is_released_on_failure_and_new_work_is_blocked_during_update(self):
        import importlib
        from fastapi.testclient import TestClient
        server = importlib.import_module("backend.app")
        client = TestClient(server.app, base_url="http://127.0.0.1:8765")

        def failed_import(file):
            self.assertEqual(server.app.state.active_media_operations, 1)
            raise ValueError("Synthetic decoder failure")

        with patch.object(server, "is_installing", return_value=False), patch.object(server, "store_upload", side_effect=failed_import):
            response = client.post("/api/media", files={"files": ("test.mov", b"test fixture", "video/quicktime")})
            self.assertEqual(response.status_code, 400)
        self.assertEqual(server.app.state.active_media_operations, 0)
        with patch.object(server, "is_installing", return_value=True), patch.object(server, "store_upload") as upload:
            self.assertEqual(client.post("/api/media", files={"files": ("test.mov", b"fixture")}).status_code, 409)
            self.assertEqual(client.post("/api/analyze/fixture", json={}).status_code, 409)
            self.assertEqual(client.post("/api/export", json={}).status_code, 409)
            upload.assert_not_called()
        self.assertEqual(server.app.state.active_media_operations, 0)

    def test_concurrent_install_claim_blocks_upload_admission_until_updating_is_visible(self):
        import importlib
        from fastapi.testclient import TestClient
        server = importlib.import_module("backend.app")
        install_claiming = threading.Event()
        allow_claim = threading.Event()
        upload_reached_gate = threading.Event()
        installing = threading.Event()
        owner = {"thread": None}

        class ObservedAdmissionLock:
            """Observe entry attempts while keeping real cross-thread exclusion."""
            def __init__(self):
                self.lock = threading.RLock()

            def __enter__(self):
                if install_claiming.is_set() and threading.get_ident() != owner["thread"]:
                    upload_reached_gate.set()
                self.lock.acquire()
                return self

            def __exit__(self, *args):
                self.lock.release()

        admission = ObservedAdmissionLock()

        def claim_update(stop, port):
            owner["thread"] = threading.get_ident()
            install_claiming.set()
            if not allow_claim.wait(5):
                raise RuntimeError("Test did not release the updater admission barrier.")
            installing.set()
            return {"status": "downloading"}

        def request_install():
            with TestClient(server.app, base_url="http://127.0.0.1:8765") as client:
                return client.post("/api/updates/install", json={})

        def request_upload():
            with TestClient(server.app, base_url="http://127.0.0.1:8765") as client:
                return client.post("/api/media", files={"files": ("test.mov", b"synthetic")})

        with patch.object(server, "MEDIA_UPDATE_ADMISSION", admission), patch.object(server, "JOBS", {}), \
             patch.object(server, "start_install", side_effect=claim_update), \
             patch.object(server, "is_installing", side_effect=installing.is_set), \
             patch.object(server, "store_upload") as upload, \
             patch.object(server.app.state, "stop_runtime", Mock(), create=True):
            with ThreadPoolExecutor(max_workers=2) as executor:
                install_future = executor.submit(request_install)
                try:
                    self.assertTrue(install_claiming.wait(5), "Installer did not enter its claim barrier.")
                    upload_future = executor.submit(request_upload)
                    self.assertTrue(upload_reached_gate.wait(5), "Concurrent upload did not reach the shared admission gate.")
                    # Exactly at the old check-to-claim race, the installer owns
                    # the gate and the upload has reached it but cannot pass.
                    acquired = admission.lock.acquire(blocking=False)
                    if acquired:
                        admission.lock.release()
                    self.assertFalse(acquired, "Install eligibility and claiming were not one atomic admission operation.")
                    self.assertEqual(server.app.state.active_media_operations, 0)
                    upload.assert_not_called()
                finally:
                    allow_claim.set()
                self.assertEqual(install_future.result(timeout=5).status_code, 200)
                self.assertEqual(upload_future.result(timeout=5).status_code, 409)
            upload.assert_not_called()
        self.assertEqual(server.app.state.active_media_operations, 0)


if __name__ == "__main__":
    unittest.main()
