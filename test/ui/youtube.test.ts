import { test, expect } from './fixtures';

test.describe('YouTube section in OBS panel', () => {
  const obsPanel = (page: Parameters<typeof test>[1]['page']) =>
    page.locator('section.panel.active');

  test.beforeEach(async ({ page }) => {
    await page.locator('.tab').filter({ hasText: 'OBS' }).click();
    await expect(page.locator('section.panel.active')).toBeVisible();
  });

  test('shows viewer count when youtube state has viewerCount', async ({ page, setState }) => {
    await setState({
      obs: { streaming: true },
      youtube: { connected: true, viewerCount: 123, broadcastTitle: 'Sunday Service', broadcastId: 'abc123', broadcastStatus: 'live' },
    });

    await expect(obsPanel(page).locator('.youtube-viewers')).toBeVisible();
    await expect(obsPanel(page).locator('.youtube-viewers')).toContainText('123');
  });

  test('hides viewer count when youtube viewerCount is null', async ({ page, setState }) => {
    await setState({
      obs: { streaming: true },
      youtube: { connected: true, viewerCount: null, broadcastTitle: null, broadcastId: null, broadcastStatus: null },
    });

    await expect(obsPanel(page).locator('.youtube-viewers')).not.toBeVisible();
  });

  test('shows broadcast title when set', async ({ page, setState }) => {
    await setState({
      youtube: { connected: true, viewerCount: 50, broadcastTitle: 'Evening Service', broadcastId: 'xyz', broadcastStatus: 'live' },
    });

    await expect(obsPanel(page).locator('.youtube-broadcast-title')).toBeVisible();
    await expect(obsPanel(page).locator('.youtube-broadcast-title')).toContainText('Evening Service');
  });

  test('hides broadcast title when null', async ({ page, setState }) => {
    await setState({
      youtube: { connected: false, viewerCount: null, broadcastTitle: null, broadcastId: null, broadcastStatus: null },
    });

    await expect(obsPanel(page).locator('.youtube-broadcast-title')).not.toBeVisible();
  });

  test('shows Go Live button when broadcast is not live', async ({ page, setState }) => {
    await setState({ youtube: { connected: false, viewerCount: null, broadcastTitle: null, broadcastId: 'bcast1', broadcastStatus: null } });
    await expect(obsPanel(page).locator('.youtube-go-live-btn')).toBeVisible();
    await expect(obsPanel(page).locator('.youtube-end-stream-btn')).not.toBeVisible();
  });

  test('shows End Stream button and hides Go Live when broadcast is live', async ({ page, setState }) => {
    await setState({ youtube: { connected: true, viewerCount: 10, broadcastTitle: 'Service', broadcastId: 'bcast1', broadcastStatus: 'live' } });
    await expect(obsPanel(page).locator('.youtube-end-stream-btn')).toBeVisible();
    await expect(obsPanel(page).locator('.youtube-go-live-btn')).not.toBeVisible();
  });

  test('Go Live button sends /api/youtube/start on confirm', async ({ page, setState }) => {
    let called = false;
    await page.route('**/api/youtube/start', async (route) => {
      called = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ youtube: { connected: false, viewerCount: null, broadcastTitle: null, broadcastId: 'bcast1', broadcastStatus: null } });
    page.on('dialog', (d) => d.accept());
    await obsPanel(page).locator('.youtube-go-live-btn').click();
    await page.waitForTimeout(100);
    expect(called).toBe(true);
  });

  test('End Stream button sends /api/youtube/stop on confirm', async ({ page, setState }) => {
    let called = false;
    await page.route('**/api/youtube/stop', async (route) => {
      called = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ youtube: { connected: true, viewerCount: 5, broadcastTitle: 'Service', broadcastId: 'bcast1', broadcastStatus: 'live' } });
    page.on('dialog', (d) => d.accept());
    await obsPanel(page).locator('.youtube-end-stream-btn').click();
    await page.waitForTimeout(100);
    expect(called).toBe(true);
  });
});

test.describe('YouTube settings section', () => {
  test.beforeEach(async ({ page }) => {
    await page.locator('.tab').filter({ hasText: 'Settings' }).click();
    await expect(page.locator('section.panel.active')).toBeVisible();
  });

  test('YouTube settings section exists with API key and Broadcast ID fields', async ({ page }) => {
    const ytSection = page.locator('.settings-section').filter({ hasText: 'YouTube' });
    await expect(ytSection).toBeVisible();
    await expect(ytSection.locator('label').filter({ hasText: 'API Key' })).toBeVisible();
    await expect(ytSection.locator('label').filter({ hasText: 'Broadcast ID' })).toBeVisible();
  });
});
