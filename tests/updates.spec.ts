import { expect, test, type Page } from '@playwright/test';

const project = () => ({ id: 'project-update-test', version: 1, name: 'Update test', aspect: '16:9', media: [], tracks: [], clips: [] });
const available = { currentVersion: '1.2.0', latestVersion: '1.3.0', status: 'available', progress: 0, portable: true, repository: 'test/pulse', releaseUrl: 'https://github.com/test/pulse/releases/tag/v1.3.0' };

/** Keep these checks independent of the user's disk projects and GitHub. */
async function mockWorkspace(page: Page) {
  const events: string[] = [];
  const workspace = { saved: project(), healthVersion: '1.2.0', events };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/health') return route.fulfill({ json: { ok: true, portable: true, version: workspace.healthVersion } });
    if (path === '/api/media') return route.fulfill({ json: { media: [] } });
    if (path === '/api/projects/active') return route.fulfill({ json: { project: workspace.saved } });
    if (path === '/api/projects') return route.fulfill({ json: { projects: [{ id: workspace.saved.id, name: workspace.saved.name, updated: 1 }] } });
    if (path.startsWith('/api/projects/') && request.method() === 'PUT') {
      workspace.saved = request.postDataJSON();
      events.push(`save:${workspace.saved.name}`);
      return route.fulfill({ json: { id: workspace.saved.id, updated: Date.now() / 1000 } });
    }
    if (path.startsWith('/api/projects/')) return route.fulfill({ json: { project: workspace.saved } });
    return route.fulfill({ status: 404, json: { detail: `Unexpected test API: ${path}` } });
  });
  return workspace;
}

test('checks only after a click and displays release notes as safe text', async ({ page }) => {
  await mockWorkspace(page);
  let checkCount = 0;
  const outgoing: string[] = [];
  page.on('request', request => { if (request.url().startsWith('http') && !request.url().includes('127.0.0.1') && !request.url().includes('localhost')) outgoing.push(request.url()); });
  await page.route('**/api/updates**', async route => {
    if (route.request().url().endsWith('/check')) {
      checkCount++;
      return route.fulfill({ json: { ...available, status: 'checking' } });
    }
    return route.fulfill({ json: { ...available, releaseUrl: 'javascript:alert(1)', changelog: '<img src="https://example.com/track">\nA better editing rhythm.' } });
  });
  await page.goto('/');
  await expect(page.getByLabel('Check for updates', { exact: true })).toBeVisible();
  expect(checkCount).toBe(0);
  await page.getByLabel('Check for updates', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Keep Pulse up to date.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update now', exact: true })).toBeVisible();
  expect(checkCount).toBe(1);
  await expect(page.locator('.pulse-update-versions')).toContainText('v1.2.0');
  await expect(page.locator('.pulse-update-versions')).toContainText('v1.3.0');
  await page.getByText('What’s new', { exact: true }).click();
  await expect(page.locator('.pulse-update-notes pre')).toContainText('<img src="https://example.com/track">');
  await expect(page.locator('.pulse-update-dialog img')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View release on GitHub' })).toHaveCount(0);
  expect(outgoing).toEqual([]);
  await page.getByLabel('Close updates', { exact: true }).click();
  await expect(page.locator('.pulse-update-dialog')).toHaveCount(0);
});

test('flushes pending edits before installing and observes an uncertain response without retrying installation', async ({ page }) => {
  const workspace = await mockWorkspace(page);
  let installCount = 0;
  let installStarted = false;
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  await page.route('**/api/updates**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/check')) return route.fulfill({ json: available });
    if (path.endsWith('/install')) {
      installCount++;
      installStarted = true;
      workspace.events.push('install');
      return route.abort('connectionfailed');
    }
    if (installStarted) {
      workspace.healthVersion = '1.3.0';
      return route.fulfill({ json: { ...available, status: 'installing', progress: 1 } });
    }
    return route.fulfill({ json: available });
  });
  await page.goto('/');
  await expect(page.locator('.saved-label')).toHaveText('Saved to folder');
  await page.getByLabel('Project name', { exact: true }).fill('Saved before update');
  await page.getByLabel('Check for updates', { exact: true }).click();
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect.poll(() => navigations).toBeGreaterThanOrEqual(2);
  expect(installCount).toBe(1);
  const saveIndex = workspace.events.indexOf('save:Saved before update');
  expect(saveIndex).toBeGreaterThanOrEqual(0);
  expect(saveIndex).toBeLessThan(workspace.events.indexOf('install'));
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Saved before update');
  await expect(page.locator('.pulse-update-dialog')).toHaveCount(0);
});

test('shows an installation refusal immediately and permits a later retry', async ({ page }) => {
  await mockWorkspace(page);
  let installCount = 0;
  await page.route('**/api/updates**', async route => {
    if (route.request().url().endsWith('/install')) {
      installCount++;
      return route.fulfill({ status: 409, json: { detail: 'A film is still rendering. Wait for export to finish.' } });
    }
    return route.fulfill({ json: available });
  });
  await page.goto('/');
  await page.getByLabel('Check for updates', { exact: true }).click();
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('A film is still rendering.');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Close updates', { exact: true })).toBeEnabled();
  expect(installCount).toBe(1);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Update now', exact: true })).toBeEnabled();
});

test('keeps observing the downloaded ready stage until installation restarts the editor', async ({ page }) => {
  const workspace = await mockWorkspace(page);
  let installed = false;
  let polls = 0;
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  await page.route('**/api/updates**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/check')) return route.fulfill({ json: available });
    if (path.endsWith('/install')) {
      installed = true;
      return route.fulfill({ json: { ...available, status: 'downloading', progress: .1 } });
    }
    if (installed) {
      polls++;
      if (polls === 1) return route.fulfill({ json: { ...available, status: 'downloading', progress: .4 } });
      if (polls < 4) return route.fulfill({ json: { ...available, status: 'ready', progress: 1 } });
      workspace.healthVersion = '1.3.0';
      return route.fulfill({ json: { ...available, status: 'installing', progress: 1 } });
    }
    return route.fulfill({ json: available });
  });
  await page.goto('/');
  await page.getByLabel('Check for updates', { exact: true }).click();
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect(page.locator('.pulse-update-progress')).toContainText('40%');
  await expect(page.locator('.pulse-update-status strong')).toHaveText('Restarting Pulse');
  await expect(page.getByLabel('Close updates', { exact: true })).toBeDisabled();
  await expect.poll(() => navigations).toBeGreaterThanOrEqual(2);
  expect(polls).toBeGreaterThanOrEqual(4);
});

test('does not time out a healthy long download or verified extraction stage', async ({ page }) => {
  await mockWorkspace(page);
  let installing = false;
  let status = 'downloading';
  let polls = 0;
  await page.route('**/api/updates**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/check')) return route.fulfill({ json: available });
    if (path.endsWith('/install')) {
      installing = true;
      return route.fulfill({ json: { ...available, status, progress: .2 } });
    }
    if (installing) {
      polls++;
      return route.fulfill({ json: { ...available, status, progress: status === 'ready' ? 1 : .4 } });
    }
    return route.fulfill({ json: available });
  });
  await page.goto('/');
  await page.getByLabel('Check for updates', { exact: true }).click();
  await page.getByRole('button', { name: 'Update now', exact: true }).click();
  await expect.poll(() => polls).toBeGreaterThanOrEqual(1);
  // Date advances while normal timers keep running. The next healthy status
  // poll must refresh the deadline rather than treating elapsed download time
  // as an application restart failure.
  await page.clock.setFixedTime(Date.now() + 240_000);
  await expect.poll(() => polls).toBeGreaterThanOrEqual(3);
  await expect(page.getByLabel('Close updates', { exact: true })).toBeDisabled();
  await expect(page.locator('.pulse-update-dialog [role="alert"]')).toHaveCount(0);
  status = 'ready';
  const readyPoll = polls;
  await page.clock.setFixedTime(Date.now() + 480_000);
  await expect.poll(() => polls).toBeGreaterThanOrEqual(readyPoll + 2);
  await expect(page.getByLabel('Close updates', { exact: true })).toBeDisabled();
  await expect(page.locator('.pulse-update-dialog [role="alert"]')).toHaveCount(0);
});
