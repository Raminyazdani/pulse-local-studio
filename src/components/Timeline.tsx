import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Film, Music2, Plus, Eye, EyeOff, Volume2, VolumeX, LockKeyhole, UnlockKeyhole, Trash2, Layers2, Magnet, Minus, Maximize2, Flag, MousePointer2, MoveHorizontal } from 'lucide-react';
import type { Clip, Project, Track } from '../lib/types';
import { clipDuration, editRange, editSourceClip, flattenClip, projectDuration, sourceToOutput, outputToSource, resolveClipTime, slipClip, trimClip, formatTime } from '../lib/engine';
import { visibleBeats } from '../editor';
import { ClipWaveform } from './Waveform';
import './Timeline.css';

interface Props {
  project: Project; time: number; selected: string[]; selectedTrack: string; zoom: number;
  tool: 'select' | 'marker' | 'slip';
  onTime: (time: number) => void; onSelect: (ids: string[]) => void; onTrack: (id: string) => void;
  onZoom: (zoom: number) => void; onTool: (tool: 'select' | 'marker' | 'slip') => void;
  onChange: (project: Project) => void; onAddTrack: (kind: 'video' | 'audio') => void;
  onDropMedia: (mediaId: string, trackId: string, time: number) => void;
  onMarker: (clipId: string, localOutput: number) => void; onMerge: () => void;
  onLabelClip?: (clipId: string) => void;
  labelingDisabled?: boolean;
  onEditPreview?: (clips: Clip[] | null, time?: number) => void;
  selectedBeats?: { clipId: string; times: number[] };
  repeatPreview?: { clipId: string; times: number[] } | null;
  onBeatSelect?: (clipId: string, time: number, additive: boolean, range: boolean) => void;
}
type DragType = 'move' | 'left' | 'right' | 'signal' | 'slip';
type Drag = {
  type: DragType; pointer: number; original: Clip; draft: Clip; x: number; y: number;
  scroll: number; time: number; signal?: number; moved: boolean;
  snapTargets: number[]; snapAt?: number; error?: string;
  selectionOnClick?: string[];
};
const HEADER = 168, ROW = 92, PITCH = 2;

function sourceReadout(clip: Clip) {
  const duration = clipDuration(clip);
  return { start: resolveClipTime(clip, 0)?.time ?? 0,
    end: resolveClipTime(clip, Math.max(0, duration - 1e-7))?.time ?? duration };
}

export function Timeline(p: Props) {
  const selectedBeatKeys = useMemo(() => new Set(p.selectedBeats?.times.map(t => t.toFixed(6)) ?? []), [p.selectedBeats]);
  const [snap, setSnap] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [scrollLeft, setScrollLeft] = useState(0);
  const panel = useRef<HTMLElement>(null), viewport = useRef<HTMLDivElement>(null);
  const latest = useRef(p); latest.current = p;
  const snapEnabled = useRef(snap); snapEnabled.current = snap;
  const dragRef = useRef<Drag | null>(null);
  const lastPointer = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  const animation = useRef(0), rulerDragging = useRef<number | null>(null);
  const finishRef = useRef<(cancel?: boolean) => void>(() => undefined);
  const moveRef = useRef<(x: number, y: number, shift: boolean) => void>(() => undefined);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewportWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (dragRef.current) return;
      const props = latest.current;
      const pointer = Math.max(0, event.clientX - node.getBoundingClientRect().left - HEADER);
      const anchor = (node.scrollLeft + pointer) / props.zoom;
      const next = Math.max(6, Math.min(400, props.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
      props.onZoom(next);
      requestAnimationFrame(() => { node.scrollLeft = Math.max(0, anchor * next - pointer); });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = dragRef.current;
      if (active && event.pointerId === active.pointer) {
        event.preventDefault();
        lastPointer.current = { x: event.clientX, y: event.clientY, shift: event.shiftKey };
        moveRef.current(event.clientX, event.clientY, event.shiftKey);
      } else if (rulerDragging.current === event.pointerId) {
        const node = viewport.current;
        if (node) {
          const local = event.clientX - node.getBoundingClientRect().left + node.scrollLeft - HEADER;
          latest.current.onTime(Math.max(0, Math.min(projectDuration(latest.current.project), local / latest.current.zoom)));
        }
      }
    };
    const finish = (event: PointerEvent) => {
      if (dragRef.current?.pointer === event.pointerId) finishRef.current(event.type === 'pointercancel');
      rulerDragging.current = null;
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dragRef.current) {
        event.preventDefault(); event.stopImmediatePropagation(); finishRef.current(true);
      }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', cancel, true);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish); window.removeEventListener('keydown', cancel, true);
      cancelAnimationFrame(animation.current);
    };
  }, []);

  const total = Math.max(30, projectDuration(p.project) + 8, drag ? drag.draft.start + clipDuration(drag.draft) + 4 : 0);
  const width = Math.max(total * p.zoom, viewportWidth - HEADER);
  const step = p.zoom < 16 ? 10 : p.zoom < 36 ? 5 : p.zoom < 90 ? 2 : p.zoom < 220 ? 1 : .5;
  const grid = useMemo(() => Array.from({ length: Math.floor(width / p.zoom / step) + 1 }, (_, index) => index * step), [width, p.zoom, step]);

  function targets(project: Project, exclude: string, type: DragType): number[] {
    const own = project.clips.find(clip => clip.id === exclude);
    const ownIsAudio = project.tracks.find(track => track.id === own?.trackId)?.kind === 'audio';
    const trimBeats = own && ownIsAudio && (type === 'left' || type === 'right') ? visibleBeats(own, project) : [];
    return [0, p.time, ...trimBeats, ...project.clips.filter(clip => clip.id !== exclude).flatMap(clip => {
      const isAudio = project.tracks.find(track => track.id === clip.trackId)?.kind === 'audio';
      return [clip.start, clip.start + clipDuration(clip), ...(isAudio ? visibleBeats(clip, project) : [])];
    })];
  }
  function snapEdge(value: number, active: Drag, bypass: boolean): { value: number; at?: number } {
    if (!snapEnabled.current || bypass) return { value };
    let found = value, threshold = 8 / latest.current.zoom, at: number | undefined;
    for (const target of active.snapTargets) if (Math.abs(value - target) < threshold) {
      threshold = Math.abs(value - target); found = target; at = target;
    }
    return { value: found, at };
  }
  function notifyPreview(active: Drag) {
    const clips = latest.current.project.clips.map(clip => clip.id === active.original.id ? active.draft : clip);
    let previewTime: number | undefined;
    if (active.type === 'left') previewTime = active.draft.start;
    if (active.type === 'right') previewTime = active.draft.start + Math.max(0, clipDuration(active.draft) - .001);
    if (active.type === 'slip') previewTime = Math.max(active.draft.start, Math.min(active.time, active.draft.start + clipDuration(active.draft) - .001));
    latest.current.onEditPreview?.(clips, previewTime);
  }
  moveRef.current = (x, y, bypass) => {
    const active = dragRef.current, props = latest.current;
    if (!active) return;
    const delta = (x - active.x + (viewport.current?.scrollLeft ?? 0) - active.scroll) / props.zoom;
    const original = active.original;
    let draft = { ...original }, snappedAt: number | undefined, error: string | undefined;
    const moved = active.moved || Math.abs(x - active.x) > 2 || Math.abs(y - active.y) > 3;
    try {
      if (active.type === 'move') {
        const start = snapEdge(original.start + delta, active, bypass);
        const end = snapEdge(original.start + delta + clipDuration(original), active, bypass);
        const startCorrection = Math.abs(start.value - (original.start + delta));
        const endCorrection = Math.abs(end.value - (original.start + delta + clipDuration(original)));
        if (end.at !== undefined && (start.at === undefined || endCorrection < startCorrection)) {
          draft.start = Math.max(0, end.value - clipDuration(original)); snappedAt = end.at;
        } else { draft.start = Math.max(0, start.value); snappedAt = start.at; }
        const row = document.elementFromPoint(x, y)?.closest('[data-track-id]');
        const target = props.project.tracks.find(track => track.id === row?.getAttribute('data-track-id'));
        const own = props.project.tracks.find(track => track.id === original.trackId);
        if (target && !target.locked && target.kind === own?.kind) draft.trackId = target.id;
      } else if (active.type === 'left') {
        const edge = snapEdge(original.start + delta, active, bypass);
        draft = trimClip(original, Math.min(original.start + clipDuration(original) - .04, Math.max(0, edge.value)), original.start + clipDuration(original), props.project.media);
        snappedAt = Math.abs(draft.start - edge.value) < 1e-6 ? edge.at : undefined;
      } else if (active.type === 'right') {
        const edge = snapEdge(original.start + clipDuration(original) + delta, active, bypass);
        draft = trimClip(original, original.start, Math.max(original.start + .04, edge.value), props.project.media);
        snappedAt = Math.abs(draft.start + clipDuration(draft) - edge.value) < 1e-6 ? edge.at : undefined;
      } else if (active.type === 'slip') {
        // Drag content directly: moving it left reveals later source.
        draft = slipClip(original, -delta, props.project.media);
      } else if (active.signal !== undefined) {
        const values = [...original.signals];
        const edge = snapEdge(original.start + sourceToOutput(original, values[active.signal]) + delta, active, bypass);
        const local = Math.min(clipDuration(original) - .001, Math.max(0, edge.value - original.start));
        values[active.signal] = outputToSource(original, local);
        draft.signals = values.sort((a, b) => a - b); draft.warp = undefined; snappedAt = edge.at;
      }
    } catch (failure) { draft = active.draft; error = (failure as Error).message; }
    const next = { ...active, draft, moved, snapAt: snappedAt, error };
    dragRef.current = next; setDrag(next);
    if (moved) {
      if (!panel.current?.hasPointerCapture(active.pointer)) panel.current?.setPointerCapture(active.pointer);
      notifyPreview(next);
    }
  };
  function startAutoScroll() {
    const tick = () => {
      if (!dragRef.current) return;
      const point = lastPointer.current, node = viewport.current;
      if (point && node) {
        const rect = node.getBoundingClientRect(), left = rect.left + HEADER + 32, right = rect.right - 32;
        const amount = point.x < left ? -Math.min(22, (left - point.x) * .4) : point.x > right ? Math.min(22, (point.x - right) * .4) : 0;
        const before = node.scrollLeft;
        if (amount) node.scrollLeft += amount;
        if (node.scrollLeft !== before) moveRef.current(point.x, point.y, point.shift);
      }
      animation.current = requestAnimationFrame(tick);
    };
    animation.current = requestAnimationFrame(tick);
  }
  function begin(event: ReactPointerEvent, clip: Clip, requested: DragType, signal?: number) {
    event.stopPropagation();
    if (event.button !== 0) return;
    const track = p.project.tracks.find(item => item.id === clip.trackId);
    p.onTrack(clip.trackId);
    const type = requested === 'move' && (p.tool === 'slip' || event.altKey) ? 'slip' : requested;
    let selectionOnClick: string[] | undefined;
    if (requested === 'move') {
      if (p.tool === 'marker' && !track?.locked) {
        p.onMarker(clip.id, (event.clientX - event.currentTarget.getBoundingClientRect().left) / p.zoom); return;
      }
      if (type === 'slip') p.onSelect([clip.id]);
      else if (event.shiftKey && p.selected.includes(clip.id)) {
        // Shift is also the drag-time snap override. Defer deselection until
        // this proves to be a click, so Shift-drag keeps its source inspector.
        selectionOnClick = p.selected.filter(id => id !== clip.id);
      } else p.onSelect(event.shiftKey ? [...p.selected, clip.id] : p.selected.includes(clip.id) ? p.selected : [clip.id]);
    } else p.onSelect([clip.id]);
    if (track?.locked) { if (selectionOnClick) p.onSelect(selectionOnClick); return; }
    if (type === 'slip' && !editRange(clip, p.project.media).canSlip) return;
    const editable = type === 'signal' ? flattenClip(clip) : clip;
    const active: Drag = { type, pointer: event.pointerId, original: editable, draft: editable,
      x: event.clientX, y: event.clientY, scroll: viewport.current?.scrollLeft ?? 0,
      time: p.time, moved: false, signal, selectionOnClick, snapTargets: targets(p.project, clip.id, type) };
    dragRef.current = active; lastPointer.current = { x: event.clientX, y: event.clientY, shift: event.shiftKey }; setDrag(active);
    // Delay capture for a body click until it becomes a drag. Capturing the
    // stable panel immediately would retarget clicks and suppress dblclick.
    if (type !== 'move' && type !== 'slip') panel.current?.setPointerCapture(event.pointerId);
    p.onEditPreview?.(p.project.clips); startAutoScroll();
  }
  finishRef.current = (cancel = false) => {
    const active = dragRef.current;
    if (!active) return;
    cancelAnimationFrame(animation.current); dragRef.current = null; lastPointer.current = null; setDrag(null);
    if (panel.current?.hasPointerCapture(active.pointer)) panel.current.releasePointerCapture(active.pointer);
    const props = latest.current;
    if (!cancel && !active.moved && active.selectionOnClick) props.onSelect(active.selectionOnClick);
    if (!cancel && active.moved && JSON.stringify(active.original) !== JSON.stringify(active.draft)) {
      props.onChange({ ...props.project, clips: props.project.clips.map(clip => clip.id === active.original.id ? active.draft : clip) });
      props.onEditPreview?.(null);
    } else props.onEditPreview?.(null, active.time);
  };
  function toggle(track: Track, key: 'muted' | 'hidden' | 'locked') {
    p.onChange({ ...p.project, tracks: p.project.tracks.map(item => item.id === track.id ? { ...item, [key]: !item[key] } : item) });
  }
  function seek(event: ReactPointerEvent) {
    if (event.button !== 0 || !viewport.current) return;
    event.preventDefault();
    const node = viewport.current, local = event.clientX - node.getBoundingClientRect().left + node.scrollLeft - HEADER;
    p.onTime(Math.max(0, Math.min(projectDuration(p.project), local / p.zoom)));
    rulerDragging.current = event.pointerId; panel.current?.setPointerCapture(event.pointerId);
  }
  const activeRange = drag ? editRange(drag.draft, p.project.media) : undefined;
  const activeSource = drag ? sourceReadout(drag.draft) : undefined;
  const sourceGhost = drag && ['left', 'right', 'slip'].includes(drag.type) ? editSourceClip(drag.draft, p.project.media) : undefined;
  const visibleWaveform = (clip: Clip) => ({ visibleStart: Math.max(0, scrollLeft - clip.start * p.zoom - 24), visibleEnd: scrollLeft + viewportWidth - HEADER - clip.start * p.zoom + 24 });
  const labelClip = p.selected.length === 1 ? p.project.clips.find(clip => clip.id === p.selected[0] &&
    p.project.tracks.some(track => track.id === clip.trackId && track.kind === 'video' && !track.locked)) : undefined;

  return <section className={`timeline-panel ${drag ? 'is-dragging' : ''}`} ref={panel} aria-label="Editing timeline">
    <div className="timeline-toolbar">
      <div className="toolbar-group">
        <span className="panel-heading">TIMELINE</span><span className="subtle-tag">{p.project.tracks.length} tracks</span><span className="divider" />
        <button aria-label="Selection tool" title="Selection tool (V)" className={p.tool === 'select' ? 'tool-button active' : 'tool-button'} onClick={() => p.onTool('select')}><MousePointer2 size={15} /></button>
        <button aria-label="Beat marker tool" title="Beat marker tool (B). Click a clip to add a marker." className={p.tool === 'marker' ? 'tool-button active' : 'tool-button'} onClick={() => p.onTool('marker')}><Flag size={15} /></button>
        <button aria-label="Slip source tool" title="Slip source (Y) · move media inside a fixed clip" className={p.tool === 'slip' ? 'tool-button active' : 'tool-button'} onClick={() => p.onTool('slip')}><MoveHorizontal size={16} /></button>
        <button aria-pressed={snap} aria-label="Snap to beats" title="Snap to beats, playhead and clip edges · hold Shift to bypass" className={snap ? 'tool-button active' : 'tool-button'} onClick={() => setSnap(!snap)}><Magnet size={15} /></button>
      </div>
      <div className="toolbar-group timeline-zoom-tools">
        {p.onLabelClip && <button type="button" className="text-button" aria-label="Label selected video beats" title="Open the large beat labeler for the selected video, including merged clips"
          disabled={!labelClip || p.labelingDisabled || !!drag} onClick={() => labelClip && p.onLabelClip?.(labelClip.id)}><Flag size={15} /><span>Label beats</span></button>}
        <button className="text-button" title="Join all clips in selected track, closing gaps" onClick={p.onMerge}><Layers2 size={15} /><span>Merge track</span></button><span className="divider" />
        <button className="tool-button" onClick={() => p.onZoom(Math.max(6, p.zoom / 1.35))} title="Zoom out"><Minus size={14} /></button>
        <input aria-label="Timeline zoom" className="zoom-slider" type="range" min="6" max="400" value={p.zoom} onChange={event => p.onZoom(+event.target.value)} />
        <button className="tool-button" onClick={() => p.onZoom(Math.min(400, p.zoom * 1.35))} title="Zoom in"><Plus size={14} /></button>
        <button className="tool-button" title="Fit sequence" onClick={() => p.onZoom(Math.max(6, Math.min(400, (viewportWidth - HEADER - 24) / Math.max(8, projectDuration(p.project) + 2))))}><Maximize2 size={14} /></button>
      </div>
    </div>
    <div className="timeline-scroll" ref={viewport} onScroll={event => setScrollLeft(event.currentTarget.scrollLeft)}>
      <div className="timeline-content" style={{ width: width + HEADER }}>
        <div className="ruler-row"><div className="track-header ruler-label">TRACKS <span>SECONDS</span></div><div className="ruler" style={{ width }} onPointerDown={seek}>{grid.map(time => <span className="ruler-tick" key={time} style={{ left: time * p.zoom }}>{formatTime(time, step < 1 ? 1 : 0)}</span>)}</div></div>
        {p.project.tracks.map((track, index) => <div className={`track-row ${track.kind} ${p.selectedTrack === track.id ? 'chosen' : ''}`} key={track.id} data-track-id={track.id}>
          <div className="track-header" onClick={() => p.onTrack(track.id)}>
            <div className="track-name">{track.kind === 'video' ? <Film size={14} /> : <Music2 size={14} />}<input aria-label="Track name" disabled={track.locked} value={track.name} onChange={event => p.onChange({ ...p.project, tracks: p.project.tracks.map(item => item.id === track.id ? { ...item, name: event.target.value } : item) })} /><span className="track-number">{String(index + 1).padStart(2, '0')}</span></div>
            <div className="track-actions">
              <button className={track.muted ? 'enabled' : ''} aria-pressed={track.muted} title="Mute track" onClick={() => toggle(track, 'muted')}>{track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button>
              {track.kind === 'video' && <button className={track.hidden ? 'enabled' : ''} aria-pressed={track.hidden} title="Hide track" onClick={() => toggle(track, 'hidden')}>{track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>}
              <button className={track.locked ? 'enabled' : ''} aria-pressed={track.locked} title="Lock track" onClick={() => toggle(track, 'locked')}>{track.locked ? <LockKeyhole size={12} /> : <UnlockKeyhole size={12} />}</button>
              <button disabled={track.locked} title="Remove this track and its clips (undo available)" onClick={() => p.onChange({ ...p.project, tracks: p.project.tracks.filter(item => item.id !== track.id), clips: p.project.clips.filter(clip => clip.trackId !== track.id) })}><Trash2 size={12} /></button>
            </div>
          </div>
          <div className={`track-lane ${track.locked ? 'locked' : ''}`} style={{ width, backgroundSize: `${step * p.zoom}px 100%` }}
            onDragOver={event => { if (!track.locked) event.preventDefault(); }}
            onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('pulse/media'); if (id && !track.locked) p.onDropMedia(id, track.id, Math.max(0, (event.clientX - event.currentTarget.getBoundingClientRect().left) / p.zoom)); }}
            onPointerDown={event => { if (event.target === event.currentTarget) { p.onTrack(track.id); p.onSelect([]); seek(event); } }}>
            {!p.project.clips.some(clip => clip.trackId === track.id) && <span className="track-empty">{track.kind === 'video' ? 'Drop video or images here' : 'Drop your soundtrack here'}</span>}
            {sourceGhost && drag?.original.trackId === track.id && <div className={`source-ghost ${track.kind}`} aria-hidden="true" style={{ left: sourceGhost.start * p.zoom, width: clipDuration(sourceGhost) * p.zoom }}>{track.kind === 'audio' ? <ClipWaveform clip={sourceGhost} media={p.project.media} zoom={p.zoom} phase={0} {...visibleWaveform(sourceGhost)} /> : <div className="source-ghost-label">AVAILABLE SOURCE</div>}</div>}
            {p.project.clips.filter(clip => clip.trackId === track.id).map(original => {
              const clip = drag?.original.id === original.id ? drag.draft : original;
              const range = editRange(clip, p.project.media), clipWidth = Math.max(4, clipDuration(clip) * p.zoom);
              const media = p.project.media.find(item => item.id === clip.segments[0]?.mediaId);
              const beats = track.kind === 'audio' ? visibleBeats(clip, p.project) : [];
              const rowDelta = p.project.tracks.findIndex(item => item.id === clip.trackId) - index;
              return <div key={clip.id} data-clip-id={clip.id} data-source-in={range.in.toFixed(6)} data-source-out={range.out.toFixed(6)} data-clip-start={clip.start.toFixed(6)} data-clip-duration={clipDuration(clip).toFixed(6)}
                className={`timeline-clip ${track.kind} ${p.selected.includes(clip.id) ? 'selected' : ''} ${clip.warp ? 'warped' : ''} ${clip.muted ? 'muted' : ''} ${track.locked ? 'clip-locked' : ''} ${p.tool === 'slip' ? 'slip-tool' : ''} ${p.tool === 'marker' ? 'marker-tool' : ''} ${drag?.original.id === clip.id ? 'editing' : ''}`}
                style={{ left: clip.start * p.zoom, width: clipWidth, transform: rowDelta ? `translateY(${rowDelta * ROW}px)` : undefined }}
                onPointerDown={event => begin(event, original, 'move')}
                onDoubleClick={event => { if (p.tool === 'select' && !track.locked) p.onMarker(clip.id, (event.clientX - event.currentTarget.getBoundingClientRect().left) / p.zoom); }}>
                <div className="clip-content-mask">
                  {track.kind === 'video' && media?.thumbnailUrl && <div className="clip-thumbnails" style={{ backgroundImage: `url("${media.thumbnailUrl}")`, backgroundPositionX: `${-range.in * p.zoom}px` }} />}
                  {track.kind === 'audio' && <ClipWaveform clip={clip} media={p.project.media} zoom={p.zoom} phase={(range.in * p.zoom) % PITCH} {...visibleWaveform(clip)} />}
                  <div className="clip-label">{track.kind === 'video' ? <Film size={12} /> : <Music2 size={12} />}<span>{clip.name}</span>{clip.segments.length > 1 && <span className="clip-badge">{clip.segments.length} clips</span>}{clip.warp && <span className="clip-badge">↗ SYNC</span>}{clip.muted && <VolumeX size={12} />}</div>
                  <span className="clip-duration">{clipDuration(clip).toFixed(2)}s</span>{range.in > .001 && <span className="source-edge-label">IN {formatTime(range.in, 2)}</span>}
                </div>
                {beats.map((beat, beatIndex) => ({ beat, beatIndex })).filter(({ beat }) => beat * p.zoom >= scrollLeft - 24 && beat * p.zoom <= scrollLeft + viewportWidth - HEADER + 24).map(({ beat, beatIndex }) => {
                  const local = beat - clip.start;
                  const picked = p.selectedBeats?.clipId === clip.id && selectedBeatKeys.has(local.toFixed(6));
                  return <div key={beatIndex} className={`beat-line ${picked ? 'beat-picked' : ''}`} data-beat-time={local.toFixed(6)} style={{ left: local * p.zoom }}>
                    <button type="button" className="beat-number" aria-label={`Select timeline beat ${beatIndex + 1}`} aria-pressed={picked}
                      title={`Beat ${beatIndex + 1} · ${beat.toFixed(3)}s · Ctrl/Shift for multiple`}
                      onPointerDown={event => { event.stopPropagation(); }}
                      onDoubleClick={event => event.stopPropagation()}
                      onClick={event => { event.stopPropagation(); p.onBeatSelect?.(clip.id, local, event.ctrlKey || event.metaKey, event.shiftKey); }}>{beatIndex + 1}</button>
                  </div>;
                })}
                {p.repeatPreview?.clipId === clip.id && p.repeatPreview.times.filter(t => (clip.start + t) * p.zoom >= scrollLeft - 24 && (clip.start + t) * p.zoom <= scrollLeft + viewportWidth - HEADER + 24).map(t => <div key={t.toFixed(6)} className="beat-repeat-ghost" style={{ left: t * p.zoom }} aria-hidden="true" />)}
                {clip.signals.map((signal, signalIndex) => <div key={signalIndex} className="signal-line" style={{ left: sourceToOutput(clip, signal) * p.zoom }} title={`Signal ${signalIndex + 1} · right-click to remove`}
                  onPointerDown={event => begin(event, original, 'signal', signalIndex)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (track.locked) return; const flat = flattenClip(clip); p.onChange({ ...p.project, clips: p.project.clips.map(item => item.id === clip.id ? { ...flat, signals: flat.signals.filter((_, markerIndex) => markerIndex !== signalIndex) } : item) }); }}><span>{signalIndex + 1}</span></div>)}
                {!track.locked && <><div role="slider" aria-label={`Trim start of ${clip.name}`} aria-valuemin={0} aria-valuemax={range.total} aria-valuenow={range.in} className="trim-handle left" title="Trim start · drag outward to restore source" onPointerDown={event => begin(event, original, 'left')} /><div role="slider" aria-label={`Trim end of ${clip.name}`} aria-valuemin={0} aria-valuemax={range.total} aria-valuenow={range.out} className="trim-handle right" title="Trim end · drag outward to restore source" onPointerDown={event => begin(event, original, 'right')} /></>}
              </div>;
            })}
          </div>
        </div>)}
        <div className="add-track-row"><div className="track-header"><button onClick={() => p.onAddTrack('video')}><Plus size={12} />Video</button><button onClick={() => p.onAddTrack('audio')}><Plus size={12} />Audio</button></div><div className="timeline-footnote">{p.tool === 'marker' ? 'Click video to add a signal · click audio to correct a beat' : p.tool === 'slip' ? 'Drag content inside its fixed container · trim first to reveal source handles' : 'Drag to move · pull either edge to trim or restore · Alt-drag to slip · Shift bypasses snap'}</div></div>
        <div className="playhead" style={{ left: HEADER + p.time * p.zoom }}><div className="playhead-cap" /></div>
        {drag?.snapAt !== undefined && <div className="snap-guide" style={{ left: HEADER + drag.snapAt * p.zoom }}><span>SNAP</span></div>}
      </div>
    </div>
    {drag && activeRange && activeSource && <div className="trim-hud" role="status" data-edit-kind={drag.type}><strong>{drag.type === 'slip' ? 'SLIP SOURCE' : drag.type === 'left' ? 'TRIM IN' : drag.type === 'right' ? 'TRIM OUT' : drag.type === 'signal' ? 'BEAT SIGNAL' : 'MOVE CLIP'}</strong><span>IN <b>{formatTime(activeSource.start, 3)}</b></span><span>OUT <b>{formatTime(activeSource.end, 3)}</b></span><span>DURATION <b>{clipDuration(drag.draft).toFixed(3)}s</b></span>{activeRange.in <= 1e-6 && <em>Source start</em>}{activeRange.total - activeRange.out <= 1e-6 && <em>Source end</em>}<small>{drag.error ?? 'Esc cancels · Shift ignores snapping'}</small></div>}
    <div className="timeline-status"><span><i className="status-dot" />LOCAL WORKSPACE<span className="status-separator">/</span>Edits preserve original source</span><span><kbd>V</kbd> Select <kbd>B</kbd> Marker <kbd>Y</kbd> Slip <kbd>S</kbd> Split <kbd>SPACE</kbd> Play</span></div>
  </section>;
}
