"""Original media storage, browser previews and bass-weighted onset detection."""
from __future__ import annotations

import json
import mimetypes
import os
import shutil
import subprocess
import sys
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
    return json.loads((media_directory(media_id) / "metadata.json").read_text("utf-8"))


def save_metadata(media: dict) -> None:
    directory = MEDIA / media["id"]
    temporary = directory / "metadata.tmp"
    temporary.write_text(json.dumps(media, ensure_ascii=False), "utf-8")
    temporary.replace(directory / "metadata.json")


def list_media() -> list[dict]:
    result = []
    for metadata in MEDIA.glob("*/metadata.json"):
        try:
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
    """Return actual bass-weighted transients, without inventing a rigid beat grid.

    Log spectral flux emphasizes the attack of kick drums; a short local median
    removes sustained bass. The threshold is tunable because a beat remains an
    editorial choice. Times use a 5.8 ms hop and a backwards attack correction.
    """
    if samples.size < 1024 or np.max(np.abs(samples)) < 1e-5:
        return [], None
    hop = 128
    frequencies = np.fft.rfftfreq(1024, 1/sample_rate)
    bass = (frequencies >= 32) & (frequencies <= 220)
    body = (frequencies >= 220) & (frequencies <= 2400)
    frame_count = int(np.ceil(samples.size/hop))+1
    times = np.arange(frame_count)*hop/sample_rate
    low_flux, broad_flux = np.zeros(frame_count), np.zeros(frame_count)
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
        low_flux[first:final] = flux[:,bass].mean(axis=1)
        broad_flux[first:final] = flux[:,body].mean(axis=1)

    def normalize(array: np.ndarray) -> np.ndarray:
        scale = max(float(np.percentile(array, 95)), 1e-8)
        return array / scale

    novelty = gaussian_filter1d(.86 * normalize(low_flux) + .14 * normalize(broad_flux), .7)
    baseline = median_filter(novelty, size=max(3, int(.3 * sample_rate / hop) | 1))
    novelty = np.maximum(novelty - baseline, 0)
    peak_scale = max(float(np.percentile(novelty, 97)), float(novelty.max()) * .08, 1e-8)
    threshold = peak_scale * .19 / max(.2, sensitivity)
    peaks, _ = find_peaks(novelty, distance=max(1, int(min_interval * sample_rate / hop)),
                          prominence=threshold, height=threshold)
    # Flux peaks sit shortly after the physical attack. Find the leading edge
    # within the same local peak rather than quantizing to a guessed tempo.
    onsets = []
    for peak in peaks:
        left = peak
        cutoff = novelty[peak] * .15
        while left > max(0, peak - 8) and novelty[left - 1] > cutoff:
            left -= 1
        # STFT windows are centered: their leading flux edge precedes the
        # physical transient by approximately 19 ms with this window size.
        timestamp = max(0., float(times[left]) + .019)
        if timestamp < samples.size / sample_rate:
            onsets.append(round(timestamp, 6))
    bpm = None
    if len(onsets) >= 3:
        intervals = np.diff(onsets)
        intervals = intervals[(intervals >= .2) & (intervals <= 2)]
        if intervals.size:
            bpm = round(60 / float(np.median(intervals)), 1)
    return onsets, bpm


def analyze_media(media_id: str, sensitivity: float = 1, min_interval: float = .2) -> dict:
    media = get_media(media_id)
    if not media["hasAudio"]:
        raise ValueError("This media has no audio stream to analyze.")
    samples = decode_audio(original_path(media_id))
    beats, bpm = detect_beats(samples, sensitivity=sensitivity, min_interval=min_interval)
    media.update(beats=beats, bpm=bpm, waveform=waveform(samples))
    save_metadata(media)
    return {"beats": beats, "bpm": bpm, "waveform": media["waveform"], "duration": media["duration"]}


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
