"""Integration checks against real FFmpeg (python -m unittest backend.test_backend)."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import unittest
import uuid
import wave
from pathlib import Path

import numpy as np

_temporary = tempfile.TemporaryDirectory(prefix="pulse-backend-tests-")
os.environ["PULSE_DATA_DIR"] = _temporary.name

from .media import MEDIA, analyze_media, detect_beats, get_media, import_media, probe, run_ffmpeg
from .render import audio_pieces, build_command, mapped_time, validate_project


class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = Path(_temporary.name)
        cls.media_id = str(uuid.uuid4())
        directory = MEDIA / cls.media_id
        directory.mkdir()
        original = directory / "original.mp4"
        run_ffmpeg([
            "-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=1",
            "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=1",
            "-f", "lavfi", "-i", "color=c=green:s=160x90:r=30:d=1",
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=3",
            "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
            "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", str(original),
        ])
        cls.media = import_media(original, "Color changes.mp4", cls.media_id)
        cls.clip = dict(id="clip", name="Test", trackId="video", start=0,
                        segments=[dict(mediaId=cls.media_id, **{"in": 0, "out": 3})],
                        signals=[1, 2], muted=True, volume=1,
                        warp=[dict(source=0,target=0),dict(source=1,target=.5),
                              dict(source=2,target=2),dict(source=3,target=3)])
        cls.project = dict(id="test", name="Test", media=[cls.media],
                           tracks=[dict(id="video", name="Video", kind="video", muted=False, hidden=False)],
                           clips=[cls.clip])

    def test_kick_detection_counts_and_timestamps(self):
        sample_rate = 22050
        samples = np.zeros(sample_rate*8)
        time = np.arange(int(.12*sample_rate))/sample_rate
        kick = np.sin(2*np.pi*70*time)*np.exp(-time*35)
        expected = np.arange(.5,7.6,.5)
        for beat in expected:
            offset = round(beat*sample_rate)
            samples[offset:offset+len(kick)] = kick
        beats, bpm = detect_beats(samples)
        self.assertEqual(len(beats), len(expected))
        self.assertLess(float(np.max(np.abs(np.array(beats)-expected))), .01)
        self.assertLess(abs(bpm-120), .5)
        self.assertEqual(detect_beats(np.zeros(sample_rate)), ([], None))

    def test_warp_audio_slices_follow_exact_targets(self):
        pieces = list(audio_pieces(self.clip))
        self.assertEqual(len(pieces), 3)
        self.assertEqual([p[3:] for p in pieces], [(0,.5),(.5,2),(2,3)])
        self.assertEqual([p[1:3] for p in pieces], [(0,1),(1,2),(2,3)])

    def test_original_retained_and_proxy_separate(self):
        media = get_media(self.media_id)
        self.assertEqual(media["_original"], "original.mp4")
        self.assertNotEqual(media["_original"], media["_proxy"])
        self.assertTrue((MEDIA/self.media_id/media["_proxy"]).is_file())

    def test_actual_warp_render_color_boundaries_and_mute(self):
        directory = self.temp / "render"
        directory.mkdir(exist_ok=True)
        command, output, duration = build_command(self.project, dict(width=160,height=90,fps=30), directory)
        completed = subprocess.run(command, capture_output=True, timeout=90)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
        self.assertLess(abs(float(probe(output)["format"]["duration"])-3), .04)
        expected = { .4:0, .6:2, 1.9:2, 2.1:1 }
        for at, channel in expected.items():
            decoded = run_ffmpeg(["-ss",str(at),"-i",str(output),"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"])
            frame = np.frombuffer(decoded.stdout,dtype=np.uint8).reshape(90,160,3)
            self.assertEqual(int(frame.mean(axis=(0,1)).argmax()),channel,f"Wrong color at {at}")
        decoded = run_ffmpeg(["-i",str(output),"-vn","-f","f32le","-ac","1","pipe:1"])
        self.assertLess(float(np.max(np.abs(np.frombuffer(decoded.stdout,dtype="<f4")))),1e-6)

    def test_validation_rejects_missing_ids_and_nonmonotonic_warp(self):
        bad = json.loads(json.dumps(self.project))
        bad["clips"][0]["warp"][1]["target"] = -1
        with self.assertRaisesRegex(ValueError,"increase"):
            validate_project(bad,{})
        bad["clips"][0]["segments"][0]["mediaId"] = "../../secret"
        with self.assertRaises(FileNotFoundError):
            validate_project(bad,{})

    def test_http_upload_analyze_range_and_async_export(self):
        from fastapi.testclient import TestClient
        from .app import app
        with TestClient(app) as client:
            self.assertTrue(client.get("/api/health").json()["ok"])
            sample_rate = 22050
            samples = np.zeros(sample_rate*2)
            time_axis = np.arange(int(.1*sample_rate))/sample_rate
            kick = np.sin(2*np.pi*65*time_axis)*np.exp(-time_axis*40)*.8
            for at in (.3,.8,1.3,1.8):
                offset=round(at*sample_rate)
                samples[offset:offset+len(kick)]=kick
            path=self.temp/"kicks.wav"
            with wave.open(str(path),"wb") as audio:
                audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(sample_rate)
                audio.writeframes((samples*32767).astype("<i2").tobytes())
            with path.open("rb") as uploaded:
                response=client.post("/api/media",files=[("files",("kicks.wav",uploaded,"audio/wav"))])
            self.assertEqual(response.status_code,200,response.text)
            media=response.json()["media"][0]
            analyzed=client.post(f"/api/analyze/{media['id']}",json={"sensitivity":1,"minInterval":.2})
            self.assertEqual(analyzed.status_code,200,analyzed.text)
            self.assertEqual(len(analyzed.json()["beats"]),4)
            ranged=client.get(media["originalUrl"],headers={"Range":"bytes=0-31"})
            self.assertEqual(ranged.status_code,206)
            self.assertEqual(len(ranged.content),32)
            response=client.post("/api/export",json={"project":self.project,"settings":{"width":160,"height":90,"fps":30}})
            self.assertEqual(response.status_code,200,response.text)
            job_id=response.json()["id"]
            deadline=time.monotonic()+30
            while time.monotonic()<deadline:
                job=client.get(f"/api/export/{job_id}").json()
                if job["status"] in ("complete","error"):
                    break
                time.sleep(.05)
            self.assertEqual(job["status"],"complete",job)
            self.assertTrue(client.get(job["url"]).content)

    def test_master_mov_output_and_unmuted_audio(self):
        project=json.loads(json.dumps(self.project))
        project["clips"][0]["muted"]=False
        directory=self.temp/"master"
        directory.mkdir(exist_ok=True)
        command,output,_=build_command(project,dict(width=160,height=90,fps=30,quality="master",format="mov"),directory)
        completed=subprocess.run(command,capture_output=True,timeout=90)
        self.assertEqual(completed.returncode,0,completed.stderr.decode(errors="replace"))
        streams=probe(output)["streams"]
        self.assertEqual(streams[0]["codec_name"],"prores")
        self.assertEqual(streams[0]["pix_fmt"],"yuv422p10le")
        self.assertEqual(streams[1]["codec_name"],"pcm_s24le")
        decoded=run_ffmpeg(["-i",str(output),"-vn","-f","f32le","-ac","1","pipe:1"])
        self.assertGreater(float(np.max(np.abs(np.frombuffer(decoded.stdout,dtype="<f4")))),.01)

    def test_image_top_layer_and_compound_source_trim(self):
        image_id=str(uuid.uuid4())
        image_dir=MEDIA/image_id
        image_dir.mkdir()
        image_path=image_dir/"original.png"
        run_ffmpeg(["-f","lavfi","-i","color=c=yellow:s=160x90:d=0.1","-frames:v","1","-update","1",str(image_path)])
        image=import_media(image_path,"Yellow.png",image_id)
        project=json.loads(json.dumps(self.project))
        project["media"].append(image)
        project["tracks"].insert(0,dict(id="top",name="Top",kind="video",hidden=False,muted=False))
        bottom=project["clips"][0]
        bottom.pop("warp")
        bottom["segments"]=[dict(mediaId=self.media_id,**{"in":0,"out":1}),
                            dict(mediaId=self.media_id,**{"in":2,"out":3},speed=2)]
        project["clips"].append(dict(id="image",name="Image",trackId="top",start=.75,
                                    segments=[dict(mediaId=image_id,**{"in":0,"out":.2})],signals=[],muted=True,volume=1))
        directory=self.temp/"compound"
        directory.mkdir()
        command,output,duration=build_command(project,dict(width=160,height=90,fps=30),directory)
        completed=subprocess.run(command,capture_output=True,timeout=90)
        self.assertEqual(completed.returncode,0,completed.stderr.decode(errors="replace"))
        self.assertEqual(duration,1.5)
        for at,expected in ((.1,"red"),(.8,"yellow"),(1.2,"green")):
            decoded=run_ffmpeg(["-ss",str(at),"-i",str(output),"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"])
            colors=np.frombuffer(decoded.stdout,dtype=np.uint8).reshape(-1,3).mean(axis=0)
            if expected=="yellow":
                self.assertGreater(colors[0],150); self.assertGreater(colors[1],150); self.assertLess(colors[2],20)
            else:
                self.assertEqual(int(colors.argmax()),0 if expected=="red" else 1)


if __name__ == "__main__":
    unittest.main()
