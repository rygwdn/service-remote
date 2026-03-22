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
      youtube: { connected: true, viewerCount: 123, broadcastTitle: 'Sunday Service', broadcastId: 'abc123' },
    });

    await expect(obsPanel(page).locator('.youtube-viewers')).toBeVisible();
    await expect(obsPanel(page).locator('.youtube-viewers')).toContainText('123');
  });

  test('hides viewer count when youtube viewerCount is null', async ({ page, setState }) => {
    await setState({
      obs: { streaming: true },
      youtube: { connected: true, viewerCount: null, broadcastTitle: null, broadcastId: null },
    });

    await expect(obsPanel(page).locator('.youtube-viewers')).not.toBeVisible();
  });

  test('shows broadcast title when set', async ({ page, setState }) => {
    await setState({
      youtube: { connected: true, viewerCount: 50, broadcastTitle: 'Evening Service', broadcastId: 'xyz' },
    });

    await expect(obsPanel(page).locator('.youtube-broadcast-title')).toBeVisible();
    await expect(obsPanel(page).locator('.youtube-broadcast-title')).toContainText('Evening Service');
  });

  test('hides broadcast title when null', async ({ page, setState }) => {
    await setState({
      youtube: { connected: false, viewerCount: null, broadcastTitle: null, broadcastId: null },
    });

    await expect(obsPanel(page).locator('.youtube-broadcast-title')).not.toBeVisible();
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
