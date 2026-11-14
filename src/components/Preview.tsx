import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, CircleAlert, LoaderCircle } from 'lucide-react';
import { clipDuration, projectDuration, resolveClipTime } from '../lib/engine';
import type { Clip, Media, Project } from '../lib/types';
import './Preview.css';

type PlaybackSource = NonNullable<ReturnType<typeof resolveClipTime>>;
type PlayerHandle = { ready: () => boolean; pause: () => void };

export interface PreviewProps {
  project: Project;
  currentTime: number;
  playing: boolean;
  onTimeChange: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
  aspectRatio?: string;
}

interface ClipPlayerProps {
  clip: Clip;
  media: Media;
  source: PlaybackSource;
  playing: boolean;
  muted: boolean;
  visual: boolean;
  register: (id: string, player: PlayerHandle | null) => void;
  reportError: (message: string) => void;
}

/** Preview always reads proxies; the renderer reads the retained original. */
const ClipPlayer = memo(function ClipPlayer({ clip, media, source, playing, muted, visual, register, reportError }: ClipPlayerProps) {
  const element = useRef<HTMLMediaElement | null>(null);
  const failed = useRef(false);
  const target = useRef({ time: source.time, speed: source.speed, playing, muted, volume: source.volume });
  target.current = { time: source.time, speed: source.speed, playing, muted, volume: source.volume };
  const url = media.proxyUrl || media.url || media.originalUrl;
  const isImage = media.kind === 'image';

  const sync = useCallback(() => {
    const node = element.current;
    if (!node || failed.current) return;
    const desired = target.current;
    node.muted = desired.muted;
    node.volume = Math.max(0, Math.min(1, desired.volume));
    if (node.readyState === 0) return;
    const rate = desired.speed;
    // Browser playback-rate limits differ; frame seeking still preserves the
    // temporal mapping when a user requests an unusually extreme stretch.
    let seekOnly = rate < 0.0625 || rate > 16;
    if (!seekOnly) {
      try { node.playbackRate = rate; } catch { seekOnly = true; }
    }
    const desiredTime = Math.max(0, Math.min(desired.time, Number.isFinite(node.duration) ? Math.max(0, node.duration - 0.001) : desired.time));
    const tolerance = desired.playing && !seekOnly ? Math.max(0.002, 0.04 * rate) : 0.004;
    if (!node.seeking && Math.abs(node.currentTime - desiredTime) > tolerance) {
      try { node.currentTime = desiredTime; } catch { /* Metadata is still arriving. */ }
    }
    if (!desired.playing || seekOnly) {
      if (!node.paused) node.pause();
    } else if (node.paused && node.readyState >= 2) {
      void node.play().catch((error: DOMException) => {
        // Switching segments intentionally aborts a pending play request.
        if (error.name !== 'AbortError') reportError('Preview playback was blocked. Pause and press play again.');
      });
    }
  }, [reportError]);

  useEffect(() => {
    failed.current = false;
    if (isImage) return;
    const mountedNode = element.current;
    register(clip.id, {
      ready: () => {
        const node = element.current;
        const rate = target.current.speed;
        return failed.current || !!node && node.readyState >= 2 && (!(rate >= 0.0625 && rate <= 16) || !node.seeking);
      },
      pause: () => element.current?.pause(),
    });
    return () => { mountedNode?.pause(); register(clip.id, null); };
  }, [clip.id, isImage, visual, register, url]);

  useEffect(sync, [source.time, source.speed, source.volume, playing, muted, visual, url, sync]);

  if (isImage) return visual ? <img className="pulse-preview-media" src={url} alt={media.name} draggable={false} /> : null;

  const attributes = {
    ref: (node: HTMLMediaElement | null) => { element.current = node; },
    src: url,
    preload: 'auto' as const,
    playsInline: true,
    onLoadedMetadata: sync,
    onLoadedData: sync,
    onCanPlay: sync,
    onSeeked: sync,
    onError: () => {
      failed.current = true;
      reportError(`The preview could not decode “${media.name}”. Try importing it again.`);
    },
  };
  return visual
    ? <video className="pulse-preview-media" {...attributes} />
    : <audio {...attributes} />;
});

/**
 * A shared monotonic clock drives all layers. The clock stops while a visible
 * source buffers, keeping the music and video on the same timeline.
 */
export function Preview({ project, currentTime, playing, onTimeChange, onPlayingChange, aspectRatio = '16 / 9' }: PreviewProps) {
  const players = useRef(new Map<string, PlayerHandle>());
  const clock = useRef({ time: currentTime, anchorTime: currentTime, anchorNow: 0, lastReported: currentTime });
  const callbacks = useRef({ onTimeChange, onPlayingChange });
  callbacks.current = { onTimeChange, onPlayingChange };
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState('');
  const duration = projectDuration(project);
  const register = useCallback((id: string, player: PlayerHandle | null) => {
    if (player) players.current.set(id, player);
    else players.current.delete(id);
  }, []);
  const reportError = useCallback((message: string) => setError(message), []);

  // Updates generated by our own clock are acknowledged without re-anchoring.
  // A user seek, trim or project replacement establishes a new clock anchor.
  useEffect(() => {
    if (Math.abs(currentTime - clock.current.lastReported) > 0.025 || !playing) {
      clock.current.time = currentTime;
      clock.current.anchorTime = currentTime;
      clock.current.anchorNow = performance.now();
    }
  }, [currentTime, playing]);

  useEffect(() => {
    if (!playing) {
      setBuffering(false);
      for (const player of players.current.values()) player.pause();
      return;
    }
    setError('');
    clock.current.anchorTime = clock.current.time;
    clock.current.anchorNow = performance.now();
    let frame = 0;
    let waiting = false;
    let previousNow = performance.now();
    const tick = (now: number) => {
      const ready = [...players.current.values()].every(player => player.ready());
      if (!ready) {
        if (!waiting) {
          waiting = true;
          setBuffering(true);
          for (const player of players.current.values()) player.pause();
        }
        clock.current.anchorTime = clock.current.time;
        clock.current.anchorNow = now;
      } else {
        if (waiting || now - previousNow > 750) {
          // Returning from a background tab should not jump over the edit.
          clock.current.anchorTime = clock.current.time;
          clock.current.anchorNow = now;
          waiting = false;
          setBuffering(false);
        }
        const next = Math.min(duration, clock.current.anchorTime + (now - clock.current.anchorNow) / 1000);
        clock.current.time = next;
        clock.current.lastReported = next;
        callbacks.current.onTimeChange(next);
        if (next >= duration) {
          callbacks.current.onPlayingChange(false);
          return;
        }
      }
      previousNow = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); };
  }, [playing, duration]);

  const active = useMemo(() => {
    const library = new Map(project.media.map(media => [media.id, media]));
    return [...project.tracks].reverse().flatMap(track => {
      return project.clips.filter(clip => clip.trackId === track.id && currentTime >= clip.start && currentTime < clip.start + clipDuration(clip)).flatMap(clip => {
        const source = resolveClipTime(clip, currentTime - clip.start);
        const media = source && library.get(source.mediaId);
        if (!source || !media) return [];
        return [{ clip, source, media, visual: track.kind === 'video' && !track.hidden && media.kind !== 'audio', muted: !!track.muted || source.muted }];
      });
    });
  }, [project, currentTime]);
  const hasVisual = active.some(layer => layer.visual);
  const hasAnyClips = project.clips.length > 0;

  return <div className="pulse-preview-stage" style={{ aspectRatio }} aria-label="Video preview">
    {!hasVisual && <div className="pulse-preview-empty">
      <div className="pulse-preview-emblem"><AudioLines size={34} strokeWidth={1.4} /></div>
      <strong>{hasAnyClips ? active.length ? 'Listen. Find the moment.' : 'A little room between cuts.' : 'Your next cut starts here.'}</strong>
      <span>{hasAnyClips ? active.length ? 'Your audio is playing on the timeline' : 'Move the playhead to a clip to preview it' : 'Import media to build your sequence'}</span>
      {!hasAnyClips && <div className="pulse-preview-shortcut">VIDEO <i /> AUDIO <i /> IMAGES</div>}
    </div>}
    {active.map(layer => <ClipPlayer key={layer.clip.id} {...layer} playing={playing && !buffering} register={register} reportError={reportError} />)}
    {buffering && <div className="pulse-preview-buffer"><LoaderCircle size={14} className="pulse-preview-spin" /> Preparing preview</div>}
    {error && <button className="pulse-preview-error" onClick={() => setError('')} title="Dismiss preview notice"><CircleAlert size={14} />{error}</button>}
  </div>;
}
