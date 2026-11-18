"""Project source-video label validation, isolated from the user's library."""
from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import projects
from .test_projects import example_project


class SourceVideoSignalProjectTests(unittest.TestCase):
    def test_source_labels_round_trip_with_project_and_legacy_projects_still_load(self):
        legacy = example_project()
        self.assertEqual(projects.validate_project(legacy), legacy)
        project = copy.deepcopy(legacy)
        project["media"][0]["sourceSignals"] = [0, 1 / 59.94, 2.123456789, 7.999999]
        self.assertEqual(projects.validate_project(project), project)
        self.assertEqual(projects.validate_project(project)["media"][0]["sourceSignals"][2], 2.123456789)
        with tempfile.TemporaryDirectory(prefix="pulse-video-label-project-") as folder:
            directory = Path(folder) / "data" / "projects"
            with patch.object(projects, "PROJECTS", directory):
                projects.save_project(project["id"], project)
                self.assertEqual(projects.load_active_project(), project)
                saved = json.loads((directory / (project["id"] + ".pulse.json")).read_text("utf-8"))
                self.assertEqual(saved["media"][0]["sourceSignals"], project["media"][0]["sourceSignals"])

    def test_rejects_nonvideo_source_labels_even_when_the_list_is_empty(self):
        project = example_project()
        project["media"][1]["sourceSignals"] = []
        with self.assertRaisesRegex(ValueError, "only valid for video"):
            projects.validate_project(project)
        project = example_project()
        project["media"][0].update(kind="image", sourceSignals=[])
        with self.assertRaisesRegex(ValueError, "only valid for video"):
            projects.validate_project(project)

    def test_rejects_malformed_unordered_duplicate_or_eof_timestamps(self):
        for labels in (None, "1,2", [True], [-1], [8], [1, 1], [2, 1], [1, 1 + 1e-8], [float("inf")], [float("nan")]):
            with self.subTest(labels=labels):
                project = example_project()
                project["media"][0]["sourceSignals"] = labels
                with self.assertRaises(ValueError):
                    projects.validate_project(project)
        project = example_project()
        project["media"][0]["sourceSignals"] = []
        self.assertEqual(projects.validate_project(project), project)

    def test_rejects_excessive_label_lists_before_they_reach_the_timeline(self):
        project = example_project()
        project["media"][0]["sourceSignals"] = [0] * 100001
        with self.assertRaisesRegex(ValueError, "100,000"):
            projects.validate_project(project)


if __name__ == "__main__":
    unittest.main()
