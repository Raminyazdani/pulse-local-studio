import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test.skip(process.env.PULSE_LABEL_TEST !== '1', 'Run only in an explicitly isolated video-labeler workspace.');
const fixture = `${Date.now()}-${process.pid}`, folder = resolve('data', 'video-labeler-fixtures', fixture);
let primary: Record<string, unknown>, secondary: Record<string, unknown>;
const saved = async (page: Page) => { await expect(page.locator('.saved-label')).toHaveText('Saved to folder'); };
const active = async (request: APIRequestContext) => (await (await request.get('/api/projects/active')).json()).project;
const labelURL = () => `/api/media/${primary.id}/signals`;
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Video beat labels', exact: true });
const add = (page: Page) => dialog(page).getByRole('button', { name: /^Add signal/ });
async function seek(page: Page, time: number) {
  const field = dialog(page).getByLabel('Source video time', { exact: true });
  await field.fill(String(time)); await field.press('Tab');
  await expect.poll(() => dialog(page).locator('video').evaluate((v: HTMLVideoElement, at) => Math.abs(v.currentTime - at) < .002 && !v.seeking, time)).toBe(true);
  await expect(add(page)).toBeEnabled();
}
async function mark(page: Page, time: number) { await seek(page, time); await add(page).click(); }
async function open(page: Page) {
  await page.getByRole('button', { name: `Label beats in ${primary.name}`, exact: true }).click();
  await expect(dialog(page)).toBeVisible(); await expect(add(page)).toBeEnabled();
}
async function sourceLabels(request: APIRequestContext) { return (await (await request.get(labelURL())).json()).signals; }
async function seed(page: Page, request: APIRequestContext, existing = false) {
  expect((await request.put(labelURL(), { data: { signals: [] } })).ok()).toBe(true);
  primary = (await (await request.get(labelURL())).json()).media;
  const tracks = [
    { id: 'video', name: 'Video', kind: 'video', muted: false, hidden: false, locked: false },
    { id: 'locked', name: 'Locked footage', kind: 'video', muted: false, hidden: false, locked: true },
  ];
  const warped = { id: 'warped', name: 'Retimed occurrence', trackId: 'video', start: 0,
    segments: [{ mediaId: primary.id, in: 0, out: 6, speed: 1, muted: false, volume: 1 }], signals: [.5, 2],
    warp: [{ source: 0, target: 0 }, { source: 3, target: 1.5 }, { source: 6, target: 4.5 }], muted: true, volume: 1 };
  const compound = { id: 'compound', name: 'Two-file sequence', trackId: 'video', start: 6,
    segments: [{ mediaId: primary.id, in: 0, out: 3, speed: 1, muted: false, volume: 1 }, { mediaId: secondary.id, in: 0, out: 3, speed: 1, muted: false, volume: 1 }],
    signals: [.75, 4.5], muted: true, volume: 1 };
  const locked = { id: 'locked-instance', name: 'Locked occurrence', trackId: 'locked', start: 0,
    segments: [{ mediaId: primary.id, in: 0, out: 6, speed: 1, muted: false, volume: 1 }], signals: [.25], muted: true, volume: 1 };
  const project = { id: `video-labeler-${fixture}-${existing ? 'existing' : 'empty'}`, version: 1, name: 'Focused labels — synthetic video', aspect: '16:9',
    media: [primary, secondary], tracks, clips: existing ? [warped, compound, locked] : [] };
  expect((await request.put(`/api/projects/${project.id}`, { data: project })).ok()).toBe(true);
  await page.goto('/'); await saved(page); return project;
}

test.beforeAll(async ({ request }) => {
  expect(process.env.PULSE_EDIT_WORKSPACE_KEY).toBeTruthy();
  expect((await (await request.get('/api/health')).json()).workspaceKey).toBe(process.env.PULSE_EDIT_WORKSPACE_KEY);
  mkdirSync(folder, { recursive: true });
  const paths = [resolve(folder, 'source.mov'), resolve(folder, 'other.mp4')];
  const args = [
    ['-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=3',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]'],
    ['-f', 'lavfi', '-i', 'color=c=green:s=640x360:r=30:d=6'],
  ];
  const media: Record<string, unknown>[] = [];
  for (let i = 0; i < paths.length; i++) {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args[i], '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', paths[i]], { windowsHide: true, timeout: 90_000 });
    if (result.status !== 0) throw new Error(result.stderr?.toString() || String(result.error));
    const response = await request.post('/api/media', { multipart: { files: { name: `video-labeler-${fixture}-${i ? 'other.mp4' : 'source.mov'}`, mimeType: 'application/octet-stream', buffer: readFileSync(paths[i]) } } });
    expect(response.ok()).toBe(true); media.push((await response.json()).media[0]);
  }
  [primary, secondary] = media;
});

test('labels a library video in a large zoomable frame viewer without adding a timeline clip, then reuses saved labels', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await seed(page, request);
  const original = await (await request.get(`/api/files/${primary.id}/original`)).body();
  await open(page); await expect(page.locator('.timeline-clip')).toHaveCount(0);
  expect((await dialog(page).boundingBox())!.width).toBeGreaterThan(1400);
  await dialog(page).focus(); await page.keyboard.press('ArrowRight');
  await expect(dialog(page).getByLabel('Source video frame', { exact: true })).toHaveValue('1');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(dialog(page).getByLabel('Source video frame', { exact: true })).toHaveValue('11');
  expect(await page.locator('.transport-time').innerText()).toContain('00:00');
  await mark(page, 1); await mark(page, 2); await seek(page, 4);
  const pixel = await dialog(page).locator('video').evaluate((v: HTMLVideoElement) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const c = canvas.getContext('2d')!; c.drawImage(v, 0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data];
  });
  expect(pixel[2]).toBeGreaterThan(pixel[0] + 100); await add(page).click();
  await expect(dialog(page).locator('.signal-editor-row')).toHaveCount(3);
  await dialog(page).getByRole('button', { name: 'Previous frame', exact: true }).click();
  await expect(dialog(page).getByLabel('Source video frame', { exact: true })).toHaveValue('119');
  await dialog(page).getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(dialog(page).getByLabel('Source video frame', { exact: true })).toHaveValue('120');
  await dialog(page).getByLabel('Video labeler quality', { exact: true }).selectOption('original');
  await expect(add(page)).toBeEnabled(); await seek(page, 4);
  expect(await dialog(page).locator('video').getAttribute('src')).toContain('/original');
  await dialog(page).getByLabel('Video zoom', { exact: true }).fill('300');
  const stage = dialog(page).locator('.signal-editor-stage'); await expect(stage).toHaveAttribute('data-zoom', '3.000');
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 35, { steps: 8 }); await page.mouse.up();
  expect(Math.abs(Number(await stage.getAttribute('data-pan-x')))).toBeGreaterThan(50);
  await dialog(page).getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(stage).toHaveAttribute('data-zoom', '1.000'); await expect(stage).toHaveAttribute('data-pan-x', '0.00');
  await dialog(page).getByLabel('Signal timeline zoom', { exact: true }).fill('200');
  const marker = dialog(page).getByRole('button', { name: 'Timeline signal 3', exact: true });
  const markerBox = (await marker.boundingBox())!, ruler = (await dialog(page).locator('.signal-editor-track').boundingBox())!;
  await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + 20); await page.mouse.down();
  await page.mouse.move(markerBox.x + markerBox.width / 2 + ruler.width / 12, markerBox.y + 20, { steps: 10 }); await page.mouse.up();
  expect(Number(await dialog(page).locator('.signal-editor-row').last().getAttribute('data-signal-time'))).toBeCloseTo(4.5, 5);
  await dialog(page).getByRole('button', { name: 'Undo video signal edit', exact: true }).click();
  await expect(dialog(page).locator('.signal-editor-row').last()).toHaveAttribute('data-signal-time', '4.000000000');
  await dialog(page).getByRole('button', { name: 'Undo video signal edit', exact: true }).click();
  await expect(dialog(page).locator('.signal-editor-row')).toHaveCount(2);
  await dialog(page).getByRole('button', { name: 'Redo video signal edit', exact: true }).click();
  await expect(dialog(page).locator('.signal-editor-row')).toHaveCount(3);
  await expect(dialog(page).getByLabel('Apply labels to existing timeline clips', { exact: true })).not.toBeChecked();
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click();
  await expect(dialog(page)).toBeHidden(); await saved(page);
  expect(await sourceLabels(request)).toEqual([1, 2, 4]); await expect(page.locator('.timeline-clip')).toHaveCount(0);
  expect(await (await request.get(`/api/files/${primary.id}/original`)).body()).toEqual(original);
  await page.reload(); await saved(page); await open(page);
  await expect(dialog(page).locator('.signal-editor-row')).toHaveCount(3);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTitle(`Add ${primary.name} to timeline`, { exact: true }).click();
  await expect(page.locator('.timeline-clip.video')).toHaveCount(1);
  await expect.poll(async () => (await active(request)).clips.length).toBe(1); await saved(page);
  expect((await active(request)).clips[0].signals).toEqual([1, 2, 4]);
  await expect(page.locator('.signal-line')).toHaveCount(3); expect(errors).toEqual([]);
});

test('keeps existing edits by default, applies explicitly to unlocked repeated/retimed sources and preserves library labels on Undo', async ({ page, request }) => {
  await seed(page, request, true); const before = (await active(request)).clips;
  await open(page); await mark(page, 1); await mark(page, 2); await mark(page, 4);
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  expect((await active(request)).clips).toEqual(before);
  await open(page); await dialog(page).getByLabel('Apply labels to existing timeline clips', { exact: true }).check();
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  const clips = (await active(request)).clips;
  expect(clips.find((c: { id: string }) => c.id === 'warped').signals).toEqual([.5, 1, 2.5]);
  expect(clips.find((c: { id: string }) => c.id === 'warped').warp).toBeUndefined();
  expect(clips.find((c: { id: string }) => c.id === 'warped').segments.map((s: { speed: number }) => s.speed)).toEqual([2, 1]);
  expect(clips.find((c: { id: string }) => c.id === 'compound').signals).toEqual([1, 2, 4.5]);
  expect(clips.find((c: { id: string }) => c.id === 'locked-instance')).toEqual(before.find((c: { id: string }) => c.id === 'locked-instance'));
  await page.keyboard.press('Control+z'); await saved(page);
  expect((await active(request)).clips).toEqual(before);
  expect((await active(request)).media.find((m: { id: string }) => m.id === primary.id).sourceSignals).toEqual([1, 2, 4]);
  await page.getByTitle(`Add ${primary.name} to timeline`, { exact: true }).click(); await saved(page);
  expect((await active(request)).clips.at(-1).signals).toEqual([1, 2, 4]);
});

test('discards cancelled drafts and retains a conflicting draft without overwriting another session', async ({ page, request }) => {
  await seed(page, request); await open(page); await mark(page, 1);
  await page.keyboard.press('Escape'); await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.signal-editor-notice')).toContainText('unsaved labels');
  await dialog(page).getByRole('button', { name: 'Play labeling video', exact: true }).click();
  await expect.poll(() => dialog(page).locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.evaluate(() => { (window as Window & { oldLabelVideo?: HTMLVideoElement }).oldLabelVideo = document.querySelector('.signal-editor-video') as HTMLVideoElement; });
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { oldLabelVideo?: HTMLVideoElement }).oldLabelVideo?.paused)).toBe(true);
  expect(await sourceLabels(request)).toEqual([]);
  await open(page); await mark(page, 2);
  expect((await request.put(labelURL(), { data: { signals: [.5], expectedSignals: [] } })).ok()).toBe(true);
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click();
  await expect(dialog(page)).toBeVisible(); await expect(dialog(page)).toContainText('changed in another session');
  await expect(dialog(page).locator('.signal-editor-row')).toHaveAttribute('data-signal-time', '2.000000000');
  expect(await sourceLabels(request)).toEqual([.5]);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await open(page);
  await expect(dialog(page).locator('.signal-editor-row')).toHaveAttribute('data-signal-time', '0.500000000');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await saved(page);
});

test('retries a project-save failure without losing durable source labels and keeps controls visible on smaller screens', async ({ page, request }) => {
  await seed(page, request); await open(page); await mark(page, 1);
  let failed = false;
  await page.route('**/api/projects/*', async route => {
    const snapshot = route.request().method() === 'PUT' ? route.request().postDataJSON() : undefined;
    const labels = snapshot?.media?.find((m: { id: string }) => m.id === primary.id)?.sourceSignals;
    if (!failed && labels?.length === 1 && labels[0] === 1) { failed = true; await route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ detail: 'Synthetic project save failure' }) }); }
    else await route.continue();
  });
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click();
  await expect(dialog(page)).toContainText('Library labels were saved'); expect(await sourceLabels(request)).toEqual([1]);
  await mark(page, 2);
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  expect((await active(request)).media.find((m: { id: string }) => m.id === primary.id).sourceSignals).toEqual([1, 2]);
  await open(page);
  for (const [width, height] of [[1024, 768], [1280, 720], [1600, 1000]]) {
    await page.setViewportSize({ width, height }); const rect = (await dialog(page).boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width); expect(rect.y + rect.height).toBeLessThanOrEqual(height);
    await expect(add(page)).toBeInViewport(); await expect(dialog(page).getByRole('button', { name: 'Save labels', exact: true })).toBeInViewport();
    expect((await dialog(page).locator('.signal-editor-stage').boundingBox())!.height).toBeGreaterThan(120);
  }
  await page.screenshot({ path: 'data/v150-video-labeler.png', fullPage: true });
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await saved(page);
});
