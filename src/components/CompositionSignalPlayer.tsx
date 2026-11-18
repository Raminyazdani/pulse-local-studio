import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { clipDuration, resolveClipTime, sourceToOutput } from '../lib/engine';
import type { Clip, Media } from '../lib/types';
import { videoFrameRate } from '../lib/videoSignals';

export interface CompositionSignalPlayerHandle {
  seek: (time: number) => void;
  play: () => void;
  pause: () => void;
}
interface Props {
  clip: Clip;
  media: Media[];
  initialTime: number;
  rate: number;
  quality: 'proxy' | 'original';
  muted: boolean;
  style: CSSProperties;
  onPosition: (time: number, presented: number | null) => void;
  onReady: (ready: boolean) => void;
  onSeeking: (seeking: boolean) => void;
  onPlaying: (playing: boolean) => void;
  onError: (message: string) => void;
}

/** Inspect a composition directly from its original/proxy spans, without another encode. */
export const CompositionSignalPlayer = forwardRef<CompositionSignalPlayerHandle, Props>(function CompositionSignalPlayer(props, ref) {
  const { clip, media, initialTime, quality, style } = props;
  const duration = clipDuration(clip);
  const clamp = (at: number) => Math.max(0, Math.min(duration - 1e-7, at));
  const starts = useMemo(() => {
    let cursor = 0;
    return clip.segments.map(segment => {
      const start = cursor;
      cursor += (segment.out - segment.in) / (segment.speed ?? 1);
      return start;
    });
  }, [clip]);
  const position = useRef(clamp(initialTime));
  const initialSource = resolveClipTime(clip, position.current);
  const [index, setIndex] = useState(initialSource?.segmentIndex ?? 0);
  const indexRef = useRef(index); indexRef.current = index;
  const node = useRef<HTMLVideoElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const segment = clip.segments[index];
  const asset = media.find(item => item.id === segment?.mediaId);
  const source = quality === 'original' ? asset?.originalUrl || asset?.url : asset?.proxyUrl || asset?.url;
  const sourceKey = `${index}:${quality}:${source ?? ''}`;
  const sourceKeyRef = useRef(sourceKey); sourceKeyRef.current = sourceKey;
  const loaded = useRef(false), awaiting = useRef(true), playing = useRef(false);
  const pendingTimestamp = useRef(true);
  const presented = useRef<number | null>(null);
  const lastFrame = useRef<{ source: number; frames: number } | null>(null);
  const framesBeforeSeek = useRef(0);
  const lastNow = useRef(0);
  const methods = useRef({ seek: (_at: number) => {}, play: () => {}, pause: () => {} });

  function emit() { callbacks.current.onPosition(position.current, awaiting.current ? null : presented.current); }
  function changePlaying(next: boolean) {
    playing.current = next;
    lastNow.current = performance.now();
    callbacks.current.onPlaying(next);
    if (!next) node.current?.pause();
  }
  function mapPresented(sourceTime: number) {
    const span = clip.segments[indexRef.current];
    if (!span) return null;
    // A fractional trim-in can lie inside a decoded frame whose PTS precedes
    // the trim. That covering frame belongs at this span's local beginning.
    // The seek's near-target/generation checks still reject stale frames;
    // a PTS at source-out belongs to the following span and stays excluded.
    const coveringFrame = 1 / videoFrameRate(asset ?? {});
    if (sourceTime < span.in - coveringFrame - 1e-6 || sourceTime >= span.out) return null;
    const canonical = starts[indexRef.current] + (Math.max(span.in, sourceTime) - span.in) / (span.speed ?? 1);
    return Math.max(0, Math.min(duration, sourceToOutput(clip, canonical)));
  }
  function acceptFrame(sourceTime: number) {
    const mapped = mapPresented(sourceTime);
    if (mapped === null) return;
    presented.current = mapped;
    awaiting.current = false;
    pendingTimestamp.current = false;
    callbacks.current.onSeeking(false);
    callbacks.current.onReady(true);
    emit();
  }
  function expected() { return resolveClipTime(clip, position.current); }
  function fail(message: string) {
    changePlaying(false); loaded.current = false; awaiting.current = true;
    callbacks.current.onReady(false); callbacks.current.onSeeking(false); callbacks.current.onError(message);
  }
  function beginSeek() {
    awaiting.current = true; presented.current = null;
    pendingTimestamp.current = true;
    framesBeforeSeek.current = lastFrame.current?.frames ?? 0;
    callbacks.current.onSeeking(true);
    emit();
  }
  function sync(force = false) {
    const current = node.current, desired = expected();
    if (!current || !desired || desired.segmentIndex !== indexRef.current || current.readyState === 0) return;
    const span = clip.segments[indexRef.current];
    const nativeTime = Math.max(span.in, Math.min(span.out - 1e-7, desired.time + .00001));
    const speed = desired.speed * callbacks.current.rate;
    let seekOnly = speed < .0625 || speed > 16;
    if (!seekOnly) {
      try { current.playbackRate = speed; } catch { seekOnly = true; }
    }
    current.muted = callbacks.current.muted || desired.muted;
    current.volume = Math.max(0, Math.min(1, desired.volume));
    const drift = Math.abs(current.currentTime - nativeTime);
    if (!current.seeking && (force || drift > (playing.current && !seekOnly ? Math.max(.004, .07 * desired.speed) : .00002))) {
      beginSeek();
      try { current.currentTime = nativeTime; } catch { fail('The requested composition frame could not be loaded. Try the compatible preview.'); }
    }
    if (!playing.current || seekOnly || awaiting.current) current.pause();
    else if (current.paused && !current.ended && current.readyState >= 2) {
      const key = sourceKeyRef.current;
      void current.play().catch((error: DOMException) => {
        if (key === sourceKeyRef.current && error.name !== 'AbortError') fail('Playback was blocked. Try Play again, or use the compatible preview.');
      });
    }
  }
  function selectTime(at: number, stop: boolean) {
    if (stop) changePlaying(false);
    position.current = clamp(at);
    const next = expected();
    beginSeek();
    if (!next) return;
    if (next.segmentIndex !== indexRef.current) {
      node.current?.pause(); loaded.current = false;
      callbacks.current.onReady(false);
      indexRef.current = next.segmentIndex; setIndex(next.segmentIndex);
    } else if (asset?.kind === 'image' && image.current?.complete && image.current.naturalWidth) {
      presented.current = position.current; awaiting.current = false;
      callbacks.current.onReady(true); callbacks.current.onSeeking(false); emit();
    } else sync(true);
    lastNow.current = performance.now();
  }
  methods.current = {
    seek: at => selectTime(at, true),
    pause: () => changePlaying(false),
    play: () => {
      if (position.current >= duration - .001) selectTime(0, false);
      changePlaying(true); sync();
    },
  };
  useImperativeHandle(ref, () => ({ seek: at => methods.current.seek(at), pause: () => methods.current.pause(), play: () => methods.current.play() }), []);

  useEffect(() => {
    const mounted = node.current;
    const key = sourceKey;
    loaded.current = false; awaiting.current = true; pendingTimestamp.current = true; presented.current = null; lastFrame.current = null; framesBeforeSeek.current = 0;
    callbacks.current.onReady(false); callbacks.current.onSeeking(true); callbacks.current.onError('');
    lastNow.current = performance.now();
    if (!asset || !source || asset.kind === 'audio') fail('A visual source in this clip is missing. Restore the video or image in the media library.');
    if (asset?.kind === 'image' && image.current?.complete && image.current.naturalWidth) {
      loaded.current = true; awaiting.current = false; presented.current = position.current;
      callbacks.current.onReady(true); callbacks.current.onSeeking(false); emit();
    }
    let frameCallback = 0, disposed = false;
    if (mounted?.requestVideoFrameCallback) {
      const observe = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (disposed || key !== sourceKeyRef.current) return;
        lastFrame.current = { source: metadata.mediaTime, frames: metadata.presentedFrames };
        const desired = expected();
        if (desired && desired.segmentIndex === indexRef.current && !mounted.seeking && loaded.current) {
          const fps = asset?.fps || 30;
          const nearTarget = Math.abs(metadata.mediaTime - desired.time) <= Math.max(.002, 1.5 / fps);
          if (!pendingTimestamp.current || metadata.presentedFrames > framesBeforeSeek.current && nearTarget) {
            acceptFrame(metadata.mediaTime); sync();
          }
        }
        frameCallback = mounted.requestVideoFrameCallback(observe);
      };
      frameCallback = mounted.requestVideoFrameCallback(observe);
    }
    return () => {
      disposed = true;
      if (mounted) { if (frameCallback) mounted.cancelVideoFrameCallback(frameCallback); mounted.pause(); mounted.removeAttribute('src'); mounted.load(); }
    };
  }, [sourceKey]);

  useEffect(() => {
    let animation = 0;
    const tick = (now: number) => {
      const elapsed = Math.min(.1, Math.max(0, (now - lastNow.current) / 1000));
      lastNow.current = now;
      if (playing.current && loaded.current && !awaiting.current) {
        const at = position.current;
        let next = Math.min(duration, at + elapsed * callbacks.current.rate);
        const currentSpan = clip.segments[indexRef.current];
        const end = sourceToOutput(clip, starts[indexRef.current] + (currentSpan.out - currentSpan.in) / (currentSpan.speed ?? 1));
        if (next >= duration) {
          position.current = clamp(duration); changePlaying(false); emit();
        } else if (next >= end - 1e-7 && indexRef.current < clip.segments.length - 1) {
          selectTime(end, false);
        } else {
          position.current = next;
          if (asset?.kind === 'image') presented.current = next;
          emit(); sync();
        }
      }
      animation = requestAnimationFrame(tick);
    };
    lastNow.current = performance.now(); animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [sourceKey, duration, starts, clip]);

  useEffect(() => { sync(); }, [props.rate, props.muted]);
  useEffect(() => () => { playing.current = false; node.current?.pause(); }, []);

  function seeked() {
    const current = node.current, desired = expected();
    if (!current || !desired || current.seeking || !loaded.current || sourceKey !== sourceKeyRef.current || desired.segmentIndex !== indexRef.current) return;
    if (!current.requestVideoFrameCallback) acceptFrame(current.currentTime);
    else {
      // A seek within an already displayed source frame may not trigger a new
      // compositor callback. Its known timestamp remains valid for this frame.
      const previous = lastFrame.current, fps = asset?.fps || 30;
      if (previous && previous.source <= desired.time + .00002 && desired.time - previous.source < 1 / fps - .00002)
        acceptFrame(previous.source);
    }
    const span = clip.segments[desired.segmentIndex];
    const nativeTime = Math.max(span.in, Math.min(span.out - 1e-7, desired.time + .00001));
    if (awaiting.current && current.readyState >= 2 && Math.abs(current.currentTime - nativeTime) <= .0001) {
      // A VFR frame may cover a long interval before its next timestamp. A
      // completed native seek with current decoded data is usable even when
      // that PTS falls outside the average-frame-rate inspection interval.
      // Keep timestamp freshness pending: an old RVFC must not satisfy it.
      awaiting.current = false; presented.current = null;
      callbacks.current.onSeeking(false); callbacks.current.onReady(true); emit();
    }
    sync();
  }

  if (asset?.kind === 'image') return <img key={sourceKey} ref={image} className="signal-editor-video" src={source} style={style} draggable={false} alt={asset.name}
    onLoad={() => {
      loaded.current = true; awaiting.current = false; presented.current = position.current;
      callbacks.current.onReady(true); callbacks.current.onSeeking(false); emit();
    }} onError={() => fail('The composition image could not load. Restore its local source and reopen the labeler.')} />;
  return <video key={sourceKey} ref={node} className="signal-editor-video" src={source} style={style} playsInline preload="auto" draggable={false}
    muted={props.muted || clip.muted || Boolean(segment?.muted)}
    onLoadedMetadata={() => sync(true)}
    onLoadedData={() => { loaded.current = true; callbacks.current.onReady(true); seeked(); }}
    onCanPlay={() => { loaded.current = true; callbacks.current.onReady(true); seeked(); sync(); }}
    onSeeking={() => { awaiting.current = true; callbacks.current.onSeeking(true); }}
    onSeeked={seeked}
    onWaiting={() => { loaded.current = false; callbacks.current.onSeeking(true); }}
    onTimeUpdate={() => { if (!node.current?.requestVideoFrameCallback && node.current && !node.current.seeking) acceptFrame(node.current.currentTime); }}
    onError={() => fail(quality === 'original' ? 'The browser cannot decode this original. Switch to the compatible preview; the original files stay unchanged.' : 'A video in this composition could not load. Restore its local source and reopen the labeler.')} />;
});
