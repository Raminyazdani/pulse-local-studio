"""Frame-accurate original-media rendering with piecewise source-time warping."""
from __future__ import annotations

import bisect
import json
import math
import os
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .media import CREATE_FLAGS, EXPORTS, ensure_color_metadata, get_media, original_path, sdr_color_filter

JOBS: dict[str, dict] = {}
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pulse-render")
LOCK = threading.Lock()


def finite(value, label: str) -> float:
    try:
        number = float(value)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"{label} must be a number.") from exc
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite.")
    return number


def source_duration(clip: dict) -> float:
    return sum((finite(segment["out"], "Segment out") - finite(segment["in"], "Segment in")) /
               finite(segment.get("speed", 1), "Speed") for segment in clip["segments"])


def warp_points(clip: dict) -> list[dict]:
    duration = source_duration(clip)
    points = clip.get("warp") or [{"source": 0, "target": 0}, {"source": duration, "target": duration}]
    if len(points) < 2:
        raise ValueError("A speed map needs at least two points.")
    points = [{"source": finite(p["source"], "Warp source"), "target": finite(p["target"], "Warp target")}
              for p in points]
    if abs(points[0]["source"]) > 1e-6 or abs(points[0]["target"]) > 1e-6:
        raise ValueError("Speed maps must start at source 0 and target 0.")
    if abs(points[-1]["source"] - duration) > .0001:
        raise ValueError("Speed map endpoint does not match clip source duration.")
    for left, right in zip(points, points[1:]):
        if right["source"] <= left["source"] or right["target"] <= left["target"]:
            raise ValueError("Speed-map points must increase in both source and target time.")
        ratio = (right["source"] - left["source"]) / (right["target"] - left["target"])
        if ratio < .01 or ratio > 100:
            raise ValueError("Speed must remain between 0.01x and 100x.")
    return points


def mapped_time(value: float, points: list[dict]) -> float:
    index = max(0, min(len(points)-2, bisect.bisect_right([p["source"] for p in points], value)-1))
    left, right = points[index:index+2]
    return left["target"] + (value-left["source"]) * (right["target"]-left["target"]) / (right["source"]-left["source"])


def mapped_expression(expression: str, points: list[dict]) -> str:
    formulas = []
    for left, right in zip(points, points[1:]):
        slope = (right["target"]-left["target"]) / (right["source"]-left["source"])
        formulas.append(f"({left['target']:.12f}+(({expression})-{left['source']:.12f})*{slope:.12f})")
    result = formulas[-1]
    for index in range(len(formulas)-2, -1, -1):
        result = f"if(lte({expression},{points[index+1]['source']:.12f}),{formulas[index]},{result})"
    return result


def audio_pieces(clip: dict):
    points = warp_points(clip)
    canonical = 0.
    for segment in clip["segments"]:
        speed = float(segment.get("speed", 1))
        duration = (float(segment["out"])-float(segment["in"])) / speed
        cuts = [canonical] + [p["source"] for p in points if canonical < p["source"] < canonical+duration] + [canonical+duration]
        for left, right in zip(cuts, cuts[1:]):
            target_start, target_end = mapped_time(left, points), mapped_time(right, points)
            media_start = float(segment["in"]) + (left-canonical)*speed
            media_end = float(segment["in"]) + (right-canonical)*speed
            yield segment, media_start, media_end, target_start, target_end
        canonical += duration


def atempo_chain(rate: float) -> str:
    filters = []
    while rate < .5:
        filters.append("atempo=0.5")
        rate /= .5
    while rate > 2:
        filters.append("atempo=2")
        rate /= 2
    filters.append(f"atempo={rate:.12f}")
    return ",".join(filters)


def validate_project(project: dict, settings: dict) -> tuple[dict, float]:
    if not isinstance(project, dict) or not isinstance(project.get("clips"), list) or not isinstance(project.get("tracks"), list):
        raise ValueError("A project must contain tracks and clips.")
    if not project["clips"]:
        raise ValueError("Add at least one clip before exporting.")
    if len(project["clips"]) > 2000:
        raise ValueError("This project exceeds the 2,000 clip limit.")
    tracks = {track["id"]: track for track in project["tracks"]}
    maximum = 0.
    for clip in project["clips"]:
        if clip.get("trackId") not in tracks:
            raise ValueError("A clip references a missing track.")
        start = finite(clip.get("start", 0), "Clip start")
        if start < -1e-6:
            raise ValueError("Clip start cannot be negative.")
        if not clip.get("segments"):
            raise ValueError("Clips need at least one source segment.")
        if not 0 <= finite(clip.get("volume", 1), "Volume") <= 4:
            raise ValueError("Clip volume must be between 0 and 4.")
        for segment in clip["segments"]:
            media = get_media(segment["mediaId"])
            segment_in, segment_out = finite(segment["in"], "Segment in"), finite(segment["out"], "Segment out")
            speed = finite(segment.get("speed", 1), "Segment speed")
            if speed < .01 or speed > 100 or segment_in < 0 or segment_out <= segment_in:
                raise ValueError("Invalid source trim or speed.")
            if media["kind"] != "image" and segment_out > media["duration"]+.05:
                raise ValueError(f"A source trim exceeds the duration of {media['name']}.")
            if not 0 <= finite(segment.get("volume", 1), "Segment volume") <= 16:
                raise ValueError("Segment volume must be between 0 and 16.")
        maximum = max(maximum, start + warp_points(clip)[-1]["target"])
    if maximum <= 0 or maximum > 86400:
        raise ValueError("Export duration must be greater than zero and shorter than 24 hours.")
    width = int(finite(settings.get("width", 1920), "Width"))
    height = int(finite(settings.get("height", 1080), "Height"))
    fps = finite(settings.get("fps", 30), "Frame rate")
    if not (16 <= width <= 7680 and 16 <= height <= 7680 and width % 2 == 0 and height % 2 == 0):
        raise ValueError("Export dimensions must be even numbers between 16 and 7680.")
    if not (1 <= fps <= 120):
        raise ValueError("Export frame rate must be between 1 and 120.")
    format_ = settings.get("format", "mp4")
    quality = settings.get("quality", "high")
    if format_ not in ("mp4", "mov") or quality not in ("high", "master"):
        raise ValueError("Unsupported format or quality.")
    return dict(width=width, height=height, fps=fps, format=format_, quality=quality), maximum


def build_command(project: dict, settings: dict, directory: Path) -> tuple[list[str], Path, float]:
    settings, duration = validate_project(project, settings)
    width, height, fps = settings["width"], settings["height"], settings["fps"]
    master = settings["quality"] == "master" and settings["format"] == "mov"
    pixel = "yuv422p10le" if master else "yuv420p"
    output = directory / f"Pulse-export.{settings['format']}"
    arguments = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin", "-y"]
    inputs: dict[str, int] = {}
    media_by_id = {}
    for clip in project["clips"]:
        for segment in clip["segments"]:
            media_id = segment["mediaId"]
            if media_id in inputs:
                continue
            media = ensure_color_metadata(get_media(media_id))
            media_by_id[media_id] = media
            inputs[media_id] = len(inputs)
            if media["kind"] == "image":
                arguments.extend(["-loop", "1", "-framerate", str(fps)])
            arguments.extend(["-i", str(original_path(media_id))])
    graph = [f"color=c=black:s={width}x{height}:r={fps}:d={duration:.12f},format={pixel}[base]",
             f"anullsrc=r=48000:cl=stereo,atrim=duration={duration:.12f}[silence]"]
    tracks = {track["id"]: track for track in project["tracks"]}
    ordering = {track["id"]: index for index, track in enumerate(project["tracks"])}
    # First track is the top layer, so construct lower layers first.
    visual_clips = sorted(project["clips"], key=lambda clip: (-ordering[clip["trackId"]], clip["start"]))
    composite = "base"
    visual_count = 0
    for clip in visual_clips:
        track = tracks[clip["trackId"]]
        if track.get("kind") != "video" or track.get("hidden"):
            continue
        points = warp_points(clip)
        canonical = 0.
        for segment in clip["segments"]:
            media = media_by_id[segment["mediaId"]]
            speed = float(segment.get("speed", 1))
            length = (float(segment["out"])-float(segment["in"])) / speed
            if media["kind"] == "audio":
                canonical += length
                continue
            index = inputs[segment["mediaId"]]
            local_source = f"((PTS-STARTPTS)*TB/{speed:.12f}+{canonical:.12f})"
            mapping = mapped_expression(local_source, points)
            start = float(clip["start"]) + mapped_time(canonical, points)
            end = float(clip["start"]) + mapped_time(canonical+length, points)
            label = f"visual{visual_count}"
            next_composite = f"composite{visual_count}"
            graph.append(f"[{index}:v:0]trim=start={segment['in']:.12f}:end={segment['out']:.12f},"
                         f"settb=AVTB,tpad=stop_mode=clone:stop_duration=0.25,"
                         f"setpts='({mapping}+{float(clip['start']):.12f})/TB',"
                         f"{sdr_color_filter(media, pixel)}"
                         f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                         f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format={pixel}[{label}]")
            graph.append(f"[{composite}][{label}]overlay=0:0:eof_action=pass:repeatlast=0:format=auto:"
                         f"enable='gte(t,{start:.12f})*lt(t,{end:.12f})'[{next_composite}]")
            composite = next_composite
            visual_count += 1
            canonical += length
    audio_labels = ["silence"]
    audio_count = 0
    for clip in project["clips"]:
        track = tracks[clip["trackId"]]
        if track.get("muted") or clip.get("muted") or float(clip.get("volume", 1)) == 0:
            continue
        for segment, source_start, source_end, target_start, target_end in audio_pieces(clip):
            media = media_by_id[segment["mediaId"]]
            if not media["hasAudio"] or segment.get("muted"):
                continue
            gain = float(clip.get("volume", 1)) * float(segment.get("volume", 1))
            if gain == 0:
                continue
            output_length = target_end-target_start
            rate = (source_end-source_start)/output_length
            delay_samples = round((float(clip["start"])+target_start)*48000)
            label = f"audio{audio_count}"
            graph.append(f"[{inputs[segment['mediaId']]}:a:0]atrim=start={source_start:.12f}:end={source_end:.12f},"
                         f"asetpts=PTS-STARTPTS,{atempo_chain(rate)},aresample=48000,"
                         f"aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration={output_length:.12f},"
                         f"volume={gain:.8f},adelay={delay_samples}S:all=1[{label}]")
            audio_labels.append(label)
            audio_count += 1
    graph.append("".join(f"[{label}]" for label in audio_labels) +
                 f"amix=inputs={len(audio_labels)}:duration=longest:dropout_transition=0:normalize=0,"
                 f"alimiter=limit=0.98:level=0:latency=1,atrim=duration={duration:.12f}[audioout]")
    # In particular ProRes writes frame-level color properties; container/codec
    # flags alone do not reliably tag the composed frame after an overlay.
    graph.append(f"[{composite}]setparams=range=limited:color_primaries=bt709:"
                 "color_trc=bt709:colorspace=bt709[videoout]")
    graph_path = directory / "filters.txt"
    graph_path.write_text(";\n".join(graph), "utf-8")
    arguments.extend(["-filter_complex_script", str(graph_path), "-map", "[videoout]", "-map", "[audioout]",
                      "-t", f"{duration:.12f}", "-r", str(fps), "-fps_mode", "cfr",
                      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"])
    if master:
        arguments.extend(["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
                          "-c:a", "pcm_s24le"])
    else:
        crf = "12" if settings["quality"] == "master" else "16"
        arguments.extend(["-c:v", "libx264", "-preset", "slow", "-crf", crf, "-pix_fmt", "yuv420p",
                          "-c:a", "aac", "-b:a", "320k"])
    arguments.extend(["-ar", "48000", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(output)])
    return arguments, output, duration


def run_export(job_id: str, project: dict, settings: dict) -> None:
    directory = EXPORTS / job_id
    try:
        JOBS[job_id].update(status="rendering", progress=.01)
        command, output, duration = build_command(project, settings, directory)
        with (directory / "render.log").open("wb") as errors:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors,
                                       creationflags=CREATE_FLAGS, text=True, encoding="utf-8")
            assert process.stdout is not None
            with process.stdout:
                for line in process.stdout:
                    key, _, value = line.strip().partition("=")
                    if key == "out_time_us":
                        try:
                            JOBS[job_id]["progress"] = min(.99, max(.01, float(value)/1_000_000/duration))
                        except ValueError:
                            pass
            code = process.wait()
        if code:
            log = (directory / "render.log").read_text("utf-8", errors="replace")
            raise RuntimeError("FFmpeg could not render this project. " + log[-1800:])
        JOBS[job_id].update(status="complete", progress=1, url=f"/api/export/{job_id}/download",
                            _path=str(output))
    except Exception as exc:
        JOBS[job_id].update(status="error", error=str(exc), progress=0)
    (directory / "job.json").write_text(json.dumps(JOBS[job_id], ensure_ascii=False), "utf-8")


def start_export(project: dict, settings: dict) -> str:
    validate_project(project, settings)
    job_id = str(uuid.uuid4())
    directory = EXPORTS / job_id
    directory.mkdir()
    (directory / "project.json").write_text(json.dumps({"project": project, "settings": settings}, ensure_ascii=False), "utf-8")
    JOBS[job_id] = dict(id=job_id, status="queued", progress=0, created=time.time())
    POOL.submit(run_export, job_id, project, settings)
    return job_id


def get_job(job_id: str) -> dict:
    try:
        job_id = str(uuid.UUID(job_id))
    except ValueError as exc:
        raise FileNotFoundError("Export not found") from exc
    if job_id not in JOBS:
        metadata = EXPORTS / job_id / "job.json"
        if not metadata.exists():
            raise FileNotFoundError("Export not found")
        JOBS[job_id] = json.loads(metadata.read_text("utf-8"))
    return JOBS[job_id]
