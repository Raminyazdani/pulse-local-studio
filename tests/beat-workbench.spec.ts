import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.skip(process.env.PULSE_BEAT_TEST !== '1', 'Requires an explicitly isolated beat-workbench verification workspace.');
const id = `${Date.now()}-${process.pid}`, folder = resolve('data', 'beat-fixtures', id);
let asset: Record<string, unknown>;
function fixture() {
  mkdirSync(folder, { recursive: true });
  const rate = 22050, count = rate * 6, samples = new Float64Array(count);
  let seed = 123;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let at = .5; at < 5.6; at += .5) for (let n = 0; n < .14 * rate; n++) {
    const t = n / rate; samples[Math.round(at * rate) + n] += .08 * Math.sin(2 * Math.PI * 65 * t) * Math.exp(-30 * t);
  }
  for (let at = .25; at < 5.8; at += .5) for (let n = 0; n < .045 * rate; n++) {
    const t = n / rate; samples[Math.round(at * rate) + n] += .36 * Math.sin(2 * Math.PI * 6500 * t) * Math.exp(-95 * t);
  }
  for (let at = 1.25; at < 5.3; at += 1) for (let n = 0; n < .12 * rate; n++) {
    const t = n / rate; samples[Math.round(at * rate) + n] += .6 * random() * Math.exp(-45 * t);
  }
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(count * 2, 40);
  samples.forEach((v, i) => buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  writeFileSync(resolve(folder, 'quiet-bass-bright-percussion.wav'), buffer);
}
const saved = async (page: Page) => { await expect(page.locator('.saved-label')).toHaveText('Saved to folder'); };
const active = async (request: APIRequestContext) => (await (await request.get('/api/projects/active')).json()).project;
async function seed(page: Page, request: APIRequestContext, manual?: number[]) {
  const project = { id: `beat-workbench-${id}-${manual ? 'manual' : 'groups'}`, version: 1, name: 'Beat tools — synthetic quiet bass', aspect: '16:9', media: [asset],
    tracks: [{ id: 'music', name: 'Music', kind: 'audio', muted: false, hidden: false, locked: false }],
    clips: [{ id: 'music-clip', name: 'Quiet bass / bright percussion', trackId: 'music', start: 0,
      segments: [{ mediaId: asset.id, in: 0, out: 6, speed: 1 }], signals: [], muted: false, volume: 1, ...(manual ? { beatEdits: manual } : {}) }] };
  expect((await request.put(`/api/projects/${project.id}`, { data: project })).ok()).toBe(true);
  await page.goto('/'); await saved(page);
  await page.locator('.timeline-clip.audio').click({ position: { x: 50, y: 45 } });
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Beats', exact: true }).click();
}
test.beforeAll(async ({ request }) => {
  expect(process.env.PULSE_EDIT_WORKSPACE_KEY).toBeTruthy();
  expect((await (await request.get('/api/health')).json()).workspaceKey).toBe(process.env.PULSE_EDIT_WORKSPACE_KEY);
  fixture();
  const response = await request.post('/api/media', { multipart: { files: { name: `beat-tools-${id}.wav`, mimeType: 'audio/wav', buffer: readFileSync(resolve(folder, 'quiet-bass-bright-percussion.wav')) } } });
  expect(response.ok()).toBe(true); asset = (await response.json()).media[0];
});

test('detects and auditions quiet-bass groups, filters groups, and deletes picked beats without deleting music', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await seed(page, request);
  const detection = page.waitForResponse(r => r.url().includes('/api/analyze/'));
  await page.getByRole('button', { name: 'Detect beats', exact: true }).click();
  const result = await (await detection).json();
  expect(result.beatGroups.length).toBeGreaterThan(1);
  const bassGroup = result.beatGroups.find((g: { label: string }) => /Bass-heavy/.test(g.label)); expect(bassGroup).toBeTruthy();
  const bassTimes = bassGroup.beatIndices.map((i: number) => result.beats[i]);
  expect(bassTimes).toHaveLength(11);
  for (let i = 0; i < 11; i++) expect(Math.abs(bassTimes[i] - (i + 1) * .5)).toBeLessThan(.03);
  const bassRow = page.locator('.beat-group').filter({ hasText: 'Bass-heavy' }).first();
  await expect(bassRow).toBeVisible();
  const playing = page.waitForFunction(() => {
    const audio = document.querySelector('[data-testid="beat-audition"]') as HTMLAudioElement | null;
    return audio && !audio.paused && audio.currentTime > .01;
  }, null, { polling: 20 });
  await bassRow.getByRole('button', { name: /^Play .* sample$/ }).click(); await playing;
  await expect.poll(() => page.getByTestId('beat-audition').evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  const replaying = page.waitForFunction(() => !(document.querySelector('[data-testid="beat-audition"]') as HTMLAudioElement)?.paused, null, { polling: 20 });
  await bassRow.getByRole('button', { name: /^Play .* sample$/ }).click(); await replaying;
  await page.evaluate(() => {
    (window as Window & { pulseAudition?: HTMLAudioElement }).pulseAudition = document.querySelector('[data-testid="beat-audition"]') as HTMLAudioElement;
    const clipTab = [...document.querySelectorAll<HTMLButtonElement>('.inspector-tabs button')].find(b => b.textContent?.trim() === 'Clip');
    clipTab!.click();
  });
  await expect.poll(() => page.evaluate(() => (window as Window & { pulseAudition?: HTMLAudioElement }).pulseAudition?.paused)).toBe(true);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Beats', exact: true }).click();
  const rows = page.locator('.beat-group');
  for (let i = 0; i < await rows.count(); i++) if (!(await rows.nth(i).innerText()).includes('Bass-heavy')) await rows.nth(i).getByRole('checkbox').uncheck();
  await expect(page.locator('.beat-line')).toHaveCount(11); await saved(page);
  await page.reload(); await saved(page); await expect(page.locator('.beat-line')).toHaveCount(11);
  await page.getByRole('button', { name: 'Select timeline beat 2', exact: true }).click();
  await page.getByRole('button', { name: 'Select timeline beat 3', exact: true }).click({ modifiers: ['Control'] });
  await expect(page.locator('.beat-picked')).toHaveCount(2);
  await page.keyboard.press('Delete'); await expect(page.locator('.beat-line')).toHaveCount(9);
  await expect(page.locator('.timeline-clip.audio')).toHaveCount(1); await saved(page);
  await page.keyboard.press('Control+z'); await expect(page.locator('.beat-line')).toHaveCount(11);
  const project = await active(request); expect(project.clips).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('replaces other beats with a precise selected rhythm, previews it, persists and supports undo', async ({ page, request }) => {
  await seed(page, request, [.5, 1, 1.3, 1.5, 2.2, 4.7]);
  await page.getByRole('button', { name: 'Select timeline beat 1', exact: true }).click();
  await page.getByRole('button', { name: 'Select timeline beat 2', exact: true }).click({ modifiers: ['Control'] });
  await expect(page.getByLabel('Beat repeat interval', { exact: true })).toHaveValue('0.5');
  await page.getByLabel('Preview repeated beats', { exact: true }).check();
  await expect(page.locator('.beat-repeat-ghost')).toHaveCount(12);
  expect((await active(request)).clips[0].beatEdits).toEqual([.5, 1, 1.3, 1.5, 2.2, 4.7]);
  await page.getByRole('button', { name: 'Filter & repeat', exact: true }).click();
  await expect(page.locator('.beat-line')).toHaveCount(12); await saved(page);
  const result = (await active(request)).clips[0];
  expect(result.beatEdits).toEqual(Array.from({ length: 12 }, (_, i) => i * .5));
  expect(result.segments[0]).toMatchObject({ in: 0, out: 6 });
  await page.reload(); await saved(page); await expect(page.locator('.beat-line')).toHaveCount(12);
  await page.getByRole('button', { name: 'Select timeline beat 2', exact: true }).click();
  await page.getByRole('button', { name: 'Select timeline beat 4', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.beat-picked')).toHaveCount(3);
  await page.getByRole('button', { name: 'Delete selected beats', exact: true }).click(); await expect(page.locator('.beat-line')).toHaveCount(9);
  await page.keyboard.press('Control+z'); await expect(page.locator('.beat-line')).toHaveCount(12);
  await page.screenshot({ path: 'data/v140-beat-workbench.png', fullPage: true });
});

test('invalidates picked markers when source selection or sampling changes', async ({ page, request }) => {
  await seed(page, request, [.5, 1, 1.5, 2, 2.5, 3]);
  await page.getByRole('button', { name: 'Select timeline beat 2', exact: true }).click();
  await expect(page.locator('.beat-picked')).toHaveCount(1);
  await page.locator('.inspector-tabs').getByRole('button', { name: 'Clip', exact: true }).click();
  const source = page.getByLabel('Source selection in', { exact: true }); await source.fill('0.5'); await source.press('Tab');
  await expect(page.locator('.beat-picked')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select timeline beat 2', exact: true }).click();
  await page.getByRole('button', { name: '1 / 2', exact: true }).click();
  await expect(page.locator('.beat-picked')).toHaveCount(0); await saved(page);
  await expect(page.locator('.timeline-clip.audio')).toHaveCount(1);
  await page.getByLabel('Select beat 1', { exact: true }).check();
  await page.keyboard.press('Delete'); await expect(page.locator('.beat-line')).toHaveCount(2);
  await expect(page.locator('.timeline-clip.audio')).toHaveCount(1);
  await page.keyboard.press('Control+z'); await expect(page.locator('.beat-line')).toHaveCount(3);
});
