"""Real HLG/PQ decode, SDR preview, render and legacy-preview upgrade checks."""
from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

import numpy as np

_temporary = tempfile.TemporaryDirectory(prefix="pulse-hdr-tests-")
os.environ["PULSE_DATA_DIR"] = _temporary.name

from .media import (MEDIA, get_media, import_media, probe, refresh_media_preview,
                    run_ffmpeg, save_metadata, sdr_color_filter)
from .render import build_command


def video_stream(path: Path) -> dict:
    return next(stream for stream in probe(path)["streams"] if stream.get("codec_type") == "video")


def first_rgb(path: Path) -> np.ndarray:
    result = run_ffmpeg(["-i", str(path), "-frames:v", "1", "-vf", "scale=160:90",
                         "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])
    return np.frombuffer(result.stdout, dtype=np.uint8).reshape(90, 160, 3).astype(float)


class HDRTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = Path(_temporary.name)
        cls.media = {}
        for transfer in ("arib-std-b67", "smpte2084", "bt709"):
            media_id = str(uuid.uuid4())
            directory = MEDIA / media_id
            directory.mkdir()
            path = directory / "original.mov"
            # Real ten-bit MOV source with known varying colors and highlights.
            # ProRes avoids a hardware/GPU requirement in these deterministic checks.
            primaries = "bt709" if transfer == "bt709" else "bt2020"
            matrix = "bt709" if transfer == "bt709" else "bt2020nc"
            run_ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x90:r=24:d=0.25",
                        "-vf", f"format=yuv422p10le,setparams=color_primaries={primaries}:color_trc={transfer}:colorspace={matrix}",
                        "-c:v", "prores_ks", "-profile:v", "3",
                        "-color_primaries", primaries, "-color_trc", transfer,
                        "-colorspace", matrix, "-color_range", "tv", str(path)])
            cls.media[transfer] = import_media(path, f"{transfer}.MOV", media_id)

    def render(self, media: dict, master: bool = False) -> Path:
        project = dict(id="hdr", name="HDR", media=[media],
                       tracks=[dict(id="v", kind="video", name="Video", hidden=False, muted=False)],
                       clips=[dict(id="clip", name="HLG", trackId="v", start=0,
                                   segments=[dict(mediaId=media["id"], **{"in": 0, "out": .25})],
                                   signals=[], muted=True, volume=1)])
        directory = self.temp / str(uuid.uuid4())
        directory.mkdir()
        command, output, _ = build_command(project, dict(width=160, height=90, fps=24,
                                                       quality="master" if master else "high",
                                                       format="mov" if master else "mp4"), directory)
        result = subprocess.run(command, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        return output

    def test_hlg_and_pq_preview_and_render_match_sdr_reference(self):
        # The reference is an explicit, independently executed FFmpeg color
        # transform. This checks decoded pixels across the entire import/render
        # path, not just the presence of a filter string.
        reference_filter = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                            "tonemap=mobius:desat=2,zscale=t=bt709:m=bt709:r=tv,"
                            "format=yuv420p,scale=160:90")
        for transfer in ("arib-std-b67", "smpte2084"):
            with self.subTest(transfer=transfer):
                media = self.media[transfer]
                stored = get_media(media["id"])
                original = MEDIA / media["id"] / stored["_original"]
                self.assertTrue(media["hdr"])
                self.assertEqual(media["sourceColorPrimaries"], "bt2020")
                self.assertEqual(media["sourceColorTransfer"], transfer)
                reference = run_ffmpeg(["-i", str(original), "-vf", reference_filter, "-frames:v", "1",
                                        "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])
                expected = np.frombuffer(reference.stdout, dtype=np.uint8).reshape(90, 160, 3).astype(float)
                proxy = MEDIA / media["id"] / stored["_proxy"]
                for output in (proxy, self.render(media), self.render(media, master=True)):
                    stream = video_stream(output)
                    self.assertEqual(stream["color_transfer"], "bt709")
                    self.assertEqual(stream["color_primaries"], "bt709")
                    self.assertEqual(stream["color_space"], "bt709")
                    self.assertLess(float(np.abs(first_rgb(output) - expected).mean()), 9)
                # Directly treating the encoded HDR numbers as SDR is visibly
                # different; a passing test must include actual tone mapping.
                self.assertGreater(float(np.abs(first_rgb(original) - expected).mean()), 10)

    def test_sdr_sources_are_not_tonemapped(self):
        media = self.media["bt709"]
        self.assertFalse(media["hdr"])
        self.assertEqual(sdr_color_filter(media), "")
        stored = get_media(media["id"])
        original = MEDIA / media["id"] / stored["_original"]
        output = self.render(media)
        self.assertLess(float(np.abs(first_rgb(output) - first_rgb(original)).mean()), 7)

    def test_legacy_hdr_preview_refresh_preserves_original_and_invalidates_cache(self):
        media = self.media["arib-std-b67"]
        stored = get_media(media["id"])
        original = MEDIA / media["id"] / stored["_original"]
        before = hashlib.sha256(original.read_bytes()).hexdigest()
        for key in list(stored):
            if key.startswith("sourceColor") or key == "hdr":
                del stored[key]
        stored.update(previewVersion=1, proxyUrl=f"/api/files/{media['id']}/proxy",
                      url=f"/api/files/{media['id']}/proxy", thumbnailUrl=f"/api/files/{media['id']}/thumbnail")
        save_metadata(stored)
        refreshed = refresh_media_preview(media["id"])
        self.assertEqual(refreshed["previewVersion"], 2)
        self.assertEqual(refreshed["sourceColorTransfer"], "arib-std-b67")
        for key in ("proxyUrl", "url", "thumbnailUrl"):
            self.assertTrue(refreshed[key].endswith("?v=2"))
        self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(), before)


if __name__ == "__main__":
    unittest.main()
