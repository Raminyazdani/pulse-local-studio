"""Project validation for acoustic groups and filter/repeat marker replacements."""
from __future__ import annotations

import copy
import unittest

from .projects import validate_project
from .test_projects import example_project


def grouped_project():
    project = example_project()
    asset = project["media"][1]
    asset["beatGroups"] = [
        dict(id="group-1", label="Bass-heavy", beatIndices=[0, 2], sampleTime=.5, bassScore=.9),
        dict(id="group-2", label="Bright attack", beatIndices=[1, 3], sampleTime=1, bassScore=.1),
    ]
    project["clips"][1]["beatConfig"] = dict(every=2, offset=0, enabledGroups=[asset["id"] + ":group-1"])
    return project


class BeatToolProjectTests(unittest.TestCase):
    def test_group_membership_samples_and_filter_selection_round_trip(self):
        project = grouped_project()
        self.assertEqual(validate_project(project), project)
        project["clips"][1]["beatConfig"]["enabledGroups"] = []
        self.assertEqual(validate_project(project), project)
        legacy = example_project()
        self.assertEqual(validate_project(legacy), legacy)

    def test_rejects_invalid_or_incomplete_membership_and_samples(self):
        for changes in (
            dict(beatIndices=[0, 99]), dict(beatIndices=[0, 0]), dict(beatIndices=[True]),
            dict(beatIndices=[.5]), dict(beatIndices=[]), dict(sampleTime=1), dict(sampleTime=10),
            dict(bassScore=-1), dict(bassScore=1.1), dict(id="group-2"), dict(label=""),
        ):
            with self.subTest(changes=changes):
                project = grouped_project()
                project["media"][1]["beatGroups"][0].update(changes)
                with self.assertRaises(ValueError):
                    validate_project(project)
        project = grouped_project()
        project["media"][1]["beatGroups"].pop()
        with self.assertRaisesRegex(ValueError, "cover"):
            validate_project(project)

    def test_rejects_unsorted_times_and_malformed_checkbox_keys(self):
        project = grouped_project()
        project["media"][1]["beats"].reverse()
        with self.assertRaisesRegex(ValueError, "ordered"):
            validate_project(project)
        for keys in (None, "group-1", [True], [""], ["same", "same"]):
            project = grouped_project()
            project["clips"][1]["beatConfig"]["enabledGroups"] = keys
            with self.subTest(keys=keys), self.assertRaises(ValueError):
                validate_project(project)

    def test_replaced_empty_or_regular_beats_survive_validation(self):
        project = grouped_project()
        clip = project["clips"][1]
        clip["beatConfig"] = dict(every=1, offset=0)
        for markers in ([], [index * .5 for index in range(20)]):
            clip["beatEdits"] = markers
            self.assertEqual(validate_project(copy.deepcopy(project))["clips"][1]["beatEdits"], markers)


if __name__ == "__main__":
    unittest.main()
