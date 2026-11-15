import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { GripHorizontal, Minus, Plus, RotateCcw } from 'lucide-react';
import { defaultWorkspaceLayout, fitPanelWidths, loadWorkspaceLayout, moveWorkspacePanel, WORKSPACE_LAYOUT_KEY } from './WorkspaceLayoutModel';
import type { PanelId, WidthPreferences, WorkspaceLayout } from './WorkspaceLayoutModel';
import { WorkspaceArrangeMenu } from './WorkspaceLayout';
export { PanelDragHandle, WorkspacePanelHandles } from './WorkspaceLayout';
import './WorkspaceResize.css';

const STORAGE_KEY = 'pulse.preview-layout.v1';
const HANDLE_HEIGHT = 12;
const MIN_TIMELINE = 180;

export function workspaceLimits(height: number, headerHeight: number) {
  const available = Math.max(420, height - headerHeight - HANDLE_HEIGHT);
  const minimum = Math.min(height <= 820 ? 240 : 300, available - MIN_TIMELINE);
  return { available, minimum, maximum: available - MIN_TIMELINE };
}

function defaultRatio(height: number, width: number, available: number) {
  const timeline = height <= 820 ? 285 : width >= 1550 && height >= 900 ? 350 : 330;
  return (available - timeline) / available;
}

function loadRatio(): number | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const value = stored === null ? NaN : Number(stored);
    return Number.isFinite(value) && value > 0 && value < 1 ? value : null;
  } catch { return null; }
}

export function useWorkspaceResize() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number | null>(loadRatio);
  const [geometry, setGeometry] = useState(() => workspaceLimits(
    window.innerHeight, window.innerHeight <= 820 ? 61 : 66,
  ));
  const [dragging, setDragging] = useState(false);
  const [dragAxis, setDragAxis] = useState<'row' | 'column'>('row');
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);
  const [layout, setLayout] = useState<WorkspaceLayout>(loadWorkspaceLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [draggedPanel, setDraggedPanel] = useState<PanelId | null>(null);
  const panelWidths = fitPanelWidths(containerWidth, layout.widths);
  const preferred = ratio ?? defaultRatio(window.innerHeight, window.innerWidth, geometry.available);
  const workspaceHeight = Math.round(Math.max(geometry.minimum, Math.min(geometry.maximum, preferred * geometry.available)));
  const actualRatio = workspaceHeight / geometry.available;

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const update = () => {
      const header = root.querySelector('.app-header')?.getBoundingClientRect().height ?? 66;
      setGeometry(workspaceLimits(root.clientHeight, header));
      setContainerWidth(root.clientWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    const header = root.querySelector('.app-header');
    if (header) observer.observe(header);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, []);

  const setHeight = useCallback((height: number, persist = true) => {
    const bounded = Math.max(geometry.minimum, Math.min(geometry.maximum, height)) / geometry.available;
    setRatio(bounded);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, String(bounded)); } catch { /* A private browser may disallow settings storage. */ }
    }
  }, [geometry]);
  const restoreRatio = useCallback((value: number | null) => {
    setRatio(value);
    try {
      if (value === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(value));
    } catch { /* The current layout still works without persistence. */ }
  }, []);
  const reset = useCallback(() => restoreRatio(null), [restoreRatio]);
  const restoreLayout = useCallback((next: WorkspaceLayout, persist = true) => {
    layoutRef.current = next;
    setLayout(next);
    if (persist) {
      try { localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(next)); } catch { /* Browser settings are optional. */ }
    }
  }, []);
  const setPanelWidths = useCallback((widths: WidthPreferences, persist = true) => {
    restoreLayout({ ...layoutRef.current, widths }, persist);
  }, [restoreLayout]);
  const movePanel = useCallback((panel: PanelId, position: number) => {
    restoreLayout({ ...layoutRef.current, order: moveWorkspacePanel(layoutRef.current.order, panel, position) });
    setDraggedPanel(null);
  }, [restoreLayout]);
  const setTimelineAbove = useCallback((timelineAbove: boolean) => {
    restoreLayout({ ...layoutRef.current, timelineAbove });
  }, [restoreLayout]);
  const resetLayout = useCallback(() => {
    restoreLayout(defaultWorkspaceLayout());
    restoreRatio(null);
    setDraggedPanel(null);
  }, [restoreLayout, restoreRatio]);
  function setPreviewWidth(width: number) {
    const remaining = Math.max(0, containerWidth - width - 410);
    const extra = panelWidths.library - 180 + panelWidths.inspector - 230;
    const libraryShare = extra ? (panelWidths.library - 180) / extra : .5;
    setPanelWidths({ library: 180 + remaining * libraryShare, inspector: 230 + remaining * (1 - libraryShare) });
  }

  useEffect(() => {
    if (!dragging) return;
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = dragAxis === 'row' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    return () => { document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelection; };
  }, [dragging, dragAxis]);

  return {
    containerRef, geometry, workspaceHeight, ratio, actualRatio, dragging, setDragging, setDragAxis, setHeight, restoreRatio, reset,
    layout, restoreLayout, containerWidth, panelWidths, setPanelWidths, movePanel, setTimelineAbove, resetLayout, setPreviewWidth,
    draggedPanel, setDraggedPanel,
    style: {
      '--workspace-timeline-height': `${geometry.available - workspaceHeight}px`,
      '--workspace-columns': layout.order.map(id => `${panelWidths[id]}px`).join(' '),
      '--library-column': layout.order.indexOf('library') + 1,
      '--preview-column': layout.order.indexOf('preview') + 1,
      '--inspector-column': layout.order.indexOf('inspector') + 1,
      '--workspace-order': layout.timelineAbove ? 3 : 1,
      '--timeline-order': layout.timelineAbove ? 1 : 3,
    } as CSSProperties,
  };
}

export type WorkspaceResizeState = ReturnType<typeof useWorkspaceResize>;
type Resize = WorkspaceResizeState;
interface Props { resize: Resize }

export function WorkspaceResizeHandle({ resize }: Props) {
  const gesture = useRef<{ y: number; height: number; ratio: number | null; pointer: number } | null>(null);
  const latest = useRef(resize);
  latest.current = resize;

  const finish = useCallback((cancel = false) => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    if (cancel) latest.current.restoreRatio(active.ratio);
    else latest.current.setHeight(latest.current.workspaceHeight);
    latest.current.setDragging(false);
  }, []);

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current) return;
      event.preventDefault(); event.stopImmediatePropagation(); finish(true);
    };
    const release = (event: globalThis.PointerEvent) => {
      if (gesture.current?.pointer === event.pointerId) finish(event.type === 'pointercancel');
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      if (gesture.current) latest.current.setDragging(false);
    };
  }, [finish]);

  function begin(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { y: event.clientY, height: resize.workspaceHeight, ratio: resize.ratio, pointer: event.pointerId };
    resize.setDragAxis('row');
    resize.setDragging(true);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.preventDefault();
    resize.setHeight(active.height + (event.clientY - active.y) * (resize.layout.timelineAbove ? -1 : 1), false);
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Home') resize.setHeight(resize.geometry.minimum);
    else if (event.key === 'End') resize.setHeight(resize.geometry.maximum);
    else if (event.key === 'Enter') resize.reset();
    else resize.setHeight(resize.workspaceHeight + (event.key === 'ArrowDown' ? 1 : -1) *
      (resize.layout.timelineAbove ? -1 : 1) * (event.shiftKey ? 50 : 16));
  }

  return <div className={`workspace-resize-handle ${resize.dragging ? 'dragging' : ''}`}
    role="separator" tabIndex={0} aria-label="Resize preview and timeline" aria-orientation="horizontal"
    aria-valuemin={resize.geometry.minimum} aria-valuemax={resize.geometry.maximum} aria-valuenow={resize.workspaceHeight}
    aria-valuetext={`Preview workspace ${resize.workspaceHeight} pixels; drag ${resize.layout.timelineAbove ? 'up' : 'down'} for a larger preview`}
    title="Drag to resize preview · ↑/↓ adjust · Enter or double-click resets · Esc cancels"
    onPointerDown={begin} onPointerMove={move} onPointerUp={() => finish()} onPointerCancel={() => finish(true)}
    onKeyDown={key} onDoubleClick={resize.reset}>
    <GripHorizontal size={16} aria-hidden="true" />
    <span>PREVIEW SIZE</span>
  </div>;
}

export function PreviewSizeControl({ resize }: Props) {
  const percent = Math.round((resize.workspaceHeight - resize.geometry.minimum) /
    Math.max(1, resize.geometry.maximum - resize.geometry.minimum) * 100);
  return <div className="preview-size-control" aria-label="Preview size controls">
    <button type="button" aria-label="Make preview smaller" title="Smaller preview" disabled={percent === 0}
      onClick={() => resize.setHeight(resize.workspaceHeight - 40)}><Minus size={13} /></button>
    <input type="range" aria-label="Preview size" min={0} max={100} step={1} value={percent}
      aria-valuetext={`${percent}% of adjustable preview space`}
      onChange={event => resize.setHeight(resize.geometry.minimum + Number(event.target.value) / 100 *
        (resize.geometry.maximum - resize.geometry.minimum))} />
    <button type="button" aria-label="Make preview larger" title="Larger preview" disabled={percent === 100}
      onClick={() => resize.setHeight(resize.workspaceHeight + 40)}><Plus size={13} /></button>
    <button type="button" aria-label="Reset preview size" title="Reset preview size" className="preview-size-reset"
      onClick={resize.reset}><RotateCcw size={12} /></button>
    <WorkspaceArrangeMenu resize={resize} />
  </div>;
}
