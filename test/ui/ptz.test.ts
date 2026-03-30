import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const CAM: { name: string; connected: boolean; pan: number | null; tilt: number | null; zoom: number | null; presets: number[] } = {
  name: 'Main Cam',
  connected: true,
  pan: 0,
  tilt: 0,
  zoom: 8192,
  presets: [0, 1, 2],
};

test.describe('PTZ Camera panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.locator('.tab').filter({ hasText: 'Camera' }).click();
    await expect(page.locator('section.panel.active')).toBeVisible();
  });

  const panel = (page: Page) =>
    page.locator('section.panel.active');

  test('shows "No cameras configured" when cameras array is empty', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [] } });
    await expect(panel(page).locator('.ptz-disconnected')).toHaveText('No cameras configured');
  });

  test('shows disconnected message when camera is not connected', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [{ ...CAM, connected: false }] } });
    await expect(panel(page).locator('.ptz-disconnected').filter({ hasText: 'disconnected' })).toBeVisible();
  });

  test('renders D-pad buttons for a connected camera', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [CAM] } });
    await expect(panel(page).locator('.ptz-up')).toBeVisible();
    await expect(panel(page).locator('.ptz-down')).toBeVisible();
    await expect(panel(page).locator('.ptz-left')).toBeVisible();
    await expect(panel(page).locator('.ptz-right')).toBeVisible();
    await expect(panel(page).locator('.ptz-home')).toBeVisible();
  });

  test('renders zoom and focus buttons', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [CAM] } });
    await expect(panel(page).locator('.ptz-zoom-in')).toBeVisible();
    await expect(panel(page).locator('.ptz-zoom-out')).toBeVisible();
    await expect(panel(page).locator('.ptz-btn').filter({ hasText: 'Auto' })).toBeVisible();
    await expect(panel(page).locator('.ptz-btn').filter({ hasText: 'Near' })).toBeVisible();
    await expect(panel(page).locator('.ptz-btn').filter({ hasText: 'Far' })).toBeVisible();
  });

  test('renders preset buttons from cam.presets', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [{ ...CAM, presets: [0, 1, 2] }] } });
    const presetBtns = panel(page).locator('.ptz-preset-btn');
    await expect(presetBtns).toHaveCount(3);
    // presets are labelled p+1 (1-based)
    await expect(presetBtns.nth(0)).toHaveText('1');
    await expect(presetBtns.nth(1)).toHaveText('2');
    await expect(presetBtns.nth(2)).toHaveText('3');
  });

  test('preset row is hidden when presets array is empty', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [{ ...CAM, presets: [] }] } });
    await expect(panel(page).locator('.ptz-presets')).not.toBeVisible();
  });

  test('clicking up sends pan-tilt API call with correct direction', async ({ page, setState }) => {
    let body: any = null;
    await page.route('**/api/ptz/pan-tilt', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ ptz: { cameras: [CAM] } });
    await panel(page).locator('.ptz-up').dispatchEvent('pointerdown');
    await page.waitForTimeout(100);
    await panel(page).locator('.ptz-up').dispatchEvent('pointerup');

    expect(body).not.toBeNull();
    expect(body.camera).toBe(0);
    expect(body.panDir).toBe(0);
    expect(body.tiltDir).toBe(1);
  });

  test('clicking left sends pan-tilt API call with panDir -1', async ({ page, setState }) => {
    let body: any = null;
    await page.route('**/api/ptz/pan-tilt', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ ptz: { cameras: [CAM] } });
    await panel(page).locator('.ptz-left').dispatchEvent('pointerdown');
    await page.waitForTimeout(100);
    await panel(page).locator('.ptz-left').dispatchEvent('pointerup');

    expect(body?.panDir).toBe(-1);
    expect(body?.tiltDir).toBe(0);
  });

  test('clicking home sends ptz/home API call', async ({ page, setState }) => {
    let body: any = null;
    await page.route('**/api/ptz/home', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ ptz: { cameras: [CAM] } });
    await panel(page).locator('.ptz-home').click();
    await page.waitForTimeout(100);

    expect(body?.camera).toBe(0);
  });

  test('clicking zoom-in sends ptz/zoom API call with direction "in"', async ({ page, setState }) => {
    let body: any = null;
    await page.route('**/api/ptz/zoom', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ ptz: { cameras: [CAM] } });
    await panel(page).locator('.ptz-zoom-in').dispatchEvent('pointerdown');
    await page.waitForTimeout(100);
    await panel(page).locator('.ptz-zoom-in').dispatchEvent('pointerup');

    expect(body?.direction).toBe('in');
    expect(body?.camera).toBe(0);
  });

  test('clicking zoom-out sends ptz/zoom API call with direction "out"', async ({ page, setState }) => {
    let body: any = null;
    await page.route('**/api/ptz/zoom', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ ptz: { cameras: [CAM] } });
    await panel(page).locator('.ptz-zoom-out').dispatchEvent('pointerdown');
    await page.waitForTimeout(100);
    await panel(page).locator('.ptz-zoom-out').dispatchEvent('pointerup');

    expect(body?.direction).toBe('out');
  });

  test('clicking auto focus sends ptz/focus with mode "auto"', async ({ page, setState }) => {
    let body: any = null;
    await page.route('**/api/ptz/focus', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ ptz: { cameras: [CAM] } });
    await panel(page).locator('.ptz-btn').filter({ hasText: 'Auto' }).click();
    await page.waitForTimeout(100);

    expect(body?.mode).toBe('auto');
    expect(body?.camera).toBe(0);
  });

  test('clicking a preset sends ptz/preset with action "recall"', async ({ page, setState }) => {
    let body: any = null;
    await page.route('**/api/ptz/preset', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ ptz: { cameras: [{ ...CAM, presets: [0, 1, 2] }] } });
    await panel(page).locator('.ptz-preset-btn').nth(1).click();
    await page.waitForTimeout(100);

    expect(body?.action).toBe('recall');
    expect(body?.preset).toBe(1);
    expect(body?.camera).toBe(0);
  });

  test('camera selector hidden when only one camera', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [CAM] } });
    await expect(panel(page).locator('.ptz-cam-selector')).not.toBeVisible();
  });

  test('camera selector shown when multiple cameras', async ({ page, setState }) => {
    await setState({
      ptz: {
        cameras: [
          { ...CAM, name: 'Cam A' },
          { ...CAM, name: 'Cam B' },
        ],
      },
    });
    await expect(panel(page).locator('.ptz-cam-selector')).toBeVisible();
    const btns = panel(page).locator('.ptz-cam-btn');
    await expect(btns).toHaveCount(2);
    await expect(btns.nth(0)).toHaveText('Cam A');
    await expect(btns.nth(1)).toHaveText('Cam B');
  });

  test('clicking second camera selector button shows second camera panel', async ({ page, setState }) => {
    await setState({
      ptz: {
        cameras: [
          { ...CAM, name: 'Cam A' },
          { ...CAM, name: 'Cam B' },
        ],
      },
    });

    // First camera panel is visible by default
    const panels = panel(page).locator('.ptz-panel');
    await expect(panels.nth(0)).toBeVisible();
    await expect(panels.nth(1)).not.toBeVisible();

    // Click second camera button
    await panel(page).locator('.ptz-cam-btn').nth(1).click();
    await page.waitForTimeout(50);

    await expect(panels.nth(0)).not.toBeVisible();
    await expect(panels.nth(1)).toBeVisible();
  });

  test('pan-tilt for second camera sends camera index 1', async ({ page, setState }) => {
    let body: any = null;
    await page.route('**/api/ptz/pan-tilt', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({
      ptz: {
        cameras: [
          { ...CAM, name: 'Cam A' },
          { ...CAM, name: 'Cam B' },
        ],
      },
    });

    // Switch to second camera
    await panel(page).locator('.ptz-cam-btn').nth(1).click();
    await page.waitForTimeout(50);

    // Press up on second camera panel
    await panel(page).locator('.ptz-panel').nth(1).locator('.ptz-up').dispatchEvent('pointerdown');
    await page.waitForTimeout(100);
    await panel(page).locator('.ptz-panel').nth(1).locator('.ptz-up').dispatchEvent('pointerup');

    expect(body?.camera).toBe(1);
  });

  test('header status dot is visible and connected when a camera is connected', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [CAM] } });
    const dot = page.locator('.dot[title="PTZ Camera"]');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveClass(/connected/);
  });

  test('header status dot is not visible when no cameras configured', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [] } });
    await expect(page.locator('.dot[title="PTZ Camera"]')).not.toBeVisible();
  });

  test('OBS preview image is visible when OBS is connected', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [CAM] }, obs: { connected: true } });
    await expect(panel(page).locator('#ptz-obs-preview')).toBeVisible();
  });

  test('OBS preview image is hidden when OBS is disconnected', async ({ page, setState }) => {
    await setState({ ptz: { cameras: [CAM] }, obs: { connected: false } });
    await expect(panel(page).locator('#ptz-obs-preview')).not.toBeVisible();
  });
});
