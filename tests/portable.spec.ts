import { expect, test } from '@playwright/test';

test.skip(process.env.PULSE_PORTABLE_TEST !== '1', 'Run through scripts/verify_portable.py --browser against isolated frozen data.');

test('restores the moved portable project, plays original MOV proxies, and saves edits to the folder', async ({ page, request }) => {
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = request.url();
    if (url.startsWith('http') && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) externalRequests.push(url);
  });
  // A fresh browser has no localStorage. Folder persistence must supply the
  // timeline, speed map, manually edited beats, track states and media IDs.
  await page.goto('/');
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('پروژه قابل حمل');
  await expect(page.locator('.timeline-clip.video')).toHaveCount(1);
  await expect(page.locator('.timeline-clip.video')).toHaveClass(/warped/);
  await expect(page.locator('.timeline-clip.video')).toHaveClass(/muted/);
  await expect(page.locator('.timeline-clip.audio')).toHaveCount(1);
  await expect(page.locator('.signal-line')).toHaveCount(3);
  await expect(page.locator('.beat-line')).toHaveCount(6);
  const original = await (await request.get('/api/projects/active')).json();
  expect(original.project.clips[0].segments).toHaveLength(2);
  expect(original.project.clips[0].warp).toHaveLength(5);

  const zoom = Number(await page.getByLabel('Timeline zoom').inputValue());
  await page.locator('.ruler').click({ position: { x: .7 * zoom, y: 10 } });
  await expect(page.locator('video.pulse-preview-media')).toBeVisible();
  await expect.poll(async () => page.locator('video.pulse-preview-media').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByTitle('Play / pause (Space)', { exact: true }).click();
  await expect.poll(async () => {
    const text = await page.locator('.transport-time').innerText();
    const match = text.match(/(\d+):(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  }).toBeGreaterThan(1.35);
  await page.getByTitle('Play / pause (Space)', { exact: true }).click();
  await expect(page.locator('.pulse-preview-error')).toHaveCount(0);

  await page.getByLabel('Project name', { exact: true }).fill('Portable edit saved after moving');
  await expect.poll(async () => (await (await request.get('/api/projects/active')).json()).project.name).toBe('Portable edit saved after moving');
  await page.reload();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Portable edit saved after moving');
  await expect(page.locator('.timeline-clip.video')).toHaveClass(/warped/);
  await expect(page.locator('.signal-line')).toHaveCount(3);
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});
