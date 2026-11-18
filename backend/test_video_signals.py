"""Durable, conflict-safe video library marks without touching original media."""
from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import Mock, patch

import numpy as np
from fastapi.testclient import TestClient

from . import app as server
from . import media as storage


class VideoSourceSignalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pulse-video-signals-")
        self.addCleanup(self.temporary.cleanup)
        self.library = Path(self.temporary.name) / "media"
        self.library.mkdir()
        self.media_patch = patch.object(storage, "MEDIA", self.library)
        self.media_patch.start()
        self.addCleanup(self.media_patch.stop)
        self.client = TestClient(server.app, base_url="http://127.0.0.1:8765")
        self.addCleanup(self.client.close)
        self.media = self.make_media()
        self.url = f"/api/media/{self.media['id']}/signals"

    def make_media(self, kind="video"):
        media_id = str(uuid.uuid4())
        directory = self.library / media_id
        directory.mkdir()
        (directory / "original.mov").write_bytes(b"unchanged original fixture")
        (directory / "proxy.mp4").write_bytes(b"unchanged preview fixture")
        value = {
            "id": media_id, "name": "Source fixture.mov", "kind": kind,
            "duration": 3, "fps": 30, "hasAudio": kind != "image",
            "url": f"/api/files/{media_id}/proxy", "_original": "original.mov", "_proxy": "proxy.mp4",
            "beats": [.5, 1.5], "waveform": [.1, .5], "bpm": 120, "sourceColorPrimaries": "bt709",
        }
        storage.save_metadata(value)
        return value

    def hashes(self):
        return {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
                for file in (self.library / self.media["id"]).iterdir() if file.name != "metadata.json"}

    def test_library_roundtrip_normalizes_labels_and_preserves_originals_proxy_and_other_metadata(self):
        before = copy.deepcopy(self.media)
        hashes = self.hashes()
        self.assertEqual(self.client.get(self.url).json()["signals"], [])
        values = [2.999999, .5, 0, .5, .50000000001, .123456789123]
        response = self.client.put(self.url, json={"signals": values, "expectedSignals": []})
        self.assertEqual(response.status_code, 200, response.text)
        saved = response.json()["media"]
        self.assertEqual(saved["sourceSignals"], [0, .123456789123, .5, 2.999999])
        self.assertFalse(any(key.startswith("_") for key in saved))
        stored = storage.get_media(self.media["id"])
        self.assertEqual(stored.pop("sourceSignals"), saved["sourceSignals"])
        self.assertEqual(stored, before)
        self.assertEqual(self.hashes(), hashes)
        # A separate read/client resolves the disk metadata, not a session cache.
        with TestClient(server.app) as reopened:
            self.assertEqual(reopened.get(self.url).json()["signals"], saved["sourceSignals"])
            row = next(item for item in reopened.get("/api/media").json()["media"] if item["id"] == self.media["id"])
            self.assertEqual(row["sourceSignals"], saved["sourceSignals"])

    def test_video_only_and_safe_uuid_lookup(self):
        for kind in ("audio", "image"):
            item = self.make_media(kind)
            url = f"/api/media/{item['id']}/signals"
            self.assertEqual(self.client.get(url).status_code, 400)
            self.assertEqual(self.client.put(url, json={"signals": [.5]}).status_code, 400)
            self.assertNotIn("sourceSignals", storage.get_media(item["id"]))
        for bad in ("not-a-uuid", str(uuid.uuid4())):
            url = f"/api/media/{bad}/signals"
            self.assertEqual(self.client.get(url).status_code, 404)
            self.assertEqual(self.client.put(url, json={"signals": []}).status_code, 404)

    def test_rejects_invalid_timestamp_types_bounds_nonfinite_and_oversized_lists(self):
        invalid = [None, {}, "1", [True], [False], [-.1], [3], [10 ** 400], [float("nan")], [float("inf")], [".5"], [None], [0] * 100001]
        for values in invalid:
            with self.subTest(values=str(values)[:60]):
                response = self.client.put(self.url, content=json.dumps({"signals": values}), headers={"Content-Type": "application/json"})
                self.assertEqual(response.status_code, 400, response.text)
        self.assertNotIn("sourceSignals", storage.get_media(self.media["id"]))

    def test_rejects_malformed_request_fields_and_size(self):
        for payload in ([], {}, {"signals": [], "unexpected": 1}, {"signals": [], "expectedSignals": None},
                        {"signals": [], "expectedSignals": [True]}):
            self.assertEqual(self.client.put(self.url, json=payload).status_code, 400)
        self.assertEqual(self.client.put(self.url, content=b"not json").status_code, 400)
        self.assertEqual(self.client.put(self.url, content=b" " * (4 * 1024 * 1024 + 1)).status_code, 413)

    def test_stale_saves_conflict_but_retry_of_already_saved_desired_marks_is_idempotent(self):
        self.assertEqual(self.client.put(self.url, json={"signals": [.5, 1], "expectedSignals": []}).status_code, 200)
        conflict = self.client.put(self.url, json={"signals": [2], "expectedSignals": []})
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(storage.get_media(self.media["id"])["sourceSignals"], [.5, 1])
        with patch.object(storage.os, "replace", side_effect=AssertionError("An idempotent save must not rewrite metadata")):
            retry = self.client.put(self.url, json={"signals": [1, .5], "expectedSignals": []})
        self.assertEqual(retry.status_code, 200, retry.text)
        clear = self.client.put(self.url, json={"signals": [], "expectedSignals": [.5, 1]})
        self.assertEqual(clear.status_code, 200)
        self.assertEqual(self.client.get(self.url).json()["signals"], [])

    def test_old_metadata_snapshot_cannot_erase_new_or_explicitly_cleared_marks(self):
        stale = storage.get_media(self.media["id"])
        storage.save_video_signals(self.media["id"], [.25, 1.75], [])
        stale.update(waveform=[.3, .8], previewVersion=2)
        storage.save_metadata(stale)
        self.assertEqual(storage.get_media(self.media["id"])["sourceSignals"], [.25, 1.75])
        stale_again = storage.get_media(self.media["id"])
        storage.save_video_signals(self.media["id"], [], [.25, 1.75])
        storage.save_metadata(stale_again)
        self.assertEqual(storage.get_media(self.media["id"])["sourceSignals"], [])

    def test_analysis_started_before_label_save_retains_the_new_labels(self):
        decoding, resume = threading.Event(), threading.Event()

        def decode(_path):
            decoding.set()
            if not resume.wait(5):
                raise TimeoutError("Test did not release audio decoding")
            return np.zeros(22050 * 3)

        with patch.object(storage, "decode_audio", side_effect=decode), patch.object(storage, "detect_beats", return_value=([.5, 1.5], 120)):
            with ThreadPoolExecutor(max_workers=1) as workers:
                pending = workers.submit(storage.analyze_media, self.media["id"])
                try:
                    self.assertTrue(decoding.wait(5))
                    storage.save_video_signals(self.media["id"], [.75, 2.25], [])
                finally:
                    resume.set()
                self.assertEqual(pending.result(timeout=5)["beats"], [.5, 1.5])
        self.assertEqual(storage.get_media(self.media["id"])["sourceSignals"], [.75, 2.25])

    def test_concurrent_expected_writers_cannot_silently_overwrite_each_other(self):
        ready = threading.Barrier(2)

        def save(at):
            ready.wait(timeout=5)
            try:
                storage.save_video_signals(self.media["id"], [at], [])
                return "saved"
            except storage.SourceSignalConflict:
                return "conflict"

        with ThreadPoolExecutor(max_workers=2) as workers:
            first, second = workers.submit(save, .5), workers.submit(save, 1.5)
            self.assertCountEqual([first.result(timeout=5), second.result(timeout=5)], ["saved", "conflict"])
        self.assertIn(storage.get_media(self.media["id"])["sourceSignals"], [[.5], [1.5]])

    def test_failed_atomic_replace_keeps_previous_file_and_removes_temporary_file(self):
        directory = self.library / self.media["id"]
        before = (directory / "metadata.json").read_bytes()
        with patch.object(storage.os, "replace", side_effect=OSError("simulated disk failure")):
            self.assertEqual(self.client.put(self.url, json={"signals": [.5]}).status_code, 507)
        self.assertEqual((directory / "metadata.json").read_bytes(), before)
        self.assertEqual(list(directory.glob("metadata.*.tmp")), [])

    def test_label_write_joins_update_admission_and_releases_counter_on_failure(self):
        with patch.object(server, "is_installing", return_value=True), patch.object(server, "save_video_signals") as save:
            self.assertEqual(self.client.put(self.url, json={"signals": [.5]}).status_code, 409)
            self.assertEqual(self.client.get(self.url).status_code, 200)
            save.assert_not_called()
        self.assertEqual(server.app.state.active_media_operations, 0)

        def fail(*_args):
            self.assertEqual(server.app.state.active_media_operations, 1)
            raise OSError("simulated full disk")

        with patch.object(server, "is_installing", return_value=False), patch.object(server, "save_video_signals", side_effect=fail):
            self.assertEqual(self.client.put(self.url, json={"signals": [.5]}).status_code, 507)
        self.assertEqual(server.app.state.active_media_operations, 0)

    def test_update_install_waits_for_an_inflight_label_save(self):
        saving, resume = threading.Event(), threading.Event()

        def delayed_save(*args):
            saving.set()
            if not resume.wait(5):
                raise TimeoutError("Test did not release label save")
            return storage.save_video_signals(*args)

        with patch.object(server, "is_installing", return_value=False), patch.object(server, "JOBS", {}), \
                patch.object(server.app.state, "stop_runtime", Mock(), create=True), \
                patch.object(server, "start_install") as install, patch.object(server, "save_video_signals", side_effect=delayed_save):
            with ThreadPoolExecutor(max_workers=1) as workers:
                pending = workers.submit(self.client.put, self.url, json={"signals": [.5]})
                try:
                    self.assertTrue(saving.wait(5))
                    self.assertEqual(self.client.post("/api/updates/install", json={}).status_code, 409)
                    install.assert_not_called()
                finally:
                    resume.set()
                self.assertEqual(pending.result(timeout=5).status_code, 200)
        self.assertEqual(server.app.state.active_media_operations, 0)


if __name__ == "__main__":
    unittest.main()
