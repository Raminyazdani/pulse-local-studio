"""Reversible source-range persistence checks, isolated from the personal library."""
from __future__ import annotations

import copy
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

from . import projects


def source_project() -> dict:
    return {
        "id": "retained-edit", "name": "Trim then restore", "version": 1, "aspect": "16:9",
        "media": [
            {"id": "video-a", "name": "A.mov", "kind": "video", "duration": 12, "hasAudio": True, "url": "/api/files/video-a/proxy"},
            {"id": "video-b", "name": "B.mov", "kind": "video", "duration": 12, "hasAudio": True, "url": "/api/files/video-b/proxy"},
            {"id": "audio", "name": "Beat.wav", "kind": "audio", "duration": 20, "hasAudio": True, "url": "/api/files/audio/proxy"},
        ],
        "tracks": [{"id": "video-track", "name": "Video", "kind": "video", "muted": False, "hidden": False, "locked": False}],
        "clips": [{
            "id": "clip", "name": "Cropped merged clip", "trackId": "video-track", "start": 3,
            "segments": [{"mediaId": "video-b", "in": 2, "out": 6, "speed": 2}],
            "signals": [.5], "beatEdits": [.2, .8], "muted": False, "volume": .8,
            "editSource": {
                "segments": [{"mediaId": "video-a", "in": 0, "out": 4, "speed": 1, "muted": True, "volume": .4},
                             {"mediaId": "video-b", "in": 0, "out": 8, "speed": 2}],
                "signals": [1, 5.5, 7], "beatEdits": [.3, 2, 5.2, 5.8, 7.5],
            },
            "sourceWindow": {"in": 5, "out": 7},
        }],
    }


class RetainedSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pulse-source-window-")
        self.root = Path(self.temporary.name)
        self.directory = self.root / "Before" / "data" / "projects"
        self.storage = patch.object(projects, "PROJECTS", self.directory)
        self.storage.start()
        self.addCleanup(self.storage.stop)
        self.addCleanup(self.temporary.cleanup)

    def test_real_api_roundtrip_and_folder_copy_keep_the_complete_restore_source(self):
        from fastapi.testclient import TestClient
        from .app import app

        original = source_project()
        with TestClient(app) as client:
            response = client.put("/api/projects/retained-edit", json=original)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(client.get("/api/projects/active").json()["project"], original)
        moved = self.root / "دیسک دوم" / "Pulse folder" / "data" / "projects"
        shutil.copytree(self.directory, moved)
        with patch.object(projects, "PROJECTS", moved):
            loaded = projects.load_active_project()
            self.assertEqual(loaded, original)
            # Restoring the saved full composition requires no original edit
            # session/browser state: all hidden spans and markers are on disk.
            restored = copy.deepcopy(loaded)
            clip = restored["clips"][0]
            clip.update(segments=clip["editSource"]["segments"], signals=clip["editSource"]["signals"],
                        beatEdits=clip["editSource"]["beatEdits"], sourceWindow={"in": 0, "out": 8}, start=0)
            projects.save_project(restored["id"], restored)
            self.assertEqual(projects.load_active_project()["clips"][0]["segments"][0]["mediaId"], "video-a")
            self.assertEqual(projects.load_active_project()["clips"][0]["signals"], [1, 5.5, 7])

    def test_invalid_source_metadata_never_overwrites_a_valid_disk_project(self):
        original = source_project()
        projects.save_project(original["id"], original)
        primary = self.directory / "retained-edit.pulse.json"
        previous = primary.read_bytes()
        malformed = []
        for patch_value in [
            {"sourceWindow": None}, {"sourceWindow": {"in": -1, "out": 1}},
            {"sourceWindow": {"in": 5, "out": 4}}, {"sourceWindow": {"in": 8, "out": 10}},
            {"sourceWindow": {"in": 0, "out": 3}}, {"editSource": None},
        ]:
            value = copy.deepcopy(original)
            value["clips"][0].update(patch_value)
            malformed.append(value)
        for key in ("editSource", "sourceWindow"):
            value = copy.deepcopy(original); del value["clips"][0][key]; malformed.append(value)
        for segment_patch in [
            {"mediaId": "missing"}, {"mediaId": "audio"}, {"in": -1}, {"out": 30},
            {"speed": 0}, {"speed": False}, {"muted": "yes"}, {"volume": -1},
        ]:
            value = copy.deepcopy(original)
            value["clips"][0]["editSource"]["segments"][0].update(segment_patch)
            malformed.append(value)
        for signal_patch in [{"signals": [100]}, {"beatEdits": [-1]}, {"warp": []}]:
            value = copy.deepcopy(original); value["clips"][0]["editSource"].update(signal_patch); malformed.append(value)
        for value in malformed:
            with self.subTest(value=value["clips"][0]):
                with self.assertRaises(ValueError):
                    projects.save_project(value["id"], value)
                self.assertEqual(primary.read_bytes(), previous)
        self.assertEqual(projects.load_active_project(), original)

    def test_api_refuses_a_bad_hidden_range_without_changing_the_active_project(self):
        from fastapi.testclient import TestClient
        from .app import app

        original = source_project()
        with TestClient(app) as client:
            self.assertEqual(client.put("/api/projects/retained-edit", json=original).status_code, 200)
            broken = copy.deepcopy(original)
            broken["clips"][0]["editSource"]["segments"][1]["speed"] = 0
            response = client.put("/api/projects/retained-edit", json=broken)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(client.get("/api/projects/active").json()["project"], original)

    def test_legacy_clips_and_new_warped_source_windows_both_remain_valid(self):
        legacy = source_project()
        del legacy["clips"][0]["editSource"]
        del legacy["clips"][0]["sourceWindow"]
        self.assertEqual(projects.validate_project(legacy), legacy)
        warped = source_project()
        clip = warped["clips"][0]
        clip["warp"] = [{"source": 0, "target": 0}, {"source": 1, "target": .25}, {"source": 2, "target": 1}]
        clip["sourceWindow"] = {"in": 5, "out": 6}
        self.assertEqual(projects.validate_project(warped), warped)
        image = source_project()
        image["media"][0].update(kind="image", duration=5, hasAudio=False)
        clip = image["clips"][0]
        clip.update(segments=[{"mediaId": "video-a", "in": 2, "out": 8}], signals=[], beatEdits=[],
                    editSource={"segments": [{"mediaId": "video-a", "in": 0, "out": 30}], "signals": []},
                    sourceWindow={"in": 2, "out": 8})
        self.assertEqual(projects.validate_project(image), image)

    def test_renderer_uses_only_visible_spans_even_when_hidden_sources_are_offline(self):
        from . import media, render

        library = self.root / "isolated-media"
        media_id = str(uuid.uuid4())
        directory = library / media_id
        directory.mkdir(parents=True)
        source = directory / "original.mov"
        with patch.object(media, "MEDIA", library):
            media.run_ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
            asset = media.import_media(source, "Red.mov", media_id)
            value = source_project()
            value["media"] = [asset, value["media"][1]]
            clip = value["clips"][0]
            clip.update(start=0, segments=[{"mediaId": media_id, "in": .5, "out": 1.5}], signals=[], beatEdits=[],
                        editSource={"segments": [{"mediaId": media_id, "in": 0, "out": 2}, {"mediaId": "video-b", "in": 0, "out": 2}], "signals": []},
                        sourceWindow={"in": .5, "out": 1.5})
            projects.validate_project(value)
            output_directory = self.root / "render"
            output_directory.mkdir()
            command, output, duration = render.build_command(value, {"width": 160, "height": 90, "fps": 30, "quality": "high", "format": "mp4"}, output_directory)
            subprocess.run(command, check=True, capture_output=True, creationflags=media.CREATE_FLAGS)
            self.assertAlmostEqual(duration, 1)
            self.assertAlmostEqual(float(media.probe(output)["format"]["duration"]), 1, delta=.05)
            pixel = media.run_ffmpeg(["-ss", "0.5", "-i", str(output), "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]).stdout
            self.assertGreater(pixel[0], 200)
            self.assertLess(pixel[2], 30)


if __name__ == "__main__":
    unittest.main()
