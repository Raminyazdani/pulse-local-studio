import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Flag, Maximize2, Minus, Pause, Play, Plus, Redo2, RotateCcw, SkipBack, SkipForward, Trash2, Undo2, Volume2, VolumeX, X } from 'lucide-react';
import type { Clip, Media } from '../lib/types';
import { normalizeSourceSignals, quantizeVideoSignal, videoFrameRate } from '../lib/videoSignals';
import { normalizeTimelineSignals } from '../lib/timelineSignals';
import { CompositionSignalPlayer } from './CompositionSignalPlayer';
import type { CompositionSignalPlayerHandle } from './CompositionSignalPlayer';
import './VideoSignalEditor.css';

export interface VideoSignalEditorProps {
  media: Media;
  initialSignals: number[];
  /** A flattened timeline instance: labels use this combined clip's local output clock. */
  composition?: { clip: Clip; media: Media[] };
  initialTime?: number;
  onSave: (signals: number[], applyToExisting: boolean) => Promise<void>;
  onClose: () => void;
}
type Pan = { x: number; y: number };
type MarkerDrag = { x: number; time: number; scroll: number; signals: number[]; pointer: number };
const PAGE_SIZE = 60;
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-8);

function PositionField({ label, value, digits, max, step, disabled, onCommit, onFocus }: {
  label: string; value: number; digits: number; max: number; step: number;
  disabled: boolean;
  onCommit: (value: number) => void; onFocus: () => void;
}) {
  const [text, setText] = useState(value.toFixed(digits));
  const editing = useRef(false);
  const edited = useRef(false);
  useEffect(() => { if (!editing.current) setText(value.toFixed(digits)); }, [value, digits]);
  return <input aria-label={label} type="number" value={text} step={step} min={0} max={max} disabled={disabled}
    onFocus={() => { editing.current = true; edited.current = false; onFocus(); }} onChange={e => { edited.current = true; setText(e.target.value); }}
    onBlur={() => {
      editing.current = false;
      const changed = edited.current && text.trim() && Number.isFinite(Number(text)) && Math.abs(Number(text) - Number(value.toFixed(digits))) > 1e-10;
      edited.current = false; setText(value.toFixed(digits));
      if (changed) onCommit(Number(text));
    }}
    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}

export function VideoSignalEditor({ media, initialSignals, composition, initialTime = 0, onSave, onClose }: VideoSignalEditorProps) {
  const fps = videoFrameRate(media), duration = media.duration;
  const lastFrame = Math.max(0, Math.ceil(duration * fps - 1e-7) - 1);
  const normalize = composition ? normalizeTimelineSignals : normalizeSourceSignals;
  const [initialValues] = useState(() => normalize(initialSignals, duration));
  const initial = useRef(initialValues);
  const [signals, setSignals] = useState(initial.current);
  const signalsRef = useRef(signals); signalsRef.current = signals;
  const [history, setHistory] = useState<number[][]>([]);
  const [future, setFuture] = useState<number[][]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [time, setTime] = useState(() => Math.max(0, Math.min(duration - 1e-7, initialTime)));
  const timeRef = useRef(time);
  const presented = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [ready, setReady] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(true);
  const [quality, setQuality] = useState<'proxy' | 'original'>('proxy');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [stageSize, setStageSize] = useState({ width: 1000, height: 500 });
  const [timelineZoom, setTimelineZoom] = useState(100);
  const [timelineWidth, setTimelineWidth] = useState(1000);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [page, setPage] = useState(0);
  const [applyToExisting, setApplyToExisting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [videoError, setVideoError] = useState('');
  const [hint, setHint] = useState('');
  const [closeHint, setCloseHint] = useState(false);
  const dialog = useRef<HTMLElement>(null), video = useRef<HTMLVideoElement>(null);
  const compositionPlayer = useRef<CompositionSignalPlayerHandle>(null);
  const stage = useRef<HTMLDivElement>(null), timeline = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null);
  const markerDrag = useRef<MarkerDrag | null>(null);
  const markerAnimation = useRef(0);
  const markerPointer = useRef<{ x: number; pointer: number } | null>(null);
  const markerMove = useRef<(x: number, pointer: number) => void>(() => undefined);
  const panDrag = useRef<{ x: number; y: number; pan: Pan; pointer: number } | null>(null);
  const panRef = useRef(pan); panRef.current = pan;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const frame = Math.min(lastFrame, Math.max(0, Math.round(time * fps)));
  const dirty = !same(signals, initial.current);
  const cuts = useMemo(() => {
    if (!composition) return [];
    let at = 0;
    return composition.clip.segments.map((segment, index) => {
      const start = at;
      at += (segment.out - segment.in) / (segment.speed ?? 1);
      return { start, end: at, index, name: composition.media.find(item => item.id === segment.mediaId)?.name ?? 'Missing source' };
    });
  }, [composition]);
  const source = quality === 'original' ? media.originalUrl || media.url : media.proxyUrl || media.url;
  const originalAvailable = composition ? composition.clip.segments.every(segment => !!composition.media.find(item => item.id === segment.mediaId)?.originalUrl) : !!media.originalUrl;
  const aspect = (media.width || 16) / (media.height || 9);
  const fitWidth = Math.min(stageSize.width, stageSize.height * aspect);
  const fitHeight = fitWidth / aspect;
  const width = Math.max(timelineWidth, timelineWidth * timelineZoom / 100);
  const pixelsPerSecond = width / Math.max(duration, .001);
  const tickStep = pixelsPerSecond < 20 ? 10 : pixelsPerSecond < 55 ? 5 : pixelsPerSecond < 140 ? 1 : pixelsPerSecond < 400 ? .5 : .1;
  const ticks = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollLeft / pixelsPerSecond / tickStep) * tickStep);
    const end = Math.min(duration, (scrollLeft + timelineWidth + 40) / pixelsPerSecond);
    return Array.from({ length: Math.max(0, Math.floor((end - start) / tickStep) + 1) }, (_, i) => start + i * tickStep);
  }, [scrollLeft, pixelsPerSecond, tickStep, timelineWidth, duration]);
  const wavePath = useMemo(() => {
    const samples = media.waveform;
    if (!samples?.length) return '';
    const start = Math.max(0, Math.floor(scrollLeft / width * samples.length) - 1);
    const end = Math.min(samples.length, Math.ceil((scrollLeft + timelineWidth) / width * samples.length) + 1);
    let path = '';
    for (let i = start; i < end; i++) {
      const x = i / Math.max(1, samples.length - 1) * width;
      const amplitude = Math.min(1, Math.abs(samples[i])) * 24;
      path += `M${x.toFixed(2)},${(47 - amplitude).toFixed(2)}V${(47 + amplitude).toFixed(2)}`;
    }
    return path;
  }, [media.waveform, scrollLeft, width, timelineWidth]);

  function boundPan(next: Pan, nextZoom = zoomRef.current): Pan {
    const x = Math.max(0, (fitWidth * nextZoom - stageSize.width) / 2);
    const y = Math.max(0, (fitHeight * nextZoom - stageSize.height) / 2);
    return { x: Math.max(-x, Math.min(x, next.x)), y: Math.max(-y, Math.min(y, next.y)) };
  }
  const zoomAction = useRef<(value: number, clientX?: number, clientY?: number) => void>(() => undefined);
  zoomAction.current = (value, clientX, clientY) => {
    const next = Math.max(1, Math.min(8, value));
    const rect = stage.current?.getBoundingClientRect();
    const x = rect && clientX !== undefined ? clientX - rect.left - rect.width / 2 : 0;
    const y = rect && clientY !== undefined ? clientY - rect.top - rect.height / 2 : 0;
    const old = zoomRef.current;
    const nextPan = { x: x - (x - panRef.current.x) * next / old, y: y - (y - panRef.current.y) * next / old };
    zoomRef.current = next; setZoom(next); setPan(boundPan(nextPan, next));
  };
  function fit() { zoomRef.current = 1; setZoom(1); setPan({ x: 0, y: 0 }); }
  const pause = useCallback(() => { video.current?.pause(); compositionPlayer.current?.pause(); setPlaying(false); }, []);
  function acknowledge(at: number) { timeRef.current = at; setTime(at); }
  function seek(at: number, quantize = true) {
    const target = quantize ? quantizeVideoSignal(at, duration, fps) : Math.max(0, Math.min(duration - 1e-7, at));
    pause(); presented.current = null; acknowledge(target); setHint('');
    if (composition) { setSeeking(true); compositionPlayer.current?.seek(target); }
    const node = video.current;
    if (node && node.readyState > 0) {
      // Seek just inside a frame. Container PTS rounding can otherwise make
      // an exact n/fps boundary display the preceding frame in Chromium.
      try { setSeeking(true); node.currentTime = Math.min(duration - 1e-7, target + .00001); } catch { setSeeking(false); }
    }
    const ruler = timeline.current, position = target * pixelsPerSecond;
    if (ruler && !markerDrag.current && (position < ruler.scrollLeft || position > ruler.scrollLeft + ruler.clientWidth - 30))
      ruler.scrollLeft = Math.max(0, position - ruler.clientWidth / 2);
  }
  function changeTimelineZoom(value: number) {
    const node = timeline.current;
    const oldPosition = timeRef.current * pixelsPerSecond - (node?.scrollLeft || 0);
    const anchor = oldPosition >= 0 && oldPosition < timelineWidth ? oldPosition : timelineWidth / 2;
    setTimelineZoom(value);
    requestAnimationFrame(() => {
      if (node) node.scrollLeft = Math.max(0, timeRef.current * timelineWidth * value / 100 / Math.max(duration, .001) - anchor);
    });
  }
  async function togglePlay() {
    if (composition) {
      if (!ready || saving) return;
      if (playing) pause(); else compositionPlayer.current?.play();
      return;
    }
    const node = video.current;
    if (!node || !ready || saving) return;
    if (!node.paused) { pause(); return; }
    try {
      if (node.ended || node.currentTime >= duration - .001) node.currentTime = 0;
      node.playbackRate = rate;
      await node.play();
    } catch (e) { if ((e as DOMException).name !== 'AbortError') setVideoError('Playback was blocked. Try Play again, or use the compatible preview.'); }
  }
  function record(next: number[]) {
    const normalized = normalize(next, duration);
    if (same(signalsRef.current, normalized)) return;
    const previous = signalsRef.current;
    setHistory(h => [...h.slice(-99), previous]); setFuture([]);
    signalsRef.current = normalized; setSignals(normalized); setCloseHint(false); setHint('');
  }
  function selectSignal(at: number) {
    setSelected(at); seek(at, false);
    setPage(Math.floor(Math.max(0, signalsRef.current.findIndex(s => Math.abs(s - at) < 1e-8)) / PAGE_SIZE));
  }
  function addSignal(at?: number) {
    const node = video.current;
    if (saving || !ready || (at === undefined && (seeking || node?.seeking))) { setHint('Wait for the requested frame to finish decoding.'); return; }
    const shown = at ?? (composition && !playing ? timeRef.current : presented.current) ?? (node?.paused ? timeRef.current : node?.currentTime) ?? timeRef.current;
    const target = at === undefined ? Math.max(0, Math.min(duration - 1e-7, shown)) : quantizeVideoSignal(at, duration, fps);
    const existing = signalsRef.current.find(s => Math.abs(s - target) < .25 / fps);
    if (existing !== undefined) { setSelected(existing); setHint('This frame already has a signal.'); return; }
    record([...signalsRef.current, target]); setSelected(target);
    setPage(Math.floor(signalsRef.current.indexOf(target) / PAGE_SIZE));
  }
  function removeSignal(at = selected) {
    if (saving || at === null) return;
    record(signalsRef.current.filter(s => Math.abs(s - at) >= 1e-8)); setSelected(null);
  }
  function updateSignal(old: number, value: number) {
    if (!Number.isFinite(value) || saving) return;
    const next = composition && Math.abs(value - duration) < 1e-7 ? duration : quantizeVideoSignal(value, duration, fps);
    record(signalsRef.current.map(s => Math.abs(s - old) < 1e-8 ? next : s)); selectSignal(next);
  }
  function undo() {
    const previous = history.at(-1); if (!previous || saving) return;
    const current = signalsRef.current;
    setFuture(f => [current, ...f]); setHistory(h => h.slice(0, -1));
    signalsRef.current = previous; setSignals(previous); setSelected(null); setCloseHint(false);
  }
  function redo() {
    const next = future[0]; if (!next || saving) return;
    const current = signalsRef.current;
    setHistory(h => [...h, current]); setFuture(f => f.slice(1));
    signalsRef.current = next; setSignals(next); setSelected(null); setCloseHint(false);
  }
  async function save() {
    if (saving || markerDrag.current) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    pause(); setSaving(true); setError('');
    try { await onSave([...signalsRef.current], applyToExisting); }
    catch (e) { setError(`Labels could not be saved: ${(e as Error).message}`); }
    finally { setSaving(false); }
  }
  function requestClose() { if (saving) return; pause(); if (dirty) setCloseHint(true); else onClose(); }
  function finishMarker(cancel = false) {
    const active = markerDrag.current; if (!active) return;
    cancelAnimationFrame(markerAnimation.current); markerPointer.current = null;
    markerDrag.current = null;
    if (cancel) { signalsRef.current = active.signals; setSignals(active.signals); selectSignal(active.time); }
    else if (!same(active.signals, signalsRef.current)) { setHistory(h => [...h.slice(-99), active.signals]); setFuture([]); }
  }
  const actions = useRef({ seek, addSignal, removeSignal, togglePlay, save, requestClose, undo, redo, finishMarker });
  actions.current = { seek, addSignal, removeSignal, togglePlay, save, requestClose, undo, redo, finishMarker };

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    const node = video.current, modal = dialog.current;
    document.body.style.overflow = 'hidden'; modal?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && modal) {
        const focusable = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (markerDrag.current) actions.current.finishMarker(true);
        else if (panDrag.current) { setPan(panDrag.current.pan); panDrag.current = null; }
        else actions.current.requestClose();
        return;
      }
      if (markerDrag.current) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      const target = event.target as HTMLElement;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); void actions.current.save(); return; }
      if (target.matches('input,textarea,select') || target.isContentEditable) return;
      if ((event.key === ' ' || event.key === 'Enter') && target.closest('button')) return;
      let handled = true;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { if (event.shiftKey) actions.current.redo(); else actions.current.undo(); }
      else if (event.key === ' ') void actions.current.togglePlay();
      else if (event.key.toLowerCase() === 'm') actions.current.addSignal();
      else if (event.key === 'Delete' || event.key === 'Backspace') actions.current.removeSignal();
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') actions.current.seek(timeRef.current + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1) / fps);
      else if (event.key === '+' || event.key === '=') zoomAction.current(zoomRef.current * 1.25);
      else if (event.key === '-') zoomAction.current(zoomRef.current / 1.25);
      else handled = false;
      if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      cancelAnimationFrame(markerAnimation.current);
      window.removeEventListener('keydown', key, true); node?.pause();
      if (node) { node.removeAttribute('src'); node.load(); }
      document.body.style.overflow = bodyOverflow;
      if (document.fullscreenElement === modal) void document.exitFullscreen().catch(() => undefined);
      requestAnimationFrame(() => previousFocus?.isConnected && previousFocus.focus());
    };
  }, [fps]);

  useEffect(() => {
    if (composition) return;
    const node = video.current;
    if (!node?.requestVideoFrameCallback) return;
    let stopped = false, callback = 0;
    const observe = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      presented.current = metadata.mediaTime;
      if (!node.seeking) acknowledge(metadata.mediaTime);
      callback = node.requestVideoFrameCallback(observe);
    };
    callback = node.requestVideoFrameCallback(observe);
    return () => { stopped = true; node.cancelVideoFrameCallback(callback); };
  }, [source, composition]);
  useEffect(() => {
    if (composition) return;
    pause(); setReady(false); setSeeking(false); setVideoError(''); presented.current = null;
  }, [source, pause, composition]);
  useEffect(() => {
    const stageNode = stage.current, timelineNode = timeline.current;
    if (!stageNode || !timelineNode) return;
    const observe = new ResizeObserver(() => {
      setStageSize({ width: stageNode.clientWidth, height: stageNode.clientHeight }); setTimelineWidth(timelineNode.clientWidth);
    });
    observe.observe(stageNode); observe.observe(timelineNode);
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoomAction.current(zoomRef.current * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY); };
    stageNode.addEventListener('wheel', wheel, { passive: false });
    return () => { observe.disconnect(); stageNode.removeEventListener('wheel', wheel); };
  }, []);
  useEffect(() => { setPan(value => boundPan(value)); }, [stageSize.width, stageSize.height]);
  useEffect(() => {
    if (!playing || !timeline.current) return;
    const left = time * pixelsPerSecond, node = timeline.current;
    if (left < node.scrollLeft || left > node.scrollLeft + node.clientWidth - 35) node.scrollLeft = Math.max(0, left - 80);
  }, [time, playing, pixelsPerSecond]);

  function beginPan(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button,input,select')) return;
    if (event.button !== 0 || zoomRef.current <= 1) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    panDrag.current = { x: event.clientX, y: event.clientY, pan: panRef.current, pointer: event.pointerId };
  }
  function movePan(event: ReactPointerEvent<HTMLDivElement>) {
    const old = panDrag.current; if (!old || old.pointer !== event.pointerId) return;
    setPan(boundPan({ x: old.pan.x + event.clientX - old.x, y: old.pan.y + event.clientY - old.y }));
  }
  function beginMarker(event: ReactPointerEvent, at: number) {
    event.stopPropagation(); event.preventDefault(); if (saving || event.button !== 0) return;
    markerDrag.current = { x: event.clientX, time: at, scroll: timeline.current?.scrollLeft || 0, signals: [...signalsRef.current], pointer: event.pointerId };
    track.current?.setPointerCapture(event.pointerId); selectSignal(at);
    markerPointer.current = { x: event.clientX, pointer: event.pointerId };
    const scroll = () => {
      const point = markerPointer.current, node = timeline.current;
      if (!markerDrag.current || !point || !node) return;
      const rect = node.getBoundingClientRect();
      const delta = point.x < rect.left + 28 ? -Math.min(20, (rect.left + 28 - point.x) * .4)
        : point.x > rect.right - 28 ? Math.min(20, (point.x - rect.right + 28) * .4) : 0;
      const before = node.scrollLeft; node.scrollLeft += delta;
      if (node.scrollLeft !== before) markerMove.current(point.x, point.pointer);
      markerAnimation.current = requestAnimationFrame(scroll);
    };
    markerAnimation.current = requestAnimationFrame(scroll);
  }
  markerMove.current = (clientX, pointer) => {
    const old = markerDrag.current; if (!old || old.pointer !== pointer) return;
    const delta = (clientX - old.x + (timeline.current?.scrollLeft || 0) - old.scroll) / pixelsPerSecond;
    const value = quantizeVideoSignal(old.time + delta, duration, fps);
    const next = normalize(old.signals.map(s => Math.abs(s - old.time) < 1e-8 ? value : s), duration);
    signalsRef.current = next; setSignals(next); setSelected(value); seek(value, false);
  };
  function moveMarker(event: ReactPointerEvent) {
    markerPointer.current = { x: event.clientX, pointer: event.pointerId };
    markerMove.current(event.clientX, event.pointerId);
  }
  const totalPages = Math.max(1, Math.ceil(signals.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  return <div className="video-signal-overlay">
    <section ref={dialog} className="video-signal-editor" role="dialog" aria-modal="true" aria-label="Video beat labels" tabIndex={-1}>
      <header className="signal-editor-header"><div><span className="signal-editor-eyebrow"><Flag size={13} /> VIDEO BEAT LABELER</span><h2>{media.name}</h2></div>
        <span className={`signal-editor-save-status ${dirty ? 'dirty' : ''}`}>{dirty ? 'Unsaved labels' : composition ? 'Timeline clip labels' : 'Source labels'} · {signals.length} signals</span>
        <button type="button" aria-label="Close video labeler" title="Close video labeler" disabled={saving} onClick={requestClose}><X size={20} /></button></header>
      <div className="signal-editor-tools"><div className="signal-editor-zoom"><span>IMAGE ZOOM</span><button type="button" aria-label="Zoom video out" onClick={() => zoomAction.current(zoom / 1.25)} disabled={zoom <= 1}><Minus size={14} /></button>
        <input type="range" aria-label="Video zoom" min="100" max="800" step="10" value={Math.round(zoom * 100)} onChange={e => zoomAction.current(Number(e.target.value) / 100)} /><output>{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label="Zoom video in" onClick={() => zoomAction.current(zoom * 1.25)} disabled={zoom >= 8}><Plus size={14} /></button><button type="button" onClick={fit} title="Fit image and reset pan"><RotateCcw size={13} />Fit</button></div>
        <label className="signal-editor-quality">QUALITY<select aria-label="Video labeler quality" value={quality} onChange={e => setQuality(e.target.value as typeof quality)}><option value="proxy">Compatible preview</option><option value="original" disabled={!originalAvailable}>Original resolution</option></select></label>
        <button type="button" aria-label={muted ? 'Unmute labeling video' : 'Mute labeling video'} onClick={() => setMuted(v => !v)}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
        <button type="button" aria-label="Fullscreen video labeler" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void dialog.current?.requestFullscreen().catch(() => setHint('Fullscreen is unavailable in this browser. The large labeler remains usable.')); }}><Maximize2 size={15} /></button>
      </div>
      <div className="signal-editor-body"><div className="signal-editor-viewer">
        <div ref={stage} className={`signal-editor-stage ${zoom > 1 ? 'zoomed' : ''}`} data-zoom={zoom.toFixed(3)} data-pan-x={pan.x.toFixed(2)} data-pan-y={pan.y.toFixed(2)}
          onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={() => { panDrag.current = null; }} onPointerCancel={() => { if (panDrag.current) setPan(panDrag.current.pan); panDrag.current = null; }}
          onDoubleClick={e => zoom > 1 ? fit() : zoomAction.current(2, e.clientX, e.clientY)}>
          {composition ? <CompositionSignalPlayer ref={compositionPlayer} clip={composition.clip} media={composition.media} initialTime={initialTime} rate={rate} quality={quality} muted={muted}
            style={{ width: fitWidth * zoom, height: fitHeight * zoom, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)` }}
            onPosition={(at, shown) => { presented.current = shown; acknowledge(at); }} onReady={setReady} onSeeking={setSeeking} onPlaying={setPlaying} onError={setVideoError} />
          : <video ref={video} className="signal-editor-video" src={source} playsInline preload="auto" muted={muted} draggable={false}
            style={{ width: fitWidth * zoom, height: fitHeight * zoom, transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)` }}
            onLoadedMetadata={() => { const node = video.current; if (!node) return; node.playbackRate = rate; if (timeRef.current > 0) node.currentTime = Math.min(timeRef.current + .00001, duration - 1e-7); }}
            onLoadedData={() => { setReady(true); setSeeking(false); }} onCanPlay={() => setReady(true)}
            onSeeking={() => setSeeking(true)} onSeeked={() => { setSeeking(false); if (video.current) acknowledge(presented.current ?? timeRef.current); }}
            onTimeUpdate={() => { if (video.current && !video.current.seeking) acknowledge(presented.current ?? (video.current.paused ? timeRef.current : video.current.currentTime)); }}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
            onError={() => { setReady(false); setVideoError(quality === 'original' ? 'The browser cannot decode this original. Switch to the compatible preview; the original file stays unchanged.' : 'The video preview could not load. Re-import this video if its local source is missing.'); }} />}
          {!ready && !videoError && <div className="signal-editor-loading">Loading video frames…</div>}
          <div className="signal-editor-stage-info"><span>{seeking ? 'SEEKING FRAME' : `FRAME ${frame}`}</span><span>{zoom > 1 ? 'Drag to pan · wheel to zoom' : 'Wheel to zoom · double-click for 200%'}</span></div>
          {videoError && <div className="signal-editor-video-error"><p>{videoError}</p>{quality === 'original' && <button type="button" className="button subtle" onClick={() => setQuality('proxy')}>Use compatible preview</button>}</div>}
        </div>
        <div className="signal-editor-transport"><div className="signal-editor-time"><strong>{time.toFixed(3)}s</strong><span>/ {duration.toFixed(3)}s · {fps.toFixed(3).replace(/\.?0+$/, '')} fps</span></div>
          <div className="signal-editor-playback"><button type="button" aria-label="Back ten frames" title="Back ten frames (Shift+←)" disabled={!ready || saving} onClick={() => seek(timeRef.current - 10 / fps)}><SkipBack size={15} /></button>
            <button type="button" aria-label="Previous frame" title="Previous frame (←)" disabled={!ready || saving} onClick={() => seek(timeRef.current - 1 / fps)}><ChevronLeft size={19} /></button>
            <button type="button" className="signal-editor-play" aria-label={playing ? 'Pause labeling video' : 'Play labeling video'} title="Play / pause (Space)" disabled={!ready || saving} onClick={() => void togglePlay()}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
            <button type="button" aria-label="Next frame" title="Next frame (→)" disabled={!ready || saving} onClick={() => seek(timeRef.current + 1 / fps)}><ChevronRight size={19} /></button>
            <button type="button" aria-label="Forward ten frames" title="Forward ten frames (Shift+→)" disabled={!ready || saving} onClick={() => seek(timeRef.current + 10 / fps)}><SkipForward size={15} /></button></div>
          <label>SPEED<select aria-label="Video labeling playback speed" value={rate} onChange={e => { const next = Number(e.target.value); setRate(next); if (video.current) video.current.playbackRate = next; }}><option value={.25}>0.25×</option><option value={.5}>0.5×</option><option value={1}>1×</option></select></label></div>
        <input className="signal-editor-scrubber" type="range" aria-label="Source video scrubber" min={0} max={lastFrame / fps} step={1 / fps} value={Math.min(time, lastFrame / fps)} disabled={!ready || saving} onChange={e => seek(Number(e.target.value))} />
        <div className="signal-editor-position"><label>TIME · SEC<PositionField label="Source video time" value={time} digits={6} step={1 / fps} max={lastFrame / fps} disabled={!ready || saving} onFocus={pause} onCommit={value => { if (ready && !saving) seek(value); }} /></label>
          <label>FRAME<PositionField label="Source video frame" value={frame} digits={0} step={1} max={lastFrame} disabled={!ready || saving} onFocus={pause} onCommit={value => { if (ready && !saving) seek(value / fps); }} /></label>
          <button type="button" className="button primary signal-editor-add" aria-label="Add signal" title="Add signal at the displayed frame (M)" disabled={!ready || seeking || saving} onClick={() => addSignal()}><Flag size={14} />Add signal<kbd>M</kbd></button>
        </div>
      </div><aside className="signal-editor-sidebar"><div className="signal-editor-list-heading"><strong>BEAT SIGNALS</strong><span>{signals.length}</span></div>
        <p>{composition ? 'Mark this combined clip across its cuts. Times are local to the clip, including its current speeds.' : 'Mark the visual moments you want to align with music beats.'}</p><div className="signal-editor-history"><button type="button" aria-label="Undo video signal edit" disabled={!history.length || saving} onClick={undo}><Undo2 size={14} />Undo</button><button type="button" aria-label="Redo video signal edit" disabled={!future.length || saving} onClick={redo}><Redo2 size={14} />Redo</button></div>
        <div className="signal-editor-list">{signals.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).map((at, i) => {
          const index = safePage * PAGE_SIZE + i;
          return <div key={at} className={`signal-editor-row ${selected !== null && Math.abs(selected - at) < 1e-8 ? 'selected' : ''}`} data-signal-time={at.toFixed(9)}>
            <button type="button" className="signal-editor-select" aria-label={`Go to signal ${index + 1}`} onClick={() => selectSignal(at)}>#{index + 1}</button>
            <input type="number" aria-label={`Signal ${index + 1} time`} defaultValue={at.toFixed(6)} step={1 / fps} min={0} max={composition ? duration : lastFrame / fps} disabled={saving} onBlur={e => {
              if (e.target.value.trim() && Number.isFinite(Number(e.target.value)) && Math.abs(Number(e.target.value) - Number(at.toFixed(6))) > 1e-10)
                updateSignal(at, Number(e.target.value));
            }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
            <button type="button" aria-label={`Delete signal ${index + 1}`} disabled={saving} onClick={() => removeSignal(at)}><Trash2 size={13} /></button></div>;
        })}{!signals.length && <div className="signal-editor-no-labels"><Flag size={25} /><span>Seek a frame and press M to add your first signal.</span></div>}</div>
        {totalPages > 1 && <div className="signal-editor-pages"><button type="button" disabled={!safePage} onClick={() => setPage(safePage - 1)}>Previous</button><span>{safePage + 1} / {totalPages}</span><button type="button" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>Next</button></div>}
        <button type="button" className="button subtle full" disabled={selected === null || saving} onClick={() => removeSignal()}><Trash2 size={13} />Delete selected signal</button>
      </aside></div>
      <section className="signal-editor-timeline-section" aria-label="Source signal timeline"><div className="signal-editor-timeline-heading"><span>{composition ? 'CLIP TIMELINE' : 'SOURCE TIMELINE'} · drag signals to adjust</span><label>TIMELINE ZOOM<input type="range" aria-label="Signal timeline zoom" min="100" max="3200" step="100" value={timelineZoom} onChange={e => changeTimelineZoom(Number(e.target.value))} /><output>{(timelineZoom / 100).toFixed(0)}×</output></label></div>
        <div ref={timeline} className="signal-editor-timeline-scroll" onScroll={e => setScrollLeft(e.currentTarget.scrollLeft)}><div ref={track} className="signal-editor-track" style={{ width }}
          onPointerDown={e => { if (e.button === 0 && !saving) seek((e.clientX - e.currentTarget.getBoundingClientRect().left) / pixelsPerSecond); }}
          onPointerMove={moveMarker} onPointerUp={() => finishMarker()} onPointerCancel={() => finishMarker(true)}
          onDoubleClick={e => { if (!(e.target as HTMLElement).closest('.signal-editor-marker')) addSignal((e.clientX - e.currentTarget.getBoundingClientRect().left) / pixelsPerSecond); }}>
          {ticks.map(at => <span key={at.toFixed(6)} className="signal-editor-tick" style={{ left: at * pixelsPerSecond }}>{at.toFixed(tickStep < 1 ? 1 : 0)}s</span>)}
          <svg width={width} height={80} className="signal-editor-wave" aria-hidden="true"><path d={wavePath} /></svg>
          {cuts.filter(cut => cut.end * pixelsPerSecond >= scrollLeft && cut.start * pixelsPerSecond <= scrollLeft + timelineWidth).map(cut => <span key={cut.index} className="signal-editor-cut" data-cut-start={cut.start.toFixed(9)} style={{ left: cut.start * pixelsPerSecond, width: (cut.end - cut.start) * pixelsPerSecond }} title={`${cut.index + 1}. ${cut.name} · ${cut.start.toFixed(3)}–${cut.end.toFixed(3)}s`}><span>{cut.index + 1} · {cut.name}</span></span>)}
          {signals.map((at, index) => ({ at, index })).filter(({ at }) => at * pixelsPerSecond >= scrollLeft - 24 && at * pixelsPerSecond <= scrollLeft + timelineWidth + 24).map(({ at, index }) => <button key={at} type="button" className={`signal-editor-marker ${selected !== null && Math.abs(selected - at) < 1e-8 ? 'selected' : ''}`} style={{ left: at * pixelsPerSecond }} aria-label={`Timeline signal ${index + 1}`} aria-pressed={selected !== null && Math.abs(selected - at) < 1e-8}
            onPointerDown={e => beginMarker(e, at)} onClick={e => { e.stopPropagation(); selectSignal(at); }} onDoubleClick={e => e.stopPropagation()}><span>{index + 1}</span></button>)}
          <div className="signal-editor-playhead" style={{ left: time * pixelsPerSecond }} aria-hidden="true" />
        </div></div></section>
      <footer className="signal-editor-footer"><div className="signal-editor-save-options">{composition ? <strong className="signal-editor-clip-scope">TIMELINE CLIP · {composition.clip.segments.length} parts</strong> : <label><input type="checkbox" aria-label="Apply labels to existing timeline clips" checked={applyToExisting} disabled={saving} onChange={e => setApplyToExisting(e.target.checked)} />Also apply to existing unlocked video clips</label>}
        <p>{composition ? 'Save updates this clip only. Its current frame timing stays the same; run Sync again to align the revised signals. Library labels and other clips stay unchanged.' : <>Labels are saved with the source, not burned into video. New timeline clips use them automatically.{applyToExisting && ' Existing clips keep their frame timing; run Sync again for the new signals.'}</>}</p></div>
        <div className="signal-editor-footer-actions"><button type="button" className="button subtle" disabled={saving} onClick={() => { pause(); onClose(); }}>Cancel</button><button type="button" className="button primary" disabled={saving} onClick={() => void save()}><Check size={15} />{saving ? 'Saving labels…' : 'Save labels'}</button></div></footer>
      {(hint || closeHint) && <div className="signal-editor-notice" role="status">{closeHint ? 'There are unsaved labels. Save labels to keep them, or Cancel to discard them.' : hint}</div>}
      {error && <div className="signal-editor-notice error" role="alert">{error}</div>}
      <div className="signal-editor-shortcuts"><span>← / → frame · Shift: 10 frames · Space play · M signal · Delete remove · Ctrl+Z undo · Ctrl+S save</span><span>Zoom and pan only affect this viewer.</span></div>
    </section>
  </div>;
}
