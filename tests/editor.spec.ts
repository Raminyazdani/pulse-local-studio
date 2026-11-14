import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixtureId = `${Date.now()}-${process.pid}`;
const fixtureDirectory = resolve('data', 'test-fixtures', fixtureId);
const audioName = `pulse-kicks-${fixtureId}.wav`;
const redName = `pulse-red-${fixtureId}.mp4`;
const blueName = `pulse-blue-${fixtureId}.mp4`;

function command(program: string, args: string[]): Buffer {
  const result = spawnSync(program, args, { windowsHide: true, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr.toString()}`);
  return result.stdout;
}

function makeFixtures() {
  mkdirSync(fixtureDirectory, { recursive: true });
  // Physical 70 Hz kick attacks at half-second intervals, with no invented
  // tempo grid. This lets us check detection against known audible events.
  const rate = 22050;
  const samples = rate * 6;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let beat = 0.5; beat < 6; beat += 0.5) {
    const start = Math.round(beat * rate);
    for (let sample = 0; sample < Math.round(0.12 * rate); sample++) {
      const time = sample / rate;
      const value = 0.8 * Math.sin(2 * Math.PI * 70 * time) * Math.exp(-35 * time);
      wav.writeInt16LE(Math.round(value * 32767), 44 + (start + sample) * 2);
    }
  }
  writeFileSync(resolve(fixtureDirectory, audioName), wav);
  for (const [color, name] of [['red', redName], ['blue', blueName]]) {
    command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=2`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', resolve(fixtureDirectory, name)]);
  }
}

async function playheadTime(page: Page): Promise<number> {
  const text = await page.locator('.transport-time').innerText();
  const match = text.match(/(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

async function clearProjectOnce(page: Page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('pulse.test.initialized')) {
      localStorage.clear();
      sessionStorage.setItem('pulse.test.initialized', '1');
    }
  });
}

async function seek(page: Page, seconds: number) {
  const ruler = page.locator('.ruler');
  const zoom = Number(await page.getByLabel('Timeline zoom').inputValue());
  await ruler.click({ position: { x: seconds * zoom, y: 10 } });
}

function meanColor(path: string, time: number): number[] {
  const frame = command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', path,
    '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return [...frame.subarray(0, 3)];
}

test.beforeAll(makeFixtures);

async function openFreshProject(page: Page) {
  // Disk autosave intentionally survives clearing browser storage. Each edit
  // scenario creates its own graph instead of changing the prior project.
  await page.getByLabel('Saved projects', { exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('.saved-label')).toHaveText('Saved to folder');
}

test('imports, edits and exports a beat-synced compound video using original media', async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await clearProjectOnce(page);
  await page.goto('/');
  await expect(page.getByText('Everything stays local')).toBeVisible();
  await openFreshProject(page);
  await page.getByLabel('Project name', { exact: true }).fill('Browser verification');
  await page.locator('input[type="file"][multiple]').setInputFiles([audioName, redName, blueName].map(name => resolve(fixtureDirectory, name)));
  for (const name of [audioName, redName, blueName]) {
    await expect(page.getByTitle(`Add ${name} to timeline`, { exact: true })).toBeAttached();
    await page.getByTitle(`Add ${name} to timeline`, { exact: true }).click();
  }
  await expect(page.locator('.timeline-clip.video')).toHaveCount(2);
  await expect(page.locator('.timeline-clip.audio')).toHaveCount(1);

  await page.locator('.timeline-clip.audio').click();
  const analyzed = page.waitForResponse(response => response.url().includes('/api/analyze/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Detect beats', exact: true }).click();
  const detection = await (await analyzed).json() as { beats: number[]; bpm: number };
  expect(detection.beats).toHaveLength(11);
  expect(Math.abs(detection.bpm - 120)).toBeLessThan(1);
  detection.beats.forEach((time, index) => expect(Math.abs(time - (index + 1) * 0.5)).toBeLessThan(0.02));
  await expect(page.locator('.beat-line')).toHaveCount(11);
  await page.getByRole('button', { name: '1 / 2', exact: true }).click();
  await expect(page.locator('.beat-line')).toHaveCount(6);
  await page.locator('.segmented-control').getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.locator('.beat-line')).toHaveCount(11);

  await page.locator('.timeline-clip.video').first().click();
  await page.getByRole('button', { name: 'Merge track', exact: true }).click();
  await expect(page.locator('.timeline-clip.video')).toHaveCount(1);
  await expect(page.locator('.timeline-clip.video')).toContainText('Merged sequence');

  // A real playback crossing from the first file into the second catches
  // clock freezes, stale source URLs, and seeks to the wrong compound span.
  await seek(page, 1.6);
  await page.getByTitle('Play / pause (Space)', { exact: true }).click();
  await expect.poll(() => playheadTime(page), { timeout: 12_000 }).toBeGreaterThan(2.6);
  await page.getByTitle('Play / pause (Space)', { exact: true }).click();
  await expect(page.locator('.pulse-preview-buffer')).toHaveCount(0);
  await expect(page.locator('.pulse-preview-error')).toHaveCount(0);
  const pausedAt = await playheadTime(page);
  await page.waitForTimeout(200);
  expect(Math.abs(await playheadTime(page) - pausedAt)).toBeLessThan(0.02);
  await expect.poll(async () => page.locator('.pulse-preview-media').evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 5_000 }).toBeGreaterThan(0.5);
  const previewPixel = await page.locator('video.pulse-preview-media').evaluate((video: HTMLVideoElement) => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
  expect(previewPixel[2]).toBeGreaterThan(previewPixel[0] + 100);

  const merged = page.locator('.timeline-clip.video');
  const zoom = Number(await page.getByLabel('Timeline zoom').inputValue());
  await page.getByTitle('Beat marker tool (B). Click a clip to add a marker.', { exact: true }).click();
  for (const time of [0.25, 1.25, 3.25]) {
    await merged.click({ position: { x: time * zoom, y: 35 } });
  }
  await expect(page.locator('.signal-line')).toHaveCount(3);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Sync to the beat', exact: true }).click();
  await expect(merged).toHaveClass(/warped/);
  const speeds = (await page.locator('.speed-map strong').allTextContents()).map(text => Number.parseFloat(text));
  expect(speeds.some(speed => Math.abs(speed - 2) < 0.06)).toBe(true);
  expect(speeds.some(speed => Math.abs(speed - 4) < 0.12)).toBe(true);
  await page.getByTitle('Selection tool (V)', { exact: true }).click();
  await page.locator('.editing-bar').getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(merged).toHaveClass(/muted/);

  // Seek through a changed speed and the compound boundary once more.
  await seek(page, 0.45);
  await page.getByTitle('Play / pause (Space)', { exact: true }).click();
  await expect.poll(() => playheadTime(page), { timeout: 10_000 }).toBeGreaterThan(2);
  await page.getByTitle('Play / pause (Space)', { exact: true }).click();
  await expect(page.locator('.pulse-preview-error')).toHaveCount(0);

  await page.locator('.header-actions').getByRole('button', { name: 'Export film', exact: true }).click();
  await page.locator('.export-modal select').first().selectOption('1280x720');
  await page.locator('.export-modal').getByRole('button', { name: 'Export film', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download film', exact: true })).toBeVisible({ timeout: 90_000 });
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download film', exact: true }).click();
  const download = await downloading;
  const exported = testInfo.outputPath('beat-synced-film.mp4');
  await download.saveAs(exported);
  const info = JSON.parse(command('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', exported]).toString());
  expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThan(0.05);
  const video = info.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  expect(video.width).toBe(1280);
  expect(video.height).toBe(720);
  expect(video.codec_name).toBe('h264');
  const red = meanColor(exported, 0.7);
  const blue = meanColor(exported, 1.4);
  expect(red[0]).toBeGreaterThan(red[2] + 100);
  expect(blue[2]).toBeGreaterThan(blue[0] + 100);
  // The source videos contain a constant tone. After muting, the quiet space
  // between kicks must remain quiet rather than leaking the original audio.
  const audio = command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.8', '-t', '0.08', '-i', exported,
    '-vn', '-ac', '1', '-f', 'f32le', 'pipe:1']);
  let peak = 0;
  for (let offset = 0; offset < audio.length; offset += 4) peak = Math.max(peak, Math.abs(audio.readFloatLE(offset)));
  expect(peak).toBeLessThan(0.01);
  await testInfo.attach('Rendered beat-synced film', { path: exported, contentType: 'video/mp4' });
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('pulse.project.v1') || '{}');
    return saved.clips?.filter((clip: { warp?: unknown; muted?: boolean }) => clip.warp && clip.muted).length;
  })).toBe(1);
  await page.reload();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Browser verification');
  await expect(page.locator('.timeline-clip.video')).toHaveCount(1);
  await expect(page.locator('.timeline-clip.video')).toHaveClass(/warped/);
  await expect(page.locator('.timeline-clip.video')).toHaveClass(/muted/);
  await expect(page.locator('.timeline-clip.audio')).toHaveCount(1);
  await expect(page.locator('.signal-line')).toHaveCount(3);
  await expect(page.locator('.beat-line')).toHaveCount(11);
  expect(browserErrors).toEqual([]);
});

test('keeps hidden video audio audible and polls rendering jobs through completion', async ({ page }) => {
  await clearProjectOnce(page);
  await page.goto('/');
  await expect(page.getByText('Everything stays local')).toBeVisible();
  await openFreshProject(page);
  const pollingName = `pulse-polling-${fixtureId}.mp4`;
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: pollingName, mimeType: 'video/mp4', buffer: readFileSync(resolve(fixtureDirectory, redName)) });
  const add = page.getByTitle(`Add ${pollingName} to timeline`, { exact: true });
  await expect(add).toBeAttached();
  await add.click();
  const visiblePlayer = await page.locator('video.pulse-preview-media').elementHandle();
  expect(visiblePlayer).not.toBeNull();
  await page.getByTitle('Play / pause (Space)', { exact: true }).click();
  await expect.poll(async () => page.locator('video.pulse-preview-media').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.3);
  await page.locator('.track-row.video').getByTitle('Hide track', { exact: true }).click();
  await expect(page.locator('video.pulse-preview-media')).toHaveCount(0);
  await expect(page.locator('.pulse-preview-stage audio')).toHaveCount(1);
  expect(await visiblePlayer!.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await visiblePlayer!.dispose();
  await expect.poll(async () => page.locator('.pulse-preview-stage audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.5);
  expect(await page.locator('.pulse-preview-stage audio').evaluate((audio: HTMLAudioElement) => audio.muted)).toBe(false);
  await page.getByTitle('Play / pause (Space)', { exact: true }).click();

  let polls = 0;
  await page.route('**/api/export', route => route.fulfill({ json: { id: 'polling-check' } }));
  await page.route('**/api/export/polling-check', route => {
    polls++;
    return route.fulfill({ json: polls < 3
      ? { id: 'polling-check', status: 'rendering', progress: polls === 1 ? 20 : 60 }
      : { id: 'polling-check', status: 'complete', progress: 100, url: '/api/export/polling-check/download' } });
  });
  await page.locator('.header-actions').getByRole('button', { name: 'Export film', exact: true }).click();
  await page.locator('.export-modal').getByRole('button', { name: 'Export film', exact: true }).click();
  await expect(page.locator('.export-progress strong')).toHaveText('20%');
  await expect(page.locator('.export-modal').getByRole('button', { name: 'Rendering locally', exact: true })).toBeDisabled();
  await expect(page.locator('.export-progress strong')).toHaveText('60%');
  await expect(page.locator('.export-modal').getByRole('button', { name: 'Rendering locally', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Download film', exact: true })).toBeVisible();
  expect(polls).toBeGreaterThanOrEqual(3);
});
