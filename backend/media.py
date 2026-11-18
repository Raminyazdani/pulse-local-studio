"""Original media storage, browser previews and bass-weighted onset detection."""
from __future__ import annotations

import json
import math
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d, median_filter
from scipy.signal import find_peaks

ROOT = Path(os.environ.get("PULSE_APP_ROOT", str(Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1]))).resolve()
DATA = Path(os.environ.get("PULSE_DATA_DIR", str(ROOT / "data"))).resolve()
MEDIA = DATA / "media"
EXPORTS = DATA / "exports"
for directory in (MEDIA, EXPORTS):
    directory.mkdir(parents=True, exist_ok=True)

CREATE_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
PREVIEW_VERSION = 2
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}
SOURCE_SIGNAL_LIMIT = 100000
SOURCE_SIGNAL_EPSILON = 1e-7
_METADATA_LOCKS: dict[tuple[str, str], threading.RLock] = {}
_METADATA_LOCKS_GUARD = threading.Lock()


def metadata_lock(media_id: str):
    """Serialize one item's metadata read/modify/write without blocking decoding."""
    try:
        canonical = str(uuid.UUID(media_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise FileNotFoundError("Media not found") from exc
    key = (str(MEDIA.resolve()), canonical)
    with _METADATA_LOCKS_GUARD:
        return _METADATA_LOCKS.setdefault(key, threading.RLock())


def source_color_metadata(video: dict | None) -> dict:
    """Keep source color facts separate from the SDR previews/output we create."""
    video = video or {}
    transfer = video.get("color_transfer")
    return dict(sourceColorPrimaries=video.get("color_primaries"),
                sourceColorTransfer=transfer, sourceColorSpace=video.get("color_space"),
                sourcePixelFormat=video.get("pix_fmt"), hdr=transfer in HDR_TRANSFERS)


def sdr_color_filter(media: dict, pixel_format: str = "yuv420p") -> str:
    """HLG/PQ -> linear float RGB -> tone map -> BT.709 SDR.

    FFmpeg tonemap operates on linear floating-point light; applying it to
    gamma-encoded YUV directly would corrupt color and highlight detail.
    https://ffmpeg.org/ffmpeg-filters.html#tonemap
    The current editor exports SDR, including its ten-bit ProRes master.
    """
    transfer = media.get("sourceColorTransfer")
    if transfer not in HDR_TRANSFERS:
        return ""
    if pixel_format not in {"yuv420p", "yuv422p10le"}:
        raise ValueError("Unsupported tone-map output pixel format.")
    return (f"zscale=tin={transfer}:t=linear:npl=100,format=gbrpf32le,"
            "zscale=p=bt709,tonemap=tonemap=mobius:desat=2,"
            f"zscale=t=bt709:m=bt709:r=tv:dither=error_diffusion,format={pixel_format},"
            "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709,")


def ensure_color_metadata(media: dict) -> dict:
    """Backfill imports from older versions before original-media rendering."""
    if media.get("kind") == "video" and "sourceColorTransfer" not in media:
        info = probe(original_path(media["id"]))
        video = next((stream for stream in info["streams"] if stream.get("codec_type") == "video"), None)
        media.update(source_color_metadata(video))
        save_metadata(media)
    return media


def create_video_preview(upload_path: Path, directory: Path, media: dict) -> None:
    tone_map = sdr_color_filter(media)
    run_ffmpeg(["-i", str(upload_path), "-vf", tone_map + "scale=320:320:force_original_aspect_ratio=decrease",
                "-frames:v", "1", "-update", "1", str(directory / "thumbnail.jpg")])
    proxy = f"proxy-sdr-v{PREVIEW_VERSION}.mp4" if tone_map else "proxy.mp4"
    # Originals are retained at full quality. This file is a browser-only proxy.
    run_ffmpeg(["-i", str(upload_path), "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", tone_map + "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p",
                *(["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"] if tone_map else []),
                "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(directory / proxy)])
    media.update(_proxy=proxy, previewVersion=PREVIEW_VERSION,
                 previewColorSpace="bt709" if tone_map else media.get("sourceColorPrimaries"),
                 proxyUrl=f"/api/files/{media['id']}/proxy?v={PREVIEW_VERSION}",
                 url=f"/api/files/{media['id']}/proxy?v={PREVIEW_VERSION}",
                 thumbnailUrl=f"/api/files/{media['id']}/thumbnail?v={PREVIEW_VERSION}")


def refresh_media_preview(media_id: str, force: bool = False) -> dict:
    """Refresh legacy HDR previews without moving originals or redoing audio analysis."""
    media = ensure_color_metadata(get_media(media_id))
    if media.get("kind") == "video" and (force or (media.get("hdr") and media.get("previewVersion", 0) < PREVIEW_VERSION)):
        directory = media_directory(media_id)
        create_video_preview(original_path(media_id), directory, media)
        save_metadata(media)
    return public_media(media)


def run_ffmpeg(args: list[str], timeout: int = 1800) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args],
        capture_output=True, timeout=timeout, creationflags=CREATE_FLAGS, check=True,
    )


def probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, timeout=60, creationflags=CREATE_FLAGS, check=True,
    )
    return json.loads(result.stdout)


def media_directory(media_id: str) -> Path:
    # UUID-only storage paths keep uploaded filenames and request input out of paths.
    try:
        parsed = str(uuid.UUID(media_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise FileNotFoundError("Media not found") from exc
    directory = MEDIA / parsed
    if not (directory / "metadata.json").is_file():
        raise FileNotFoundError("Media not found")
    return directory


def get_media(media_id: str) -> dict:
    with metadata_lock(media_id):
        return json.loads((media_directory(media_id) / "metadata.json").read_text("utf-8"))


def save_metadata(media: dict, *, replace_source_signals: bool = False) -> None:
    with metadata_lock(media["id"]):
        directory = MEDIA / str(uuid.UUID(media["id"]))
        destination = directory / "metadata.json"
        # Analysis/preview jobs may have read their snapshot before a labeling
        # session saved. Only the explicit label writer may replace these marks.
        if not replace_source_signals and destination.is_file():
            previous = json.loads(destination.read_text("utf-8"))
            if "sourceSignals" in previous:
                media["sourceSignals"] = previous["sourceSignals"]
        temporary = directory / f"metadata.{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump(media, stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)


class SourceSignalConflict(ValueError):
    """Another labeling session saved newer source marks."""


def normalized_source_signals(values, duration: float) -> list[float]:
    if not isinstance(values, list) or len(values) > SOURCE_SIGNAL_LIMIT:
        raise ValueError("Video source signals must be an array of at most 100,000 timestamps.")
    if (not isinstance(duration, (int, float)) or isinstance(duration, bool) or
            duration <= 0 or duration > 86400 or not math.isfinite(duration)):
        raise ValueError("This video has no valid source duration.")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or
           value < 0 or value >= duration or not math.isfinite(value) for value in values):
        raise ValueError("Video source signals must be finite timestamps inside the original video.")
    ordered = sorted(float(value) for value in values)
    result = []
    for value in ordered:
        if not result or value - result[-1] > SOURCE_SIGNAL_EPSILON:
            result.append(value)
    return result


def video_signal_media(media_id: str) -> dict:
    media = get_media(media_id)
    if media.get("kind") != "video":
        raise ValueError("Source beat signals can be labeled only on video files.")
    normalized_source_signals(media.get("sourceSignals", []), media["duration"])
    return media


def save_video_signals(media_id: str, signals, expected_signals=None) -> dict:
    """Save reusable source-clock marks without touching original/proxy media."""
    with metadata_lock(media_id):
        media = video_signal_media(media_id)
        result = normalized_source_signals(signals, media["duration"])
        if expected_signals is not None:
            expected = normalized_source_signals(expected_signals, media["duration"])
            current = normalized_source_signals(media.get("sourceSignals", []), media["duration"])
            # A previous HTTP save may have succeeded before the client lost
            # its response or failed to flush its separate project snapshot.
            # Repeating that exact desired save must be safe and idempotent.
            if expected != current and result != current:
                raise SourceSignalConflict("This video's labels changed in another session. Reopen the label editor before saving again.")
        if media.get("sourceSignals") == result:
            return public_media(media)
        media["sourceSignals"] = result
        save_metadata(media, replace_source_signals=True)
        return public_media(media)


def list_media() -> list[dict]:
    result = []
    for metadata in MEDIA.glob("*/metadata.json"):
        try:
            with metadata_lock(metadata.parent.name):
                result.append(json.loads(metadata.read_text("utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    return sorted(result, key=lambda item: item.get("created", 0))


def original_path(media_id: str) -> Path:
    directory = media_directory(media_id)
    path = directory / get_media(media_id)["_original"]
    if not path.is_file():
        raise FileNotFoundError("Original media is missing")
    return path


def public_media(media: dict) -> dict:
    return {key: value for key, value in media.items() if not key.startswith("_")}


def decode_audio(path: Path, sample_rate: int = 22050) -> np.ndarray:
    decoded = run_ffmpeg([
        "-i", str(path), "-vn", "-ac", "1", "-ar", str(sample_rate), "-f", "f32le", "pipe:1",
    ])
    return np.frombuffer(decoded.stdout, dtype="<f4")


def waveform(samples: np.ndarray, bins: int = 1600) -> list[float]:
    if samples.size == 0:
        return []
    count = min(bins, samples.size)
    boundaries = np.linspace(0, samples.size, count + 1, dtype=np.int64)
    envelope = np.maximum.reduceat(np.abs(samples), boundaries[:-1])
    scale = max(float(np.percentile(envelope, 99.5)), 0.001)
    return np.round(np.minimum(envelope / scale, 1), 4).tolist()


def detect_beats(samples: np.ndarray, sample_rate: int = 22050,
                 sensitivity: float = 1, min_interval: float = .2) -> tuple[list[float], float | None]:
    """Return actual multi-band attacks, without inventing a rigid beat grid.

    Independently threshold bass, body and high-frequency spectral flux before
    merging coincident attacks. A loud snare/hat can therefore no longer raise
    one shared threshold or suppress a quieter nearby bass attack. Minimum
    spacing applies within each frequency stream; coincident streams represent
    one attack. Acoustic groups let the editor choose which attacks to retain.
    """
    if samples.size < 1024 or np.max(np.abs(samples)) < 1e-5:
        return [], None
    hop = 128
    frequencies = np.fft.rfftfreq(1024, 1/sample_rate)
    bass = (frequencies >= 32) & (frequencies <= 220)
    body = (frequencies >= 220) & (frequencies < 2400)
    bright = (frequencies >= 2400) & (frequencies <= min(10000, sample_rate / 2))
    frame_count = int(np.ceil(samples.size/hop))+1
    times = np.arange(frame_count)*hop/sample_rate
    streams = np.zeros((3, frame_count))
    window = (.5-.5*np.cos(2*np.pi*np.arange(1024)/1024)).astype(np.float32)
    previous = None
    # Bounded FFT batches keep a long song from allocating a full spectrogram
    # and several equally large intermediate arrays at once.
    for first in range(0, frame_count, 2048):
        final = min(frame_count, first+2048)
        begin, end = first*hop-512, (final-1)*hop+512
        chunk = samples[max(0,begin):min(samples.size,end)]
        chunk = np.pad(chunk,(max(0,-begin),max(0,end-samples.size)))
        windows = np.lib.stride_tricks.sliding_window_view(chunk,1024)[::hop]
        spectrum = np.fft.rfft(windows*window,axis=1)
        logarithmic = np.log1p(np.abs(spectrum)/window.sum()*100)
        prefix = logarithmic[:1] if previous is None else previous
        flux = np.maximum(np.diff(logarithmic,axis=0,prepend=prefix),0)
        previous = logarithmic[-1:].copy()
        for index, band in enumerate((bass, body, bright)):
            if band.any():
                streams[index, first:final] = flux[:,band].mean(axis=1)
    # Flux peaks sit shortly after the physical attack. Find the leading edge
    # within the same local peak rather than quantizing to a guessed tempo.
    candidates: list[tuple[float, float]] = []
    for flux in streams:
        if float(flux.max()) < 1e-7:
            continue
        novelty = gaussian_filter1d(flux / max(float(np.percentile(flux, 95)), 1e-8), .7)
        baseline = median_filter(novelty, size=max(3, int(.3 * sample_rate / hop) | 1))
        novelty = np.maximum(novelty - baseline, 0)
        peak_scale = max(float(np.percentile(novelty, 97)), float(novelty.max()) * .08, 1e-8)
        threshold = peak_scale * .19 / max(.2, sensitivity)
        peaks, _ = find_peaks(novelty, distance=max(1, int(min_interval * sample_rate / hop)),
                              prominence=threshold, height=threshold)
        for peak in peaks:
            left = peak
            cutoff = novelty[peak] * .15
            while left > max(0, peak - 8) and novelty[left - 1] > cutoff:
                left -= 1
            # Centered STFT leading edges precede the physical attack by ~19 ms.
            timestamp = max(0., float(times[left]) + .019)
            if timestamp < samples.size / sample_rate:
                candidates.append((timestamp, float(novelty[peak] / peak_scale)))
    onsets: list[float] = []
    cluster: list[tuple[float, float]] = []
    for candidate in sorted(candidates):
        if cluster and candidate[0] - cluster[0][0] > .045:
            onsets.append(round(min(cluster, key=lambda value: value[0])[0], 6))
            cluster = []
        cluster.append(candidate)
    if cluster:
        onsets.append(round(min(cluster, key=lambda value: value[0])[0], 6))
    bpm = None
    if len(onsets) >= 3:
        intervals = np.diff(onsets)
        intervals = intervals[(intervals >= .2) & (intervals <= 2)]
        if intervals.size:
            bpm = round(60 / float(np.median(intervals)), 1)
    return onsets, bpm


def group_beats(samples: np.ndarray, beats: list[float], sample_rate: int = 22050) -> list[dict]:
    """Cluster real hits by normalized spectrum and attack shape, not loudness.

    This is an acoustic similarity aid, not instrument/source separation. Each
    detected beat belongs to exactly one deterministic group. Farthest-point
    seeding and bounded Lloyd iterations avoid quadratic distance matrices for
    long songs. Representatives are real group members suitable for audition.
    """
    if not beats or samples.size == 0:
        return []
    frequencies = np.fft.rfftfreq(4096, 1 / sample_rate)
    bands = [(32, 180), (180, 500), (500, 1500), (1500, 4000), (4000, sample_rate / 2 + 1)]
    masks = [(frequencies >= low) & (frequencies < high) for low, high in bands]
    spectra, attacks = [], []
    for beat in beats:
        start = max(0, round((beat - .012) * sample_rate))
        stop = min(samples.size, start + round(.17 * sample_rate))
        snippet = np.asarray(samples[start:stop], dtype=np.float64)
        if snippet.size < 2:
            snippet = np.zeros(2)
        spectrum = np.abs(np.fft.rfft(snippet * np.hanning(snippet.size), n=4096)) ** 2
        power = np.array([float(spectrum[mask].sum()) for mask in masks])
        power /= max(float(power.sum()), 1e-14)
        spectra.append(power)
        energy = snippet ** 2
        attacks.append(float(energy[:round(.05 * sample_rate)].sum() / max(float(energy.sum()), 1e-14)))
    powers = np.asarray(spectra)
    # Square roots compare spectral proportions without allowing one very
    # loud hit to dominate the grouping; attack shape has a smaller influence.
    features = np.column_stack((np.sqrt(powers), np.asarray(attacks) * .3))
    average = features.mean(axis=0)
    centers = [features[int(np.argmin(np.sum((features - average) ** 2, axis=1)))].copy()]
    while len(centers) < min(6, len(beats)):
        distances = np.min(np.sum((features[:,None,:] - np.asarray(centers)[None,:,:]) ** 2, axis=2), axis=1)
        farthest = int(np.argmax(distances))
        if distances[farthest] < .32 ** 2:
            break
        centers.append(features[farthest].copy())
    centers_array = np.asarray(centers)
    labels = np.zeros(len(beats), dtype=np.int64)
    for _ in range(24):
        previous = labels.copy()
        labels = np.argmin(np.sum((features[:,None,:] - centers_array[None,:,:]) ** 2, axis=2), axis=1)
        for index in range(len(centers_array)):
            members = features[labels == index]
            if members.size:
                centers_array[index] = members.mean(axis=0)
        if np.array_equal(previous, labels):
            break
    records = []
    for index, center in enumerate(centers_array):
        members = np.flatnonzero(labels == index)
        if not members.size:
            continue
        representative = int(members[np.argmin(np.sum((features[members] - center) ** 2, axis=1))])
        profile = np.median(powers[members], axis=0)
        bass_score = float(profile[0])
        brightness = float(profile[3:].sum())
        name = ("Bass-heavy" if bass_score >= .52 else "Low body" if bass_score >= .25 else
                "Bright attack" if brightness >= .5 else "Mid attack" if profile[1:3].sum() >= .5 else "Mixed attack")
        records.append(dict(label=name, beatIndices=members.tolist(),
                            sampleTime=beats[representative],
                            bassScore=round(bass_score, 4), _brightness=brightness))
    records.sort(key=lambda group: (-group["bassScore"], group["_brightness"], group["beatIndices"][0]))
    counts: dict[str, int] = {}
    totals = {name: sum(group["label"] == name for group in records) for name in {group["label"] for group in records}}
    for index, group in enumerate(records):
        name = group["label"]
        counts[name] = counts.get(name, 0) + 1
        group.update(id=f"group-{index + 1}", label=name if totals[name] == 1 else f"{name} {counts[name]}")
        group.pop("_brightness")
    return records


def analyze_media(media_id: str, sensitivity: float = 1, min_interval: float = .2) -> dict:
    media = get_media(media_id)
    if not media["hasAudio"]:
        raise ValueError("This media has no audio stream to analyze.")
    samples = decode_audio(original_path(media_id))
    beats, bpm = detect_beats(samples, sensitivity=sensitivity, min_interval=min_interval)
    # Decoder padding or an audio stream longer than the container's usable
    # timeline must not create project markers outside the imported duration.
    beats = [beat for beat in beats if 0 <= beat < media["duration"]]
    groups = group_beats(samples, beats)
    media.update(beats=beats, beatGroups=groups, bpm=bpm, waveform=waveform(samples))
    save_metadata(media)
    return {"beats": beats, "beatGroups": groups, "bpm": bpm, "waveform": media["waveform"], "duration": media["duration"]}


def import_media(upload_path: Path, name: str, media_id: str) -> dict:
    import time
    directory = upload_path.parent
    info = probe(upload_path)
    video = next((stream for stream in info["streams"]
                  if stream["codec_type"] == "video" and not stream.get("disposition", {}).get("attached_pic")), None)
    audio = next((stream for stream in info["streams"] if stream["codec_type"] == "audio"), None)
    extension = upload_path.suffix.lower()
    image = extension in {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".avif"}
    if not video and not audio:
        raise ValueError("No supported video or audio stream was found.")
    if image and not video:
        raise ValueError("This image cannot be decoded.")
    kind = "image" if image else "video" if video else "audio"
    raw_duration = info.get("format", {}).get("duration") or (video or audio or {}).get("duration")
    duration = 5 if image else float(raw_duration or 0)
    if not image and (duration <= 0 or duration > 86400):
        raise ValueError("Media must have a finite duration shorter than 24 hours.")
    rate = (video or {}).get("avg_frame_rate", "0/1")
    numerator, denominator = (rate.split("/") + ["1"])[:2]
    fps = float(numerator) / max(float(denominator), 1) if video and not image else 0
    width, height = int((video or {}).get("width", 0)), int((video or {}).get("height", 0))
    for side in (video or {}).get("side_data_list", []):
        if abs(int(side.get("rotation", 0))) % 180 == 90:
            width, height = height, width
            break
    media = dict(id=media_id, name=name, kind=kind, duration=duration, width=width, height=height,
                 fps=round(fps, 4), hasAudio=bool(audio) and not image, waveform=[], beats=[], bpm=None,
                 size=upload_path.stat().st_size, created=time.time(), _original=upload_path.name,
                 originalUrl=f"/api/files/{media_id}/original", thumbnailUrl=None,
                 proxyUrl=f"/api/files/{media_id}/proxy", url=f"/api/files/{media_id}/proxy")
    media.update(source_color_metadata(video))
    if video and kind != "video":
        run_ffmpeg(["-i", str(upload_path), "-vf", "scale=320:320:force_original_aspect_ratio=decrease",
                    "-frames:v", "1", "-update", "1", str(directory / "thumbnail.jpg")])
        media["thumbnailUrl"] = f"/api/files/{media_id}/thumbnail"
    if kind == "video":
        create_video_preview(upload_path, directory, media)
    elif kind == "audio":
        # PCM WAV avoids encoder delay in Web Audio playback and supports all input codecs.
        run_ffmpeg(["-i", str(upload_path), "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le",
                    str(directory / "proxy.wav")])
        media["_proxy"] = "proxy.wav"
    else:
        media["_proxy"] = "thumbnail.jpg"  # Replaced by a full resolution browser PNG below.
        run_ffmpeg(["-i", str(upload_path), "-frames:v", "1", "-update", "1", str(directory / "proxy.png")])
        media["_proxy"] = "proxy.png"
    if media["hasAudio"]:
        media["waveform"] = waveform(decode_audio(upload_path))
    save_metadata(media)
    return public_media(media)


def safe_remove_import(directory: Path) -> None:
    if directory.parent.resolve() == MEDIA.resolve() and directory.is_dir():
        shutil.rmtree(directory)
