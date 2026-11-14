"""Project persistence checks that never alter the user's live media/storage."""
from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from . import projects


def example_project(project_id: str = "project-portable-test") -> dict:
    video_id = "6e92599d-d48f-4b46-a2af-a4ab76074d69"
    audio_id = "16ab3d07-06dd-4ebf-9d0d-407572dc2a74"
    return dict(
        version=1, id=project_id, name="فیلم روی بیت · portable", aspect="9:16",
        media=[dict(id=video_id, name="Sample.MOV", kind="video", duration=8,
                    hasAudio=True, width=1080, height=1920, fps=59.94, size=12345,
                    url=f"/api/files/{video_id}/proxy?v=2", proxyUrl=f"/api/files/{video_id}/proxy?v=2",
                    originalUrl=f"/api/files/{video_id}/original", thumbnailUrl=f"/api/files/{video_id}/thumbnail?v=2",
                    hdr=True, sourceColorTransfer="arib-std-b67", previewVersion=2),
               dict(id=audio_id, name="Soundtrack.mp3", kind="audio", duration=10,
                    hasAudio=True, width=0, height=0, fps=0, bpm=120,
                    url=f"/api/files/{audio_id}/proxy", originalUrl=f"/api/files/{audio_id}/original",
                    thumbnailUrl=None, beats=[.5, 1, 1.5, 2], waveform=[0, .4, 1, .2])],
        tracks=[dict(id="video-track", name="Video", kind="video", muted=False, hidden=False, locked=False),
                dict(id="audio-track", name="Soundtrack", kind="audio", muted=False, hidden=False, locked=False)],
        clips=[dict(id="merged-video", name="Merged sequence", trackId="video-track", start=.25,
                    segments=[dict(mediaId=video_id, **{"in": 1, "out": 4}, speed=1, muted=True, volume=.5),
                              dict(mediaId=video_id, **{"in": 5, "out": 7}, speed=2)],
                    signals=[.25, 1.25, 3.25], muted=False, volume=.8,
                    warp=[dict(source=0, target=0), dict(source=1, target=.5),
                          dict(source=3, target=1), dict(source=4, target=2)]),
               dict(id="music-clip", name="Music", trackId="audio-track", start=0,
                    segments=[dict(mediaId=audio_id, **{"in": 0, "out": 10})], signals=[], muted=False, volume=1,
                    beatConfig=dict(every=2, offset=1, pattern="1001"), beatEdits=[.5, 1, 1.5, 2])],
        editorMetadata={"custom": "kept", "zoom": 38},
    )


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pulse-project-store-")
        self.directory = Path(self.temp.name) / "original folder" / "data" / "projects"
        self.storage_patch = patch.object(projects, "PROJECTS", self.directory)
        self.storage_patch.start()
        self.addCleanup(self.storage_patch.stop)
        self.addCleanup(self.temp.cleanup)

    def test_full_graph_and_unknown_metadata_survive_folder_copy(self):
        project = example_project()
        result = projects.save_project(project["id"], project)
        self.assertEqual(result["id"], project["id"])
        self.assertGreater(result["updated"], 0)
        self.assertEqual(projects.load_active_project(), project)
        moved = Path(self.temp.name) / "دیسک دوم" / "Pulse Portable" / "data" / "projects"
        shutil.copytree(self.directory, moved)
        with patch.object(projects, "PROJECTS", moved):
            self.assertEqual(projects.load_active_project(), project)
            index = projects.list_projects()
            self.assertEqual(index["activeProjectId"], project["id"])
            self.assertEqual(index["projects"][0]["name"], project["name"])
            self.assertEqual(projects.load_project(project["id"])["media"][0]["sourceColorTransfer"], "arib-std-b67")
        # Saves do not reach into media or require source files to be mounted.
        self.assertFalse((self.directory.parent / "media").exists())

    def test_atomic_saves_keep_valid_previous_backup_and_recover_damage(self):
        project = example_project()
        projects.save_project(project["id"], project)
        edited = copy.deepcopy(project)
        edited["name"] = "Second edit"
        projects.save_project(edited["id"], edited)
        primary = self.directory / f"{project['id']}.pulse.json"
        backup = primary.with_name(primary.name + ".bak")
        self.assertEqual(json.loads(backup.read_text("utf-8")), project)
        self.assertEqual(projects.load_project(project["id"]), edited)
        primary.write_text('{"incomplete":', "utf-8")
        self.assertEqual(projects.load_project(project["id"]), project)
        projects.save_project(project["id"], project)
        self.assertEqual(json.loads(backup.read_text("utf-8")), project)
        self.assertEqual(json.loads(primary.read_text("utf-8")), project)
        self.assertEqual(list(self.directory.glob("*.tmp")), [])

    def test_failed_primary_replace_preserves_last_valid_project(self):
        project = example_project()
        projects.save_project(project["id"], project)
        changed = copy.deepcopy(project)
        changed["name"] = "Unsaved edit"
        original_replace = projects.os.replace

        def fail_primary(source, destination):
            if Path(destination).name == f"{project['id']}.pulse.json":
                raise OSError("Simulated storage write failure")
            return original_replace(source, destination)

        with patch.object(projects.os, "replace", side_effect=fail_primary):
            with self.assertRaises(OSError):
                projects.save_project(project["id"], changed)
        self.assertEqual(projects.load_project(project["id"]), project)
        self.assertEqual(list(self.directory.glob("*.tmp")), [])

    def test_active_selection_and_missing_state_fallback(self):
        self.assertEqual(projects.list_projects(), {"projects": [], "activeProjectId": None})
        self.assertIsNone(projects.load_active_project())
        a = example_project("project-a")
        b = example_project("project-b")
        b["name"] = "Other project"
        projects.save_project(a["id"], a)
        projects.save_project(b["id"], b)
        self.assertEqual(projects.load_active_project()["id"], b["id"])
        projects.set_active_project(a["id"])
        self.assertEqual(projects.load_active_project()["id"], a["id"])
        self.assertEqual(len(projects.list_projects()["projects"]), 2)
        (self.directory / "state.json").write_text("broken", "utf-8")
        self.assertIsNotNone(projects.load_active_project())
        with self.assertRaises(FileNotFoundError):
            projects.load_project("project-not-present")
        with self.assertRaises(FileNotFoundError):
            projects.set_active_project("project-not-present")

    def test_rejects_path_ids_and_id_mismatch_without_writing(self):
        for project_id in ("../outside", "..", "a/b", "a\\b", "C:\\test", "CON", "LPT1", "", "x" * 129):
            with self.subTest(project_id=project_id), self.assertRaises(ValueError):
                projects.save_project(project_id, example_project())
        with self.assertRaises(ValueError):
            projects.save_project("different-id", example_project())
        self.assertFalse(self.directory.exists())

    def test_rejects_malformed_graphs_flags_times_and_remote_urls(self):
        def cases():
            yield "missing media", lambda p: p["clips"][0]["segments"][0].update(mediaId="unknown")
            yield "missing track", lambda p: p["clips"][0].update(trackId="unknown")
            yield "duplicate IDs", lambda p: p["clips"].append(copy.deepcopy(p["clips"][0]))
            yield "track mismatch", lambda p: p["clips"][0].update(trackId="audio-track")
            yield "string mute", lambda p: p["clips"][0].update(muted="false")
            yield "string lock", lambda p: p["tracks"][0].update(locked="false")
            yield "bool source time", lambda p: p["clips"][0]["segments"][0].update({"in": False})
            yield "NaN in metadata", lambda p: p.update(editorMetadata={"bad": float("nan")})
            yield "infinite start", lambda p: p["clips"][0].update(start=float("inf"))
            yield "zero speed", lambda p: p["clips"][0]["segments"][0].update(speed=0)
            yield "trim outside source", lambda p: p["clips"][0]["segments"][0].update(out=9)
            yield "signal outside clip", lambda p: p["clips"][0].update(signals=[100])
            yield "warp not anchored", lambda p: p["clips"][0]["warp"][0].update(target=.1)
            yield "warp reversed", lambda p: p["clips"][0]["warp"][2].update(target=.1)
            yield "warp incomplete", lambda p: p["clips"][0]["warp"][-1].update(source=3.5)
            yield "bad mask", lambda p: p["clips"][1]["beatConfig"].update(pattern="000")
            yield "bad offset", lambda p: p["clips"][1]["beatConfig"].update(offset=2)
            yield "remote URL", lambda p: p["media"][0].update(url="https://example.com/video.mp4")
            yield "file URL", lambda p: p["media"][0].update(url="file:///C:/private.mov")
            yield "arbitrary local URL", lambda p: p["media"][0].update(url="/api/files/../../private")
            yield "unsupported version", lambda p: p.update(version=2)
            yield "boolean version", lambda p: p.update(version=True)
        for label, change in cases():
            project = example_project()
            change(project)
            with self.subTest(label=label), self.assertRaises(ValueError):
                projects.save_project(project["id"], project)
        self.assertFalse(self.directory.exists())

    def test_concurrent_saves_remain_complete_json(self):
        project = example_project()

        def save(index):
            edited = copy.deepcopy(project)
            edited["name"] = f"Edit {index}"
            projects.save_project(edited["id"], edited)

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(save, range(16)))
        loaded = projects.load_active_project()
        self.assertTrue(loaded["name"].startswith("Edit "))
        self.assertEqual(loaded["clips"], project["clips"])
        self.assertEqual(list(self.directory.glob("*.tmp")), [])
        self.assertEqual(len(projects.list_projects()["projects"]), 1)

    def test_image_hold_can_exceed_nominal_duration(self):
        project = example_project()
        asset = project["media"][0]
        asset.update(kind="image", duration=5, hasAudio=False)
        project["clips"][0].update(segments=[dict(mediaId=asset["id"], **{"in": 0, "out": 30})],
                                    signals=[], warp=[])
        projects.save_project(project["id"], project)
        self.assertEqual(projects.load_project(project["id"])["clips"][0]["segments"][0]["out"], 30)

    def test_http_routes_roundtrip_select_and_preserve_state_on_invalid_write(self):
        from fastapi.testclient import TestClient
        from .app import app

        client = TestClient(app)
        self.assertEqual(client.get("/api/projects/active").json(), {"project": None})
        project = example_project("project-http-roundtrip")
        saved = client.put(f"/api/projects/{project['id']}", json=project)
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["id"], project["id"])
        self.assertEqual(client.get("/api/projects/active").json(), {"project": project})
        self.assertEqual(client.get(f"/api/projects/{project['id']}").json(), {"project": project})
        listed = client.get("/api/projects").json()
        self.assertEqual(listed["activeProjectId"], project["id"])
        self.assertEqual(listed["projects"][0]["name"], project["name"])

        other = example_project("project-http-other")
        self.assertEqual(client.put(f"/api/projects/{other['id']}", json=other).status_code, 200)
        self.assertEqual(client.get("/api/projects/active").json()["project"]["id"], other["id"])
        self.assertEqual(client.post("/api/projects/active", json={"id": project["id"]}).status_code, 200)
        self.assertEqual(client.get("/api/projects/active").json()["project"]["id"], project["id"])

        invalid = copy.deepcopy(project)
        invalid["clips"][0]["warp"][1]["target"] = 0
        self.assertEqual(client.put(f"/api/projects/{project['id']}", json=invalid).status_code, 400)
        self.assertEqual(client.put("/api/projects/different-id", json=project).status_code, 400)
        self.assertEqual(client.put(f"/api/projects/{project['id']}", content="broken json").status_code, 400)
        self.assertEqual(client.get("/api/projects/not-present").status_code, 404)
        self.assertEqual(client.post("/api/projects/active", json={"id": "not-present"}).status_code, 404)
        self.assertEqual(client.get("/api/projects/active").json(), {"project": project})
        self.assertEqual(client.get(f"/api/projects/{project['id']}").json(), {"project": project})

        with self.assertLogs("pulse.projects", level="WARNING"), patch.object(projects, "_atomic_bytes", side_effect=OSError("Drive is unavailable")):
            self.assertEqual(client.put(f"/api/projects/{project['id']}", json=project).status_code, 507)
        self.assertEqual(projects.load_project(project["id"]), project)

    def test_export_download_resolves_inside_relocated_folder(self):
        from fastapi.testclient import TestClient
        from . import app as app_module
        from . import render

        job_id = str(uuid.uuid4())
        moved_data = Path(self.temp.name) / "USB copy" / "Pulse" / "data"
        export_directory = moved_data / "exports" / job_id
        export_directory.mkdir(parents=True)
        output = export_directory / "Pulse-export.mp4"
        contents = b"Portable export fixture bytes"
        output.write_bytes(contents)
        stale_path = Path(self.temp.name) / "previous drive" / "data" / "exports" / job_id / output.name
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_text("Must not be served", "utf-8")
        job = dict(id=job_id, status="complete", progress=1, _path=str(stale_path))
        client = TestClient(app_module.app)
        with patch.object(app_module, "DATA", moved_data), patch.dict(render.JOBS, {job_id: job}, clear=True):
            response = client.get(f"/api/export/{job_id}/download")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, contents)
            self.assertIn(output.name, response.headers["content-disposition"])
            job["_path"] = str(outside)
            self.assertEqual(client.get(f"/api/export/{job_id}/download").status_code, 404)


if __name__ == "__main__":
    unittest.main()
