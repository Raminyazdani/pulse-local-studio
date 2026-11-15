export const PANEL_IDS = ['library', 'preview', 'inspector'] as const;
export type PanelId = typeof PANEL_IDS[number];
export type PanelWidths = Record<PanelId, number>;
export type WidthPreferences = { library: number | null; inspector: number | null };
export interface WorkspaceLayout {
  order: PanelId[];
  widths: WidthPreferences;
  timelineAbove: boolean;
}

export const PANEL_LABELS: Record<PanelId, string> = {
  library: 'Media library', preview: 'Preview', inspector: 'Inspector',
};
export const PANEL_MINIMUM: PanelWidths = { library: 180, preview: 320, inspector: 230 };
export const WORKSPACE_LAYOUT_KEY = 'pulse.workspace-layout.v1';
export const defaultWorkspaceLayout = (): WorkspaceLayout => ({
  order: [...PANEL_IDS], widths: { library: null, inspector: null }, timelineAbove: false,
});

export function parseWorkspaceLayout(value: unknown): WorkspaceLayout {
  const fallback = defaultWorkspaceLayout();
  if (!value || typeof value !== 'object') return fallback;
  const input = value as Partial<WorkspaceLayout>;
  const order = Array.isArray(input.order) && input.order.length === 3 &&
    PANEL_IDS.every(id => input.order!.includes(id)) ? [...input.order] : fallback.order;
  const width = (key: 'library' | 'inspector') => {
    const number = input.widths?.[key];
    return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
  };
  return { order, widths: { library: width('library'), inspector: width('inspector') }, timelineAbove: input.timelineAbove === true };
}

export function loadWorkspaceLayout(): WorkspaceLayout {
  try { return parseWorkspaceLayout(JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) || 'null')); }
  catch { return defaultWorkspaceLayout(); }
}

export function fitPanelWidths(containerWidth: number, preferences: WidthPreferences): PanelWidths {
  const width = Math.max(730, containerWidth);
  const defaultLibrary = width <= 1060 ? 195 : width <= 1240 ? 210 : width >= 1500 ? 260 : 235;
  const defaultInspector = width <= 1060 ? 250 : width <= 1240 ? 268 : width >= 1500 ? 300 : 286;
  const library = Math.min(480, Math.max(PANEL_MINIMUM.library, preferences.library ?? defaultLibrary));
  const inspector = Math.min(520, Math.max(PANEL_MINIMUM.inspector, preferences.inspector ?? defaultInspector));
  const desiredExtra = library - PANEL_MINIMUM.library + inspector - PANEL_MINIMUM.inspector;
  const allowedExtra = width - PANEL_MINIMUM.preview - PANEL_MINIMUM.library - PANEL_MINIMUM.inspector;
  const scale = desiredExtra > allowedExtra ? allowedExtra / Math.max(1, desiredExtra) : 1;
  const boundedLibrary = Math.round(PANEL_MINIMUM.library + (library - PANEL_MINIMUM.library) * scale);
  const boundedInspector = Math.min(width - PANEL_MINIMUM.preview - boundedLibrary,
    Math.round(PANEL_MINIMUM.inspector + (inspector - PANEL_MINIMUM.inspector) * scale));
  return { library: boundedLibrary, inspector: boundedInspector, preview: Math.max(320, width - boundedLibrary - boundedInspector) };
}

export function resizePanelBoundary(widths: PanelWidths, order: PanelId[], boundary: number, delta: number): WidthPreferences {
  const left = order[boundary], right = order[boundary + 1];
  if (!left || !right || !Number.isFinite(delta)) return { library: widths.library, inspector: widths.inspector };
  const sum = widths[left] + widths[right];
  const maximum: PanelWidths = { library: 480, preview: Number.POSITIVE_INFINITY, inspector: 520 };
  const leftWidth = Math.max(PANEL_MINIMUM[left], sum - maximum[right],
    Math.min(maximum[left], sum - PANEL_MINIMUM[right], widths[left] + delta));
  const next = { ...widths, [left]: leftWidth, [right]: sum - leftWidth };
  return { library: next.library, inspector: next.inspector };
}

export function moveWorkspacePanel(order: PanelId[], panel: PanelId, position: number): PanelId[] {
  const next = order.filter(id => id !== panel);
  next.splice(Math.max(0, Math.min(2, Math.round(position))), 0, panel);
  return next;
}
