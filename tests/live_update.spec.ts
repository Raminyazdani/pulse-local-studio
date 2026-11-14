import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test.skip(process.env.PULSE_LIVE_UPDATE_TEST !== '1', 'Run through scripts/verify_live_update.py against an isolated frozen older app.');

test('updates a real older portable binary from its published GitHub release and reopens its saved edit', async ({ page, request }, testInfo) => {
  test.setTimeout(540_000);
  const oldVersion = process.env.PULSE_LIVE_UPDATE_OLD!;
  const targetVersion = process.env.PULSE_LIVE_UPDATE_TARGET!;
  const output = process.env.PULSE_LIVE_UPDATE_REPORT!;
  const errors: string[] = [];
  const requests: { path: string; method: string }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ path: new URL(request.url()).pathname, method: request.method() }));
  await page.goto('/');
  await expect(page.locator('.saved-label')).toHaveText('Saved to folder');
  await expect(page.locator('.timeline-clip.video')).toHaveCount(1);
  await expect(page.locator('.timeline-clip.video')).toHaveClass(/warped/);
  await expect(page.locator('.timeline-clip.audio')).toHaveCount(1);
  await expect(page.locator('.signal-line')).toHaveCount(3);
  const before = await (await request.get('/api/projects/active')).json();
  expect((await (await request.get('/api/health')).json()).version).toBe(oldVersion);

  await page.getByLabel('Check for updates', { exact: true }).click();
  await expect.poll(async () => {
    const response = await request.get('/api/updates');
    const state = await response.json();
    if (state.status === 'error') throw new Error(state.error || state.message || 'GitHub update check failed.');
    return state.status;
  }, { timeout: 90_000, intervals: [500, 1000, 1500] }).toBe('available');
  await expect(page.locator('.pulse-update-versions')).toContainText(`v${oldVersion}`);
  await expect(page.locator('.pulse-update-versions')).toContainText(`v${targetVersion}`);
  await expect(page.getByRole('button', { name: 'Update now', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('real-github-update-available.png'), fullPage: true });
  const navigation = page.waitForEvent('domcontentloaded', { timeout: 420_000 });
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await navigation;
  await expect(page.getByLabel('Check for updates', { exact: true })).toBeVisible();
  await expect(page.locator('.saved-label')).toHaveText('Saved to folder');
  const health = await (await request.get('/api/health')).json();
  expect(health.version).toBe(targetVersion);
  const after = await (await request.get('/api/projects/active')).json();
  expect(after.project).toEqual(before.project);
  await expect(page.locator('.timeline-clip.video')).toHaveClass(/warped/);
  await expect(page.locator('.signal-line')).toHaveCount(3);
  await expect(page.locator('.beat-line')).toHaveCount(6);
  const installRequests = requests.filter(request => request.path === '/api/updates/install' && request.method === 'POST');
  expect(installRequests).toHaveLength(1);
  expect(errors).toEqual([]);
  const screenshot = testInfo.outputPath('real-github-update-complete.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Updated editor with saved project', { path: screenshot, contentType: 'image/png' });
  writeFileSync(output, JSON.stringify({ passed: true, oldVersion, targetVersion, installRequests: installRequests.length,
    projectId: after.project.id, projectName: after.project.name, signals: 3, browserErrors: errors, screenshot }, null, 2), 'utf8');
});
