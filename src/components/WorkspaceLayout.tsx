import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, PanelsTopLeft, RotateCcw, X } from 'lucide-react';
import type { WorkspaceResizeState } from './WorkspaceResize';
import { PANEL_IDS, PANEL_LABELS, PANEL_MINIMUM, resizePanelBoundary } from './WorkspaceLayoutModel';
import type { PanelId, PanelWidths, WorkspaceLayout } from './WorkspaceLayoutModel';

interface Props { resize: WorkspaceResizeState }
const DRAG_TYPE = 'application/x-pulse-workspace-panel';

export function PanelDragHandle({ resize, panel }: Props & { panel: PanelId }) {
  function key(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const current = resize.layout.order.indexOf(panel);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : current + (event.key === 'ArrowLeft' ? -1 : 1);
    resize.movePanel(panel, target);
    event.currentTarget.focus();
  }
  return <button type="button" className="panel-drag-handle" draggable
    aria-label={`Move ${PANEL_LABELS[panel]} panel`}
    title={`Drag to move ${PANEL_LABELS[panel]} · ←/→ move between columns`}
    onKeyDown={key}
    onDragStart={event => {
      event.stopPropagation(); event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_TYPE, panel); resize.setDraggedPanel(panel);
    }}
    onDragEnd={() => resize.setDraggedPanel(null)}><GripVertical size={14} /></button>;
}

export function WorkspacePanelHandles({ resize }: Props) {
  const gesture = useRef<{ x: number; widths: PanelWidths; layout: WorkspaceLayout; boundary: number; pointer: number } | null>(null);
  const latest = useRef(resize); latest.current = resize;
  const finish = useCallback((cancel = false) => {
    const old = gesture.current;
    if (!old) return;
    gesture.current = null;
    if (cancel) latest.current.restoreLayout(old.layout);
    else latest.current.restoreLayout(latest.current.layout);
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
  function begin(event: PointerEvent<HTMLDivElement>, boundary: number) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { x: event.clientX, widths: { ...resize.panelWidths }, layout: resize.layout, boundary, pointer: event.pointerId };
    resize.setDragAxis('column'); resize.setDragging(true);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const old = gesture.current;
    if (!old || old.pointer !== event.pointerId) return;
    event.preventDefault();
    resize.setPanelWidths(resizePanelBoundary(old.widths, old.layout.order, old.boundary, event.clientX - old.x), false);
  }
  function key(event: KeyboardEvent<HTMLDivElement>, boundary: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Enter') { resize.setPanelWidths({ library: null, inspector: null }); return; }
    const delta = event.key === 'Home' ? -10000 : event.key === 'End' ? 10000 :
      (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 50 : 16);
    resize.setPanelWidths(resizePanelBoundary(resize.panelWidths, resize.layout.order, boundary, delta));
  }
  function drop(event: DragEvent, position: number) {
    event.preventDefault(); event.stopPropagation();
    const value = event.dataTransfer.getData(DRAG_TYPE) as PanelId;
    if (PANEL_IDS.includes(value)) resize.movePanel(value, position);
  }
  let left = 0;
  const draggedPanel = resize.draggedPanel;
  return <div className={`workspace-panel-handles ${resize.draggedPanel ? 'reordering' : ''}`}>
    {resize.layout.order.slice(0, 2).map((panel, index) => {
      left += resize.panelWidths[panel];
      const right = resize.layout.order[index + 1];
      return <div key={index} className="workspace-column-resizer" style={{ left: left - 4 }}
        role="separator" tabIndex={0} aria-orientation="vertical"
        aria-label={`Resize ${PANEL_LABELS[panel]} and ${PANEL_LABELS[right]}`}
        aria-valuemin={PANEL_MINIMUM[panel]} aria-valuemax={resize.panelWidths[panel] + resize.panelWidths[right] - PANEL_MINIMUM[right]}
        aria-valuenow={resize.panelWidths[panel]}
        title="Drag to resize panels · ←/→ adjust · Enter resets widths · Esc cancels"
        onPointerDown={event => begin(event, index)} onPointerMove={move}
        onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onKeyDown={event => key(event, index)} />;
    })}
    {draggedPanel && resize.layout.order.map((panel, index) => <div key={panel} className="workspace-panel-dropzone"
      style={{ left: resize.layout.order.slice(0, index).reduce((sum, id) => sum + resize.panelWidths[id], 0), width: resize.panelWidths[panel] }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => drop(event, index)}>
      <span>Move {PANEL_LABELS[draggedPanel]} here</span>
    </div>)}
  </div>;
}

export function WorkspaceArrangeMenu({ resize }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); anchor.current?.focus();
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  function toggle() {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) {
      const below = rect.bottom + 8;
      const desiredHeight = Math.min(640, window.innerHeight - 24);
      const top = window.innerHeight - below - 12 >= Math.min(360, desiredHeight)
        ? below : Math.max(12, rect.top - desiredHeight - 8);
      setPosition({ left: Math.max(8, Math.min(window.innerWidth - 308, rect.right - 300)), top });
    }
    setOpen(value => !value);
  }
  const timelineHeight = resize.geometry.available - resize.workspaceHeight;
  return <>
    <button ref={anchor} type="button" aria-label="Arrange workspace" title="Arrange workspace panels"
      aria-expanded={open} aria-controls="workspace-layout-popover" onClick={toggle} className="workspace-arrange-button">
      <PanelsTopLeft size={14} />
    </button>
    {open && createPortal(<div ref={popover} id="workspace-layout-popover" className="workspace-layout-popover"
      role="dialog" aria-label="Arrange workspace" style={{ ...position, maxHeight: Math.max(220, window.innerHeight - position.top - 12) }}
      onKeyDown={event => event.stopPropagation()}>
      <div className="workspace-layout-heading"><strong>Arrange workspace</strong><button type="button" aria-label="Close workspace arrangement"
        onClick={() => setOpen(false)}><X size={15} /></button></div>
      <p>Drag header grips to move panels and dividers to resize them.</p>
      <div className="workspace-layout-section">PANEL POSITIONS</div>
      {PANEL_IDS.map(panel => <label className="workspace-layout-field" key={panel}><span>{PANEL_LABELS[panel]}</span>
        <select aria-label={`${PANEL_LABELS[panel]} position`} value={resize.layout.order.indexOf(panel)}
          onChange={event => resize.movePanel(panel, Number(event.target.value))}>
          <option value={0}>Left</option><option value={1}>Center</option><option value={2}>Right</option>
        </select></label>)}
      <label className="workspace-layout-field"><span>Timeline</span><select aria-label="Timeline position" value={resize.layout.timelineAbove ? 'above' : 'below'}
        onChange={event => resize.setTimelineAbove(event.target.value === 'above')}>
        <option value="below">Below panels</option><option value="above">Above panels</option>
      </select></label>
      <div className="workspace-layout-section">PANEL SIZES</div>
      {(['library', 'preview', 'inspector'] as const).map(panel => {
        const maximum = panel === 'preview' ? resize.containerWidth - 410 : panel === 'library' ? Math.min(480, resize.containerWidth - 550) : Math.min(520, resize.containerWidth - 500);
        return <label className="workspace-layout-slider" key={panel}><span>{PANEL_LABELS[panel]} width <b>{resize.panelWidths[panel]}px</b></span>
          <input type="range" aria-label={`${PANEL_LABELS[panel]} width`} min={PANEL_MINIMUM[panel]} max={maximum} step={1} value={resize.panelWidths[panel]}
            onChange={event => panel === 'preview' ? resize.setPreviewWidth(Number(event.target.value)) :
              resize.setPanelWidths({ library: resize.panelWidths.library, inspector: resize.panelWidths.inspector, [panel]: Number(event.target.value) })} />
        </label>;
      })}
      <label className="workspace-layout-slider"><span>Preview row height <b>{resize.workspaceHeight}px</b></span>
        <input type="range" aria-label="Preview row height" min={resize.geometry.minimum} max={resize.geometry.maximum} step={1} value={resize.workspaceHeight}
          onChange={event => resize.setHeight(Number(event.target.value))} /></label>
      <label className="workspace-layout-slider"><span>Timeline height <b>{timelineHeight}px</b></span>
        <input type="range" aria-label="Timeline height" min={180} max={resize.geometry.available - resize.geometry.minimum} step={1} value={timelineHeight}
          onChange={event => resize.setHeight(resize.geometry.available - Number(event.target.value))} /></label>
      <p className="workspace-layout-note">Side panels share the preview row height. Layout is saved on this device.</p>
      <button type="button" className="workspace-layout-reset" onClick={resize.resetLayout}><RotateCcw size={13} />Reset workspace layout</button>
    </div>, document.body)}
  </>;
}
