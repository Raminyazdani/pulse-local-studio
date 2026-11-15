import { expect, test, type Page } from '@playwright/test';

test.skip(process.env.PULSE_BEAT_TEST !== '1', 'Requires an explicitly isolated workspace verification server.');

test.beforeAll(async ({ request }) => {
  expect(process.env.PULSE_EDIT_WORKSPACE_KEY).toBeTruthy();
  expect((await (await request.get('/api/health')).json()).workspaceKey).toBe(process.env.PULSE_EDIT_WORKSPACE_KEY);
});
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.saved-label')).toHaveText('Saved to folder');
  await page.getByRole('button', { name: 'Arrange workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Reset workspace layout', exact: true }).click();
  await page.getByRole('button', { name: 'Close workspace arrangement', exact: true }).click();
});
const bounds = async (page: Page) => ({
  preview: (await page.locator('.preview-canvas').boundingBox())!,
  workspace: (await page.locator('.workspace').boundingBox())!,
  library: (await page.locator('.media-panel').boundingBox())!,
  inspector: (await page.locator('.inspector').boundingBox())!,
  timeline: (await page.locator('.timeline-panel').boundingBox())!,
});

test('resizes actual preview and timeline with pointer, keyboard, cancellation and persisted settings', async ({ page, request }) => {
  const beforeProject = (await (await request.get('/api/projects/active')).json()).project;
  const initial = await bounds(page);
  await page.getByRole('button', { name: 'Make preview larger', exact: true }).click();
  let larger = await bounds(page);
  expect(larger.preview.height).toBeGreaterThan(initial.preview.height + 30);
  expect(larger.timeline.height).toBeLessThan(initial.timeline.height - 30);
  await page.reload(); await expect(page.locator('.saved-label')).toHaveText('Saved to folder');
  expect((await bounds(page)).preview.height).toBeCloseTo(larger.preview.height, 0);

  const separator = page.getByRole('separator', { name: 'Resize preview and timeline', exact: true });
  await separator.focus(); await separator.press('Home');
  const small = await bounds(page);
  await separator.press('End'); larger = await bounds(page);
  expect(larger.timeline.height).toBe(180);
  expect(larger.preview.height).toBeGreaterThan(small.preview.height + 350);
  const rect = (await separator.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 5); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2, rect.y - 100, { steps: 8 });
  expect((await bounds(page)).preview.height).toBeLessThan(larger.preview.height - 80);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect((await bounds(page)).preview.height).toBe(larger.preview.height);
  await separator.dblclick(); expect((await bounds(page)).timeline.height).toBe(initial.timeline.height);
  expect((await (await request.get('/api/projects/active')).json()).project).toEqual(beforeProject);
});

test('resizes all panel widths, reorders by grip and settings, moves timeline, persists and resets', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const initial = await bounds(page);
  await page.locator('.preview-panel').evaluate(element => { (element as HTMLElement).dataset.mountToken = 'preserved'; });
  const divider = page.getByRole('separator', { name: 'Resize Media library and Preview', exact: true });
  const rect = (await divider.boundingBox())!;
  await page.mouse.move(rect.x + 4, rect.y + 160); await page.mouse.down();
  await page.mouse.move(rect.x + 104, rect.y + 160, { steps: 10 }); await page.mouse.up();
  expect((await bounds(page)).library.width).toBe(initial.library.width + 100);
  await divider.focus(); await divider.press('ArrowLeft');
  expect((await bounds(page)).library.width).toBe(initial.library.width + 84);

  await page.getByRole('button', { name: 'Arrange workspace', exact: true }).click();
  await page.getByLabel('Media library position', { exact: true }).selectOption('2');
  await page.getByLabel('Timeline position', { exact: true }).selectOption('above');
  await page.getByLabel('Inspector width', { exact: true }).fill('350');
  await page.getByRole('button', { name: 'Close workspace arrangement', exact: true }).click();
  let after = await bounds(page);
  expect(after.library.x).toBeGreaterThan(after.inspector.x);
  expect(after.timeline.y).toBeLessThan(after.workspace.y);
  expect(after.inspector.width).toBe(350);
  await expect(page.locator('.preview-panel')).toHaveAttribute('data-mount-token', 'preserved');
  await page.reload(); await expect(page.locator('.saved-label')).toHaveText('Saved to folder');
  after = await bounds(page); expect(after.timeline.y).toBeLessThan(after.workspace.y); expect(after.inspector.width).toBe(350);

  // Header grips offer keyboard reordering without replacing the preview DOM.
  const grip = page.getByRole('button', { name: 'Move Media library panel', exact: true });
  await grip.focus(); await grip.press('Home');
  expect((await bounds(page)).library.x).toBe(0);
  // Exercise HTML drag/drop, including the overlay that supplies visible targets.
  await grip.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  const zones = page.locator('.workspace-panel-dropzone'); await expect(zones).toHaveCount(3);
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData('application/x-pulse-workspace-panel', 'library'); return data; });
  await zones.last().dispatchEvent('drop', { dataTransfer: transfer });
  await expect(zones).toHaveCount(0); after = await bounds(page); expect(after.library.x).toBeGreaterThan(after.inspector.x);

  await page.getByRole('button', { name: 'Arrange workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Reset workspace layout', exact: true }).click();
  await page.getByRole('button', { name: 'Close workspace arrangement', exact: true }).click();
  after = await bounds(page);
  expect(after.library.x).toBe(0); expect(after.timeline.y).toBeGreaterThan(after.workspace.y);
  expect(after.library.width).toBe(initial.library.width); expect(after.inspector.width).toBe(initial.inspector.width);
  expect(errors).toEqual([]);
});

test('keeps resized and reordered panels usable across small and large viewports', async ({ page }) => {
  for (const [width, height] of [[1024, 768], [1280, 720], [1600, 1000]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'Arrange workspace', exact: true }).click();
    const libraryWidth = page.getByLabel('Media library width', { exact: true });
    const inspectorWidth = page.getByLabel('Inspector width', { exact: true });
    await libraryWidth.fill((await libraryWidth.getAttribute('max'))!);
    await inspectorWidth.fill((await inspectorWidth.getAttribute('max'))!);
    await page.getByLabel('Preview position', { exact: true }).selectOption('0');
    await page.getByRole('button', { name: 'Close workspace arrangement', exact: true }).click();
    await page.getByRole('separator', { name: 'Resize preview and timeline', exact: true }).focus();
    await page.keyboard.press('Home');
    const geometry = await bounds(page);
    expect(geometry.preview.height).toBeGreaterThan(40);
    expect((await page.locator('.preview-panel').boundingBox())!.width).toBeGreaterThanOrEqual(320);
    expect(geometry.timeline.y + geometry.timeline.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.preview-heading').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(page.locator('.saved-label')).toBeVisible();
    await page.screenshot({ path: `data/workspace-v140-${width}x${height}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Arrange workspace', exact: true }).click();
  await page.getByLabel('Timeline position', { exact: true }).selectOption('above');
  await page.getByRole('button', { name: 'Close workspace arrangement', exact: true }).click();
  await page.getByRole('separator', { name: 'Resize preview and timeline', exact: true }).press('Home');
  await page.getByRole('button', { name: 'Arrange workspace', exact: true }).click();
  const popup = (await page.getByRole('dialog', { name: 'Arrange workspace', exact: true }).boundingBox())!;
  expect(popup.y).toBeGreaterThanOrEqual(0);
  expect(popup.y + popup.height).toBeLessThanOrEqual(720);
  await page.getByRole('button', { name: 'Reset workspace layout', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Reset workspace layout', exact: true })).toBeInViewport();
});
