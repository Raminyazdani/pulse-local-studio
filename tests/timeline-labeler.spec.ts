import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test.skip(process.env.PULSE_TIMELINE_LABEL_TEST !== '1', 'Run only in an explicitly isolated timeline-labeler workspace.');
const fixture = `${Date.now()}-${process.pid}`;
const folder = resolve('data', 'timeline-labeler-fixtures', fixture);
let red: Record<string, unknown>, blue: Record<string, unknown>, audio: Record<string, unknown>;
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Video beat labels', exact: true });
const add = (page: Page) => dialog(page).getByRole('button', { name: /^Add signal/ });
const active = async (request: APIRequestContext) => (await (await request.get('/api/projects/active')).json()).project;
const saved = async (page: Page) => { await expect(page.locator('.saved-label')).toHaveText('Saved to folder'); };
const currentClip = async (request: APIRequestContext) => (await active(request)).clips.find((clip: { id: string }) => clip.id === 'timeline-compound');
async function libraryLabels(request: APIRequestContext) {
  return Promise.all([red, blue].map(async asset => (await (await request.get(`/api/media/${asset.id}/signals`)).json()).signals));
}
async function choose(page: Page, id = 'timeline-compound') {
  await page.locator(`[data-clip-id="${id}"]`).click({ position: { x: 36, y: 43 } });
  await page.getByRole('button', { name: 'Clip', exact: true }).click();
}
async function open(page: Page, toolbar = false) {
  await choose(page);
  await page.getByRole('button', { name: toolbar ? 'Label selected video beats' : 'Label timeline clip beats', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(add(page)).toBeEnabled();
}
async function seek(page: Page, time: number, mediaId?: unknown, originalTime?: number) {
  const field = dialog(page).getByLabel('Source video time', { exact: true });
  await field.fill(String(time)); await field.press('Tab');
  await expect(add(page)).toBeEnabled();
  await expect.poll(async () => Math.abs(Number(await field.inputValue()) - time)).toBeLessThan(.035);
  if (mediaId !== undefined) {
    const video = dialog(page).locator('video.signal-editor-video');
    await expect(video).toHaveAttribute('src', new RegExp(`/api/files/${mediaId}/`));
    await expect.poll(() => video.evaluate((node: HTMLVideoElement, at) =>
      !node.seeking && node.readyState >= 2 && Math.abs(node.currentTime - at) < .04, originalTime!)).toBe(true);
  }
}
async function mark(page: Page, time: number) { await seek(page, time); await add(page).click(); }
async function color(page: Page, channel: 0 | 2) {
  await expect.poll(() => dialog(page).locator('video.signal-editor-video').evaluate((node: HTMLVideoElement, wanted) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!; context.drawImage(node, 0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return pixel[wanted] - pixel[wanted === 0 ? 2 : 0];
  }, channel)).toBeGreaterThan(100);
}
async function observePresentedFrames(page: Page) {
  // Observe the actual compositor timestamps without replacing the decoder.
  await page.addInitScript(() => {
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return original.call(this, (now, metadata) => {
        this.dataset.testPresentedTime = String(metadata.mediaTime);
        callback(now, metadata);
      });
    };
  });
}
async function seed(page: Page, request: APIRequestContext, warped = false) {
  for (const [asset, signals] of [[red, [.25, 1.25]], [blue, [.5, 4.5]]] as const) {
    const response = await request.put(`/api/media/${asset.id}/signals`, { data: { signals } });
    expect(response.ok()).toBe(true);
  }
  [red, blue] = await Promise.all([red, blue].map(async asset => (await (await request.get(`/api/media/${asset.id}/signals`)).json()).media));
  const tracks = [
    { id: 'timeline-video-track', name: 'Video composition', kind: 'video', muted: false, hidden: false, locked: false },
    { id: 'timeline-locked-track', name: 'Locked footage', kind: 'video', muted: false, hidden: false, locked: true },
    { id: 'timeline-audio-track', name: 'Soundtrack', kind: 'audio', muted: false, hidden: false, locked: false },
  ];
  const compound = {
    id: 'timeline-compound', name: 'Merged red and blue', trackId: tracks[0].id, start: 7,
    segments: [
      { mediaId: red.id, in: 1, out: 3, speed: 2, muted: false, volume: .8 },
      { mediaId: blue.id, in: 2, out: 5, speed: 1, muted: true, volume: .6 },
    ],
    signals: warped ? [.5, 3, 4] : [], muted: false, volume: .7,
    ...(warped ? { warp: [{ source: 0, target: 0 }, { source: 1, target: .5 }, { source: 4, target: 3.5 }] } : {}),
  };
  const locked = { ...compound, id: 'timeline-locked', name: 'Locked merged copy', trackId: tracks[1].id, start: 0, signals: [.25] };
  const soundtrack = { id: 'timeline-soundtrack', name: 'Synthetic audio', trackId: tracks[2].id, start: 0,
    segments: [{ mediaId: audio.id, in: 0, out: 12, speed: 1, muted: false, volume: 1 }], signals: [], muted: false, volume: 1 };
  const project = { id: `timeline-labeler-${fixture}-${warped ? 'warped' : 'plain'}`, version: 1, name: 'Timeline signal labels — synthetic media', aspect: '16:9',
    media: [red, blue, audio], tracks, clips: [compound, locked, soundtrack] };
  expect((await request.put(`/api/projects/${project.id}`, { data: project })).ok()).toBe(true);
  const libraryIds = (await (await request.get('/api/media')).json()).media.map((asset: { id: string }) => asset.id).sort();
  await page.goto('/'); await saved(page);
  // A reused disposable workspace contains earlier synthetic imports. Wait
  // until the normal library reconciliation reaches the project folder before
  // taking a baseline, so that later additions are not mistaken for an edit.
  await expect.poll(async () => (await active(request)).media.map((asset: { id: string }) => asset.id).sort()).toEqual(libraryIds);
  await saved(page);
  await page.getByLabel('Timeline zoom', { exact: true }).fill('70');
  return active(request);
}

test.beforeAll(async ({ request }) => {
  expect(process.env.PULSE_EDIT_WORKSPACE_KEY, 'Provide the expected disposable workspace hash before these tests may write.').toBeTruthy();
  expect((await (await request.get('/api/health')).json()).workspaceKey).toBe(process.env.PULSE_EDIT_WORKSPACE_KEY);
  mkdirSync(folder, { recursive: true });
  const files = ['red.mov', 'blue.mov', 'soundtrack.wav'];
  const imports: Record<string, unknown>[] = [];
  for (const name of files) {
    const path = resolve(folder, name);
    const arguments_ = name.endsWith('.wav')
      ? ['-f', 'lavfi', '-i', 'sine=frequency=80:sample_rate=22050:duration=12', '-c:a', 'pcm_s16le']
      : ['-f', 'lavfi', '-i', `color=c=${name.startsWith('red') ? 'red' : 'blue'}:s=640x360:r=${name.startsWith('red') ? 30 : 24}:d=6,drawgrid=width=80:height=60:thickness=2:color=white@0.18`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...arguments_, path], { windowsHide: true, timeout: 90_000 });
    if (result.status !== 0) throw new Error(result.stderr?.toString() || String(result.error));
    const response = await request.post('/api/media', { multipart: { files: { name: `timeline-labeler-${fixture}-${name}`, mimeType: 'application/octet-stream', buffer: readFileSync(path) } } });
    expect(response.ok()).toBe(true); imports.push((await response.json()).media[0]);
  }
  [red, blue, audio] = imports;
});

test('inspects merged trimmed/sped sources across the cut, saves only that timeline clip and reopens its exact labels', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const projectBefore = await seed(page, request);
  const before = await currentClip(request), labelsBefore = await libraryLabels(request);
  const sourceBefore = await (await request.get(`/api/files/${red.id}/original`)).body();
  await open(page);
  expect((await dialog(page).boundingBox())!.width).toBeGreaterThan(1400);
  await expect(dialog(page).getByLabel('Apply labels to existing timeline clips', { exact: true })).toHaveCount(0);
  await seek(page, .5, red.id, 2); await color(page, 0); await add(page).click();
  await seek(page, 1.5, blue.id, 2.5); await color(page, 2); await add(page).click();
  await expect(dialog(page).locator('.signal-editor-row')).toHaveCount(2);
  await expect(dialog(page).locator('.signal-editor-row').first()).toHaveAttribute('data-signal-time', '0.500000000');
  await expect(dialog(page).locator('.signal-editor-row').last()).toHaveAttribute('data-signal-time', '1.500000000');
  await dialog(page).getByLabel('Video labeler quality', { exact: true }).selectOption('original');
  await expect(add(page)).toBeEnabled(); await seek(page, .5, red.id, 2); await color(page, 0);
  await expect(dialog(page).locator('video.signal-editor-video')).toHaveAttribute('src', /\/original$/);
  await seek(page, 1.5, blue.id, 2.5); await color(page, 2);
  await expect(dialog(page).locator('video.signal-editor-video')).toHaveAttribute('src', /\/original$/);
  await dialog(page).getByLabel('Video labeler quality', { exact: true }).selectOption('proxy');
  await expect(add(page)).toBeEnabled();
  await seek(page, 1, blue.id, 2); await color(page, 2);
  await dialog(page).getByRole('button', { name: 'Previous frame', exact: true }).click();
  await expect(dialog(page).getByLabel('Source video frame', { exact: true })).toHaveValue('29');
  await expect(add(page)).toBeEnabled(); await color(page, 0);
  await dialog(page).getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(dialog(page).getByLabel('Source video frame', { exact: true })).toHaveValue('30');
  await expect(add(page)).toBeEnabled(); await color(page, 2);
  await seek(page, .8); await dialog(page).getByRole('button', { name: 'Play labeling video', exact: true }).click();
  await expect.poll(async () => Number(await dialog(page).getByLabel('Source video time', { exact: true }).inputValue())).toBeGreaterThan(1.2);
  await color(page, 2); await dialog(page).getByRole('button', { name: 'Pause labeling video', exact: true }).click();
  await seek(page, 1.5);
  await dialog(page).getByLabel('Video zoom', { exact: true }).fill('300');
  const stage = dialog(page).locator('.signal-editor-stage'); await expect(stage).toHaveAttribute('data-zoom', '3.000');
  const rect = (await stage.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 90, rect.y + rect.height / 2 + 35, { steps: 8 }); await page.mouse.up();
  expect(Math.abs(Number(await stage.getAttribute('data-pan-x')))).toBeGreaterThan(50);
  await page.screenshot({ path: 'data/v160-timeline-labeler.png', fullPage: true });
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  const after = await currentClip(request); expect(after).toEqual({ ...before, signals: [.5, 1.5] });
  const projectAfter = await active(request);
  expect(projectAfter.media).toEqual(projectBefore.media);
  expect(projectAfter.clips.filter((clip: { id: string }) => clip.id !== 'timeline-compound'))
    .toEqual(projectBefore.clips.filter((clip: { id: string }) => clip.id !== 'timeline-compound'));
  expect(await libraryLabels(request)).toEqual(labelsBefore);
  expect(await (await request.get(`/api/files/${red.id}/original`)).body()).toEqual(sourceBefore);
  await expect(page.locator('[data-clip-id="timeline-compound"] .signal-line')).toHaveCount(2);
  await page.keyboard.press('Control+z'); await saved(page); expect((await currentClip(request)).signals).toEqual([]);
  await page.keyboard.press('Control+Shift+z'); await saved(page); expect((await currentClip(request)).signals).toEqual([.5, 1.5]);
  await page.reload(); await saved(page); await open(page, true);
  await expect(dialog(page).locator('.signal-editor-row')).toHaveCount(2);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(errors).toEqual([]);
});

test('shows current retimed output seconds, preserves an unchanged warp and retains endpoint labels when replacing the draft', async ({ page, request }) => {
  await seed(page, request, true); const before = await currentClip(request), labelsBefore = await libraryLabels(request);
  await open(page);
  await expect(dialog(page).locator('.signal-editor-row').first()).toHaveAttribute('data-signal-time', '0.250000000');
  await expect(dialog(page).locator('.signal-editor-row').last()).toHaveAttribute('data-signal-time', '3.500000000');
  await seek(page, 1.5, blue.id, 3); await color(page, 2);
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  expect(await currentClip(request)).toEqual(before);
  await open(page, true); await mark(page, 1.5);
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  const after = await currentClip(request);
  expect(after.signals).toEqual([.25, 1.5, 2.5, 3.5]); expect(after.warp).toBeUndefined();
  expect(after.start).toBe(7); expect(after.muted).toBe(before.muted); expect(after.volume).toBe(before.volume);
  expect(after.segments.map((span: { speed: number }) => span.speed)).toEqual([4, 1]);
  await expect(page.locator('[data-clip-id="timeline-compound"]')).toHaveAttribute('data-clip-duration', '3.500000');
  expect(await libraryLabels(request)).toEqual(labelsBefore);
});

test('discards a cancelled timeline draft and prevents edits on locked clips or audio tracks', async ({ page, request }) => {
  await seed(page, request); const before = await active(request);
  await expect(page.getByRole('button', { name: 'Label selected video beats', exact: true })).toBeDisabled();
  await open(page); await mark(page, .5); await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible(); await expect(dialog(page)).toContainText('unsaved labels');
  await dialog(page).getByRole('button', { name: 'Play labeling video', exact: true }).click();
  await expect.poll(() => dialog(page).locator('video.signal-editor-video').evaluate((node: HTMLVideoElement) => node.paused)).toBe(false);
  await page.evaluate(() => { (window as Window & { timelineTestVideo?: HTMLVideoElement }).timelineTestVideo = document.querySelector('video.signal-editor-video') as HTMLVideoElement; });
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { timelineTestVideo?: HTMLVideoElement }).timelineTestVideo?.paused)).toBe(true);
  await saved(page); expect(await active(request)).toEqual(before);
  await choose(page, 'timeline-locked');
  await expect(page.getByRole('button', { name: 'Label selected video beats', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Label timeline clip beats', exact: true })).toBeDisabled();
  await choose(page, 'timeline-soundtrack');
  await expect(page.getByRole('button', { name: 'Label selected video beats', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Label timeline clip beats', exact: true })).toHaveCount(0);
  expect(await active(request)).toEqual(before);
});

test('keeps the timeline draft after a project-save failure and retries the edited labels without changing library marks', async ({ page, request }) => {
  await seed(page, request); const labelsBefore = await libraryLabels(request);
  await open(page); await mark(page, .5);
  let failed = false;
  await page.route('**/api/projects/*', async route => {
    const snapshot = route.request().method() === 'PUT' ? route.request().postDataJSON() : undefined;
    const labels = snapshot?.clips?.find((clip: { id: string }) => clip.id === 'timeline-compound')?.signals;
    if (!failed && labels?.length === 1 && Math.abs(labels[0] - .5) < .0001) {
      failed = true;
      await route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ detail: 'Synthetic timeline project save failure' }) });
    } else await route.continue();
  });
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click();
  await expect(dialog(page)).toBeVisible(); await expect(dialog(page).getByRole('alert')).toContainText('Synthetic timeline project save failure');
  await expect(dialog(page).locator('.signal-editor-row')).toHaveAttribute('data-signal-time', '0.500000000');
  await mark(page, 1.5);
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  expect(failed).toBe(true); expect((await currentClip(request)).signals).toEqual([.5, 1.5]);
  expect(await libraryLabels(request)).toEqual(labelsBefore);
  await page.reload(); await saved(page); await open(page);
  await expect(dialog(page).locator('.signal-editor-row')).toHaveCount(2);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('advances the output frame grid through slow repeated footage and an image-to-video cut', async ({ page, request }) => {
  const imagePath = resolve(folder, 'still.png');
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=640x360', '-frames:v', '1', imagePath], { windowsHide: true, timeout: 90_000 });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || String(result.error));
  const response = await request.post('/api/media', { multipart: { files: { name: `timeline-labeler-${fixture}-still.png`, mimeType: 'image/png', buffer: readFileSync(imagePath) } } });
  expect(response.ok()).toBe(true); const still = (await response.json()).media[0];
  const spans = [
    { mediaId: red.id, in: 1, out: 2, speed: .5, muted: false, volume: 1 },
    { mediaId: red.id, in: 4, out: 5, speed: 1, muted: false, volume: 1 },
    { mediaId: still.id, in: 0, out: 1, speed: 1, muted: false, volume: 1 },
    { mediaId: blue.id, in: 2, out: 3, speed: 1, muted: false, volume: 1 },
  ];
  const project = { id: `timeline-labeler-${fixture}-slow-repeat-image`, version: 1, name: 'Slow repeated clip with a still', aspect: '16:9',
    media: [red, blue, audio, still],
    tracks: [{ id: 'timeline-video-track', name: 'Video composition', kind: 'video', muted: false, hidden: false, locked: false }],
    clips: [{ id: 'timeline-compound', name: 'Slow repeated footage and still', trackId: 'timeline-video-track', start: 7,
      segments: spans, signals: [], muted: false, volume: 1 }] };
  expect((await request.put(`/api/projects/${project.id}`, { data: project })).ok()).toBe(true);
  await page.goto('/'); await saved(page); await choose(page);
  await expect(page.locator('[data-clip-id="timeline-compound"]')).toHaveAttribute('data-clip-duration', '5.000000');
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Label sync video beats', exact: true }).click();
  await expect(dialog(page)).toBeVisible(); await expect(add(page)).toBeEnabled();
  await seek(page, 0, red.id, 1);
  for (let frame = 1; frame <= 4; frame++) {
    await dialog(page).getByRole('button', { name: 'Next frame', exact: true }).click();
    await expect(dialog(page).getByLabel('Source video frame', { exact: true })).toHaveValue(String(frame));
    await expect(add(page)).toBeEnabled();
    await expect.poll(async () => Math.abs(Number(await dialog(page).getByLabel('Source video time', { exact: true }).inputValue()) - frame / 30)).toBeLessThan(.000001);
    // At half speed, output frame 1 still displays the source frame at 1s.
    // The marker must retain the requested output position, not jump to 0.
    if (frame === 1 || frame === 4) {
      await dialog(page).focus(); await page.keyboard.press('m');
      await expect(dialog(page).locator('.signal-editor-row').last()).toHaveAttribute('data-signal-time', (frame / 30).toFixed(9));
    }
  }
  await seek(page, 2.5, red.id, 4.5); await color(page, 0); await add(page).click();
  await seek(page, 3.5);
  await expect(dialog(page).locator('img.signal-editor-video')).toHaveAttribute('src', new RegExp(`/api/files/${still.id}/`));
  await expect.poll(() => dialog(page).locator('img.signal-editor-video').evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  await add(page).click();
  await seek(page, 3.8); await dialog(page).getByRole('button', { name: 'Play labeling video', exact: true }).click();
  await expect.poll(async () => Number(await dialog(page).getByLabel('Source video time', { exact: true }).inputValue())).toBeGreaterThan(4.1);
  await expect(dialog(page).locator('video.signal-editor-video')).toHaveAttribute('src', new RegExp(`/api/files/${blue.id}/`));
  await color(page, 2); await dialog(page).getByRole('button', { name: 'Pause labeling video', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  expect((await currentClip(request)).signals).toEqual([1 / 30, 4 / 30, 2.5, 3.5]);
  await expect(page.locator('[data-clip-id="timeline-compound"]')).toHaveAttribute('data-clip-duration', '5.000000');
});

test('accepts decoded frames overlapping fractional trim-in points and keeps exact clip-boundary labels', async ({ page, request }) => {
  await observePresentedFrames(page);
  const project = { id: `timeline-labeler-${fixture}-fractional-in`, version: 1, name: 'Fractional source trims', aspect: '16:9', media: [red, blue],
    tracks: [{ id: 'timeline-video-track', name: 'Video composition', kind: 'video', muted: false, hidden: false, locked: false }],
    clips: [{ id: 'timeline-compound', name: 'Fractional trimmed sources', trackId: 'timeline-video-track', start: 7,
      segments: [
        { mediaId: red.id, in: 1.01, out: 2.91, speed: 1, muted: false, volume: 1 },
        { mediaId: blue.id, in: 2.01, out: 4.01, speed: 1, muted: false, volume: 1 },
      ], signals: [], muted: false, volume: 1 }] };
  expect((await request.put(`/api/projects/${project.id}`, { data: project })).ok()).toBe(true);
  await page.goto('/'); await saved(page);
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Label sync video beats', exact: true }).click();
  await expect(dialog(page)).toBeVisible(); await expect(add(page)).toBeEnabled();
  await expect(dialog(page).getByLabel('Source video frame', { exact: true })).toHaveValue('0');
  const video = dialog(page).locator('video.signal-editor-video');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1.01001, 4);
  await expect.poll(async () => Number(await video.getAttribute('data-test-presented-time'))).toBeCloseTo(1, 5);
  await color(page, 0); await dialog(page).focus(); await page.keyboard.press('m');
  await expect(dialog(page).locator('.signal-editor-row')).toHaveAttribute('data-signal-time', '0.000000000');
  await seek(page, 1.9, blue.id, 2.01);
  await expect.poll(async () => Number(await video.getAttribute('data-test-presented-time'))).toBeCloseTo(2, 5);
  await expect(dialog(page).getByLabel('Source video frame', { exact: true })).toHaveValue('57');
  await color(page, 2); await add(page).click();
  await expect(dialog(page).locator('.signal-editor-row').last()).toHaveAttribute('data-signal-time', '1.900000000');
  await seek(page, 1.8, red.id, 2.81);
  await dialog(page).getByRole('button', { name: 'Play labeling video', exact: true }).click();
  await expect.poll(async () => Number(await dialog(page).getByLabel('Source video time', { exact: true }).inputValue())).toBeGreaterThan(2.1);
  await color(page, 2); await dialog(page).getByRole('button', { name: 'Pause labeling video', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  expect((await currentClip(request)).signals).toEqual([0, 1.9]);
});

test('labels a trimmed VFR frame gap in compatible and original quality after a completed seek', async ({ page, request }) => {
  const path = resolve(folder, 'vfr-gap.mov');
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
    '-vf', "select='not(between(n,30,74))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path], { windowsHide: true, timeout: 90_000 });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || String(result.error));
  const response = await request.post('/api/media', { multipart: { files: { name: `timeline-labeler-${fixture}-vfr-gap.mov`, mimeType: 'video/quicktime', buffer: readFileSync(path) } } });
  expect(response.ok()).toBe(true); const media = (await response.json()).media[0];
  expect(media.fps).toBeCloseTo(18.75, 2);
  const project = { id: `timeline-labeler-${fixture}-vfr-gap`, version: 1, name: 'Trim across a variable-rate frame gap', aspect: '16:9', media: [media],
    tracks: [{ id: 'timeline-video-track', name: 'Video composition', kind: 'video', muted: false, hidden: false, locked: false }],
    clips: [{ id: 'timeline-compound', name: 'VFR gap source', trackId: 'timeline-video-track', start: 0,
      segments: [{ mediaId: media.id, in: 1.5, out: 3.5, speed: 1, muted: false, volume: 1 }], signals: [], muted: false, volume: 1 }] };
  expect((await request.put(`/api/projects/${project.id}`, { data: project })).ok()).toBe(true);
  await observePresentedFrames(page); await page.goto('/'); await saved(page);
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Label sync video beats', exact: true }).click();
  await expect(dialog(page)).toBeVisible(); await expect(add(page)).toBeEnabled();
  const video = dialog(page).locator('video.signal-editor-video');
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState >= 2 && !node.seeking && Math.abs(node.currentTime - 1.50001) < .0001)).toBe(true);
  await expect.poll(async () => Number(await video.getAttribute('data-test-presented-time'))).toBeCloseTo(29 / 30, 4);
  await add(page).click();
  await expect(dialog(page).locator('.signal-editor-row')).toHaveAttribute('data-signal-time', '0.000000000');
  await dialog(page).getByLabel('Video labeler quality', { exact: true }).selectOption('original');
  await expect(video).toHaveAttribute('src', /\/original$/); await expect(add(page)).toBeEnabled();
  await expect.poll(async () => Number(await video.getAttribute('data-test-presented-time'))).toBeCloseTo(29 / 30, 4);
  await seek(page, .3, media.id, 1.8);
  await expect.poll(async () => Number(await video.getAttribute('data-test-presented-time'))).toBeCloseTo(29 / 30, 4);
  await add(page).click();
  await expect(dialog(page).locator('.signal-editor-row').last()).toHaveAttribute('data-signal-time', '0.300000000');
  await mark(page, 1.2);
  await seek(page, .8); await dialog(page).getByRole('button', { name: 'Play labeling video', exact: true }).click();
  await expect.poll(async () => Number(await dialog(page).getByLabel('Source video time', { exact: true }).inputValue())).toBeGreaterThan(1.1);
  await dialog(page).getByRole('button', { name: 'Pause labeling video', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save labels', exact: true }).click(); await expect(dialog(page)).toBeHidden(); await saved(page);
  expect((await currentClip(request)).signals).toEqual([0, .3, 1.2]);
});
