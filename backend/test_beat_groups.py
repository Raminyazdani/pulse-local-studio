"""Acoustic beat grouping against synthetic physical attacks and real WAV import."""
from __future__ import annotations

import tempfile
import unittest
import uuid
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

from . import media as media_module
from .media import analyze_media, detect_beats, get_media, group_beats, import_media, public_media
from .projects import validate_project


RATE = 22050


def percussion_fixture() -> tuple[np.ndarray, np.ndarray]:
    """Quiet low kicks, loud noise attacks and high-pass hats at known times."""
    random = np.random.default_rng(123)
    samples = np.zeros(RATE * 6)
    kicks = np.arange(.5, 5.6, .5)

    def add(at: float, sound: np.ndarray):
        start = round(at * RATE)
        samples[start:start + len(sound)] += sound[:len(samples) - start]

    t = np.arange(round(.14 * RATE)) / RATE
    kick = .08 * np.sin(2 * np.pi * (75 * t - 40 * t * t)) * np.exp(-t * 30)
    for at in kicks:
        add(at, kick)
    t = np.arange(round(.075 * RATE)) / RATE
    snare = random.normal(0, .6, len(t)) * np.exp(-t * 45)
    for at in np.arange(.75, 5.6, 1):
        add(at, snare)
    t = np.arange(round(.04 * RATE)) / RATE
    hat = np.diff(np.r_[0, random.normal(0, .5, len(t))]) * np.exp(-t * 100)
    for at in np.arange(.25, 5.8, .5):
        add(at, hat)
    return samples, kicks


class AcousticBeatTests(unittest.TestCase):
    def test_quiet_bass_hits_survive_louder_interleaved_percussion(self):
        samples, expected_kicks = percussion_fixture()
        beats, _ = detect_beats(samples)
        self.assertGreater(len(beats), len(expected_kicks))
        for expected in expected_kicks:
            self.assertLess(min(abs(beat - expected) for beat in beats), .012)

    def test_groups_partition_hits_and_isolate_the_known_bass_pulses(self):
        samples, expected_kicks = percussion_fixture()
        beats, _ = detect_beats(samples)
        groups = group_beats(samples, beats)
        self.assertGreaterEqual(len(groups), 3)
        self.assertLessEqual(len(groups), 6)
        indices = [index for group in groups for index in group["beatIndices"]]
        self.assertEqual(sorted(indices), list(range(len(beats))))
        self.assertEqual(len(indices), len(set(indices)))
        bass = max(groups, key=lambda group: group["bassScore"])
        self.assertIn("Bass-heavy", bass["label"])
        self.assertGreater(bass["bassScore"], .75)
        bass_times = np.array([beats[index] for index in bass["beatIndices"]])
        self.assertEqual(len(bass_times), len(expected_kicks))
        self.assertLess(float(np.max(np.abs(bass_times - expected_kicks))), .012)
        for group in groups:
            self.assertEqual(group["beatIndices"], sorted(group["beatIndices"]))
            self.assertGreaterEqual(group["sampleTime"], 0)
            self.assertLess(group["sampleTime"], len(samples) / RATE)
            self.assertIn(group["sampleTime"], [beats[index] for index in group["beatIndices"]])
            self.assertGreaterEqual(group["bassScore"], 0)
            self.assertLessEqual(group["bassScore"], 1)

    def test_same_sound_with_different_loudness_stays_together(self):
        samples = np.zeros(RATE * 4)
        t = np.arange(round(.12 * RATE)) / RATE
        sound = np.sin(2 * np.pi * 70 * t) * np.exp(-t * 35)
        for at, gain in zip([.5, 1, 1.5, 2, 2.5, 3], [.9, .12, .5, .08, .65, .2]):
            start = round(at * RATE)
            samples[start:start + len(sound)] = sound * gain
        beats, _ = detect_beats(samples)
        self.assertEqual(len(beats), 6)
        self.assertEqual(len(group_beats(samples, beats)), 1)

    def test_bass_is_not_suppressed_by_a_nearby_bright_stream(self):
        samples = np.zeros(RATE * 3)
        t = np.arange(round(.1 * RATE)) / RATE
        kick = .08 * np.sin(2 * np.pi * 70 * t) * np.exp(-t * 35)
        bright = .7 * np.sin(2 * np.pi * 7000 * t) * np.exp(-t * 100)
        for at in [.5, 1, 1.5, 2, 2.5]:
            start = round(at * RATE)
            samples[start:start + len(kick)] += kick
            earlier = round((at - .085) * RATE)
            samples[earlier:earlier + len(bright)] += bright
        beats, _ = detect_beats(samples, min_interval=.2)
        for expected in [.5, 1, 1.5, 2, 2.5]:
            self.assertLess(min(abs(beat - expected) for beat in beats), .012)
        self.assertGreaterEqual(len(beats), 10)

    def test_groups_are_deterministic_and_do_not_change_detected_times(self):
        samples, _ = percussion_fixture()
        beats, _ = detect_beats(samples)
        original = list(beats)
        groups = group_beats(samples, beats)
        self.assertEqual(groups, group_beats(samples, beats))
        self.assertEqual(beats, original)

    def test_silence_and_empty_input_do_not_invent_a_grid_or_groups(self):
        self.assertEqual(detect_beats(np.zeros(RATE)), ([], None))
        self.assertEqual(group_beats(np.zeros(RATE), []), [])
        self.assertEqual(group_beats(np.array([]), []), [])

    def test_representative_near_file_end_remains_an_exact_valid_member(self):
        # A valid source timestamp can be less than one decoded sample before
        # EOF. Moving its representative backwards by a sample breaks both
        # project codecs' requirement that the sample reference a group member.
        beats = [.999999]
        groups = group_beats(np.ones(RATE), beats)
        self.assertEqual(groups[0]["sampleTime"], beats[0])
        media_id = str(uuid.uuid4())
        project = {
            "id": "end-beat", "name": "End beat", "version": 1,
            "media": [{"id": media_id, "name": "Tail.wav", "kind": "audio", "duration": 1,
                       "hasAudio": True, "url": f"/api/files/{media_id}/proxy", "beats": beats,
                       "beatGroups": groups}],
            "tracks": [], "clips": [],
        }
        self.assertEqual(validate_project(project)["media"][0]["beatGroups"], groups)


class AnalysisGroupPersistenceTests(unittest.TestCase):
    def test_real_wav_analysis_persists_groups_and_returns_public_metadata(self):
        samples, _ = percussion_fixture()
        with tempfile.TemporaryDirectory(prefix="pulse-beat-groups-") as folder:
            library = Path(folder) / "media"
            library.mkdir()
            media_id = str(uuid.uuid4())
            directory = library / media_id
            directory.mkdir()
            path = directory / "original.wav"
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(RATE)
                wav.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
            with patch.object(media_module, "MEDIA", library):
                imported = import_media(path, "Synthetic quiet bass and percussion.wav", media_id)
                response = analyze_media(media_id)
                stored = get_media(media_id)
                self.assertIn("beats", response)
                self.assertIn("bpm", response)
                self.assertIn("waveform", response)
                self.assertEqual(response["beatGroups"], stored["beatGroups"])
                self.assertEqual(response["beatGroups"], public_media(stored)["beatGroups"])
                self.assertGreaterEqual(len(response["beatGroups"]), 3)
                self.assertTrue((directory / stored["_original"]).is_file())
                self.assertNotEqual(stored["_original"], stored["_proxy"])
                self.assertEqual(imported["id"], media_id)
                self.assertFalse(any(key.startswith("_") for key in public_media(stored)))


if __name__ == "__main__":
    unittest.main()
