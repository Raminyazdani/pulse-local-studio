import { describe, expect, it } from 'vitest';
import { workspaceLimits } from './WorkspaceResize';
import { fitPanelWidths, moveWorkspacePanel, parseWorkspaceLayout, resizePanelBoundary } from './WorkspaceLayoutModel';

describe('preview workspace resize limits', () => {
  it('keeps useful preview and timeline space on a short desktop', () => {
    const bounds = workspaceLimits(720, 61);
    expect(bounds).toEqual({ available: 647, minimum: 240, maximum: 467 });
    expect(bounds.available - bounds.maximum).toBe(180);
    expect(bounds.maximum).toBeGreaterThan(bounds.minimum);
  });
  it('allows a larger preview while keeping both panes usable on tall displays', () => {
    const bounds = workspaceLimits(1000, 66);
    expect(bounds).toEqual({ available: 922, minimum: 300, maximum: 742 });
    expect(bounds.available - bounds.minimum).toBe(622);
  });
});

describe('workspace panel layout bounds', () => {
  it('preserves minimum preview space when two large side panels cannot fit', () => {
    const widths = fitPanelWidths(960, { library: 480, inspector: 520 });
    expect(widths.preview).toBeGreaterThanOrEqual(320);
    expect(widths.library + widths.preview + widths.inspector).toBe(960);
    expect(widths.library).toBeGreaterThanOrEqual(180);
    expect(widths.inspector).toBeGreaterThanOrEqual(230);
  });
  it('resizes adjacent side panels without stealing preview width', () => {
    const widths = { library: 260, inspector: 300, preview: 1040 };
    expect(resizePanelBoundary(widths, ['library','inspector','preview'], 0, 60)).toEqual({ library: 320, inspector: 240 });
    expect(resizePanelBoundary(widths, ['library','inspector','preview'], 0, 10000)).toEqual({ library: 330, inspector: 230 });
  });
  it('reorders without duplicates and rejects malformed saved settings', () => {
    expect(moveWorkspacePanel(['library','preview','inspector'],'preview',0)).toEqual(['preview','library','inspector']);
    expect(parseWorkspaceLayout({order:['preview','preview','library'],widths:{library:NaN},timelineAbove:'true'})).toEqual({
      order:['library','preview','inspector'], widths:{library:null,inspector:null},timelineAbove:false,
    });
  });
});
