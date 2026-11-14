import { expect, test, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test.skip(process.env.PULSE_EDIT_TEST !== '1', 'Run against an explicitly isolated editing or portable verification workspace.');
const fixture = `${Date.now()}-${process.pid}`;
const folder = resolve('data', 'editing-fixtures', fixture);
let media: Record<string, unknown>[];

function command(program: string, args: string[]): Buffer {
  const result = spawnSync(program, args, { windowsHide: true, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program}: ${result.stderr.toString()}`);
  return result.stdout;
}

function makeFixtures() {
  mkdirSync(folder, { recursive: true });
  for (const [name, first, second] of [['source-a.mp4', 'red', 'blue'], ['source-b.mp4', 'green', 'yellow']]) {
    command('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${first}:s=320x180:r=30:d=6`,
      '-f', 'lavfi', '-i', `color=c=${second}:s=320x180:r=30:d=6`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(folder, name)]);
  }
  const rate = 22050, count = rate * 12;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  [.8, 2.4, 5.2, 7.8, 10.5].forEach((beat, index) => {
    const start = Math.round(beat * rate);
    for (let n = 0; n < rate * .18; n++) {
      const amplitude = (.35 + index * .12) * Math.sin(2 * Math.PI * 65 * n / rate) * Math.exp(-30 * n / rate);
      wav.writeInt16LE(Math.round(amplitude * 32767), 44 + (start + n) * 2);
    }
  });
  writeFileSync(resolve(folder, 'source.wav'), wav);
}

async function saved(page: Page) { await expect(page.locator('.saved-label')).toHaveText('Saved to folder'); }
async function disk(request: APIRequestContext) { return (await (await request.get('/api/projects/active')).json()).project; }
async function seed(page: Page, request: APIRequestContext, warped = false) {
  const tracks = [
    { id: 'edit-video-track', name: 'Video 01', kind: 'video', muted: false, hidden: false, locked: false },
    { id: 'edit-audio-track', name: 'Soundtrack', kind: 'audio', muted: false, hidden: false, locked: false },
  ];
  const video = { id: 'edit-video', name: 'Footage source', trackId: tracks[0].id, start: 1,
    segments: [{ mediaId: media[0].id, in: 0, out: 12, speed: 1 }], signals: [], muted: true, volume: 1 };
  const project = { id: `editing-${fixture}-${warped ? 'warped' : 'plain'}`, version: 1, aspect: '16:9', name: 'Precision editing — synthetic media', media, tracks,
    clips: [warped ? { ...video, name: 'Merged & retimed source', segments: [...video.segments, { mediaId: media[1].id, in: 0, out: 12, speed: 1 }], signals: [4, 12, 20],
      warp: [{ source: 0, target: 0 }, { source: 12, target: 4 }, { source: 24, target: 10 }] } : video,
    { id: 'edit-audio', name: 'Known kick transients', trackId: tracks[1].id, start: 0, segments: [{ mediaId: media[2].id, in: 0, out: 12, speed: 1 }],
      signals: [], muted: false, volume: 1, beatEdits: [.8, 2.4, 5.2, 7.8, 10.5] }] };
  expect((await request.put(`/api/projects/${project.id}`, { data: project })).ok()).toBe(true);
  await page.goto('/'); await saved(page);
  await page.getByLabel('Timeline zoom', { exact: true }).fill('38');
}

async function dragEdge(page: Page, clip: Locator, side: 'left' | 'right', delta: number, release = true) {
  const handle = clip.locator(`.trim-handle.${side}`), rect = await handle.boundingBox();
  expect(rect).not.toBeNull();
  const x = rect!.x + rect!.width / 2, y = rect!.y + rect!.height / 2;
  await page.keyboard.down('Shift'); await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 14 });
  if (release) { await page.mouse.up(); await page.keyboard.up('Shift'); await saved(page); }
}
async function peak(clip: Locator, x: number) {
  return clip.locator('.waveform path').evaluate((path, expectedX) => {
    const values = [...(path.getAttribute('d') ?? '').matchAll(/M(-?[\d.]+),([\d.]+)V([\d.]+)/g)]
      .map(match => ({ x: +match[1], height: +match[3] - +match[2] })).filter(p => Math.abs(p.x - expectedX) < 9);
    return values.sort((a, b) => b.height - a.height)[0];
  }, x);
}

test.beforeAll(async ({ request }) => {
  const health = await (await request.get('/api/health')).json();
  expect(process.env.PULSE_EDIT_WORKSPACE_KEY, 'Provide the expected disposable workspace hash before these tests may write.').toBeTruthy();
  expect(health.workspaceKey).toBe(process.env.PULSE_EDIT_WORKSPACE_KEY);
  makeFixtures(); media = [];
  for (const name of ['source-a.mp4', 'source-b.mp4', 'source.wav']) {
    const response = await request.post('/api/media', { multipart: { files: { name: `editing-${fixture}-${name}`, mimeType: 'application/octet-stream', buffer: readFileSync(resolve(folder, name)) } } });
    expect(response.ok()).toBe(true); media.push((await response.json()).media[0]);
  }
});

test('trim edges restore original audio and keep waveform peaks fixed during the gesture', async ({ page, request }) => {
  await seed(page, request);
  const clip = page.locator('[data-clip-id="edit-audio"]'); await clip.click();
  const before = await peak(clip, 2.4 * 38); expect(before.height).toBeGreaterThan(3);
  await dragEdge(page, clip, 'right', -6 * 38, false);
  await expect(clip).toHaveAttribute('data-clip-duration', /6\.0/);
  const during = await peak(clip, 2.4 * 38);
  expect(Math.abs(during.x - before.x)).toBeLessThan(2.1);
  expect(during.height).toBeGreaterThan(3);
  await expect(page.locator('.source-ghost')).toBeVisible();
  expect((await disk(request)).clips.find((c: { id: string }) => c.id === 'edit-audio').segments[0].out).toBe(12);
  await page.mouse.up(); await page.keyboard.up('Shift'); await saved(page);
  await dragEdge(page, clip, 'right', 6 * 38);
  await expect(clip).toHaveAttribute('data-clip-duration', /12\.0/);
  await dragEdge(page, clip, 'left', 3 * 38);
  await expect(clip).toHaveAttribute('data-source-in', /3\.0/);
  await dragEdge(page, clip, 'left', -3 * 38);
  await expect(clip).toHaveAttribute('data-clip-duration', /12\.0/);
  const snapshot = await disk(request);
  await dragEdge(page, clip, 'right', -2 * 38, false); await page.keyboard.press('Escape');
  await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(clip).toHaveAttribute('data-clip-duration', /12\.0/); expect(await disk(request)).toEqual(snapshot);
  const path = await clip.locator('.waveform path').getAttribute('d');
  const rect = (await clip.boundingBox())!;
  await page.keyboard.down('Shift'); await page.mouse.move(rect.x + 105, rect.y + 48); await page.mouse.down();
  await page.mouse.move(rect.x + 105 + 2 * 38, rect.y + 48, { steps: 12 }); await page.mouse.up(); await page.keyboard.up('Shift'); await saved(page);
  await expect(clip).toHaveAttribute('data-clip-start', /2\.0/);
  expect(await clip.locator('.waveform path').getAttribute('d')).toBe(path);
  await page.keyboard.press('Control+z'); await expect(clip).toHaveAttribute('data-clip-start', /0\.0/);
  await page.keyboard.press('Control+Shift+z'); await expect(clip).toHaveAttribute('data-clip-start', /2\.0/);
});

test('slips source inside a fixed container with accurate preview, numeric selection and frame nudges', async ({ page, request }) => {
  await seed(page, request);
  const clip = page.locator('[data-clip-id="edit-video"]'); await clip.click({ position: { x: 80, y: 45 } });
  await page.getByLabel('Source selection in', { exact: true }).fill('2'); await page.getByLabel('Source selection in', { exact: true }).press('Tab'); await saved(page);
  await page.getByLabel('Source selection out', { exact: true }).fill('5'); await page.getByLabel('Source selection out', { exact: true }).press('Tab'); await saved(page);
  await expect(clip).toHaveAttribute('data-clip-duration', /3\.0/); await expect(clip).toHaveAttribute('data-clip-start', /1\.0/);
  await clip.click({ position: { x: 45, y: 45 } }); await page.keyboard.press('y');
  const rect = (await clip.boundingBox())!;
  await page.keyboard.down('Shift'); await page.mouse.move(rect.x + 45, rect.y + 45); await page.mouse.down();
  // Drag the filmstrip left to reveal later footage inside the fixed window.
  await page.mouse.move(rect.x + 45 - 4 * 38, rect.y + 45, { steps: 16 }); await page.mouse.up(); await page.keyboard.up('Shift'); await saved(page);
  await expect(clip).toHaveAttribute('data-source-in', /6\.0/); await expect(clip).toHaveAttribute('data-source-out', /9\.0/);
  await expect(clip).toHaveAttribute('data-clip-start', /1\.0/); await expect(clip).toHaveAttribute('data-clip-duration', /3\.0/);
  await expect.poll(() => page.locator('video.pulse-preview-media').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator('video.pulse-preview-media').evaluate((v: HTMLVideoElement) => {
    const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d')!; ctx.drawImage(v, 0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[2];
  })).toBeGreaterThan(180);
  await page.getByLabel('Slip one frame later', { exact: true }).click(); await saved(page);
  expect(Number(await clip.getAttribute('data-source-in'))).toBeCloseTo(6 + 1 / 30, 3);
  const before = await disk(request);
  const input = page.getByLabel('Source selection in', { exact: true }); await input.fill('1'); await input.press('Escape');
  expect(await disk(request)).toEqual(before);
  await page.getByRole('button', { name: 'Restore full source', exact: true }).click(); await saved(page);
  await expect(clip).toHaveAttribute('data-clip-duration', /12\.0/);
  await page.reload(); await saved(page); await clip.click({ position: { x: 70, y: 44 } });
  await expect(page.getByLabel('Source selection out', { exact: true })).toHaveValue('12.000');
});

test('restores retained ranges and hidden signals in merged retimed footage after reload', async ({ page, request }) => {
  await seed(page, request, true);
  const clip = page.locator('[data-clip-id="edit-video"]'); await clip.click({ position: { x: 70, y: 45 } });
  await expect(clip).toHaveAttribute('data-clip-duration', /10\.0/); await expect(page.locator('.signal-line')).toHaveCount(3);
  await dragEdge(page, clip, 'right', -6 * 38); await expect(clip).toHaveAttribute('data-clip-duration', /4\.0/);
  await page.reload(); await saved(page); await clip.click({ position: { x: 70, y: 45 } });
  await dragEdge(page, clip, 'right', 6 * 38); await expect(clip).toHaveAttribute('data-clip-duration', /10\.0/);
  await expect(page.locator('.signal-line')).toHaveCount(3);
  const project = await disk(request), restored = project.clips.find((c: { id: string }) => c.id === 'edit-video');
  expect(new Set(restored.segments.map((s: { mediaId: string }) => s.mediaId)).size).toBe(2);
  expect(restored.segments.some((s: { speed: number }) => Math.abs(s.speed - 3) < 1e-5)).toBe(true);
  expect(restored.segments.some((s: { speed: number }) => Math.abs(s.speed - 2) < 1e-5)).toBe(true);
  for (const [width, height] of [[1280, 720], [1366, 768], [1600, 1000]]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.saved-label')).toBeVisible();
    await expect(page.locator('.source-overview')).toBeInViewport();
    const editingBar = await page.locator('.editing-bar').boundingBox(); expect(editingBar!.y + editingBar!.height).toBeLessThanOrEqual(height);
  }
  await page.screenshot({ path: 'data/v130-editing-after.png', fullPage: true });
});

test('reset and reanalysis clear retained manual beats while preserving concurrent trims', async ({ page, request }) => {
  await seed(page, request);
  const clip = page.locator('[data-clip-id="edit-audio"]'); await clip.click();
  await dragEdge(page, clip, 'right', -6 * 38);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Beats', exact: true }).click();
  await page.getByRole('button', { name: 'Restore detected beats', exact: true }).click(); await saved(page);
  await clip.click(); await page.getByRole('button', { name: 'Restore full source', exact: true }).click(); await saved(page);
  let audio = (await disk(request)).clips.find((c: { id: string }) => c.id === 'edit-audio');
  expect(audio.beatEdits).toBeUndefined(); expect(audio.editSource.beatEdits).toBeUndefined();

  await seed(page, request); await clip.click();
  await dragEdge(page, clip, 'right', -3 * 38);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Beats', exact: true }).click();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const intercepted = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/analyze/*', async route => { entered(); await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Detect beats', exact: true }).click(); await intercepted;
  await dragEdge(page, clip, 'right', -3 * 38);
  await expect(clip).toHaveAttribute('data-clip-duration', /6\.0/);
  const analyzed = page.waitForResponse(response => response.url().includes('/api/analyze/'));
  release(); expect((await analyzed).ok()).toBe(true);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Beats', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Detect beats', exact: true })).toBeEnabled(); await saved(page);
  audio = (await disk(request)).clips.find((c: { id: string }) => c.id === 'edit-audio');
  expect(audio.segments[0].out).toBe(6);
  expect(audio.beatEdits).toBeUndefined(); expect(audio.editSource.beatEdits).toBeUndefined();
  await page.keyboard.press('Control+z');
  await expect(clip).toHaveAttribute('data-clip-duration', /6\.0/);
  await page.keyboard.press('Control+z');
  await expect(clip).toHaveAttribute('data-clip-duration', /9\.0/);
});
