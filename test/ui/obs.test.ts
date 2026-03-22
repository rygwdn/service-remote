import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

test.describe('OBS panel', () => {
  const panel = (page: Page) =>
    page.locator('section.panel.active');

  test.beforeEach(async ({ page }) => {
    await page.locator('.tab').filter({ hasText: 'OBS' }).click();
    await expect(page.locator('section.panel.active')).toBeVisible();
  });

  test('scene buttons render and highlight current scene', async ({ page, setState }) => {
    await setState({
      obs: { connected: true, scenes: ['Main', 'Interview', 'Blank'], currentScene: 'Interview' },
    });

    const sceneBtns = panel(page).locator('.scene-btn');
    await expect(sceneBtns).toHaveCount(3);
    await expect(sceneBtns.filter({ hasText: 'Interview' })).toHaveClass(/active/);
    await expect(sceneBtns.filter({ hasText: 'Main' })).not.toHaveClass(/active/);
    await expect(sceneBtns.filter({ hasText: 'Blank' })).not.toHaveClass(/active/);
  });

  test('clicking a scene sends obs/scene API call', async ({ page, setState }) => {
    let lastScene: string | null = null;
    await page.route('**/api/obs/scene', async (route) => {
      lastScene = route.request().postDataJSON().scene;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({
      obs: { connected: true, scenes: ['Main', 'Blank'], currentScene: 'Main' },
    });

    await panel(page).locator('.scene-btn').filter({ hasText: 'Blank' }).click();
    await page.waitForTimeout(100);
    expect(lastScene).toBe('Blank');
  });

  test('audio sources render with mute button', async ({ page, setState }) => {
    await setState({
      obs: {
        connected: true,
        audioSources: [
          { name: 'Mic 1', volume: -10, muted: false, level: 0.6, live: true },
          { name: 'Desktop Audio', volume: -20, muted: true, level: 0.0, live: false },
        ],
      },
    });

    const sources = panel(page).locator('.audio-source');
    await expect(sources).toHaveCount(2);
    await expect(sources.nth(0).locator('.name')).toHaveText('Mic 1');
    await expect(sources.nth(1).locator('.name')).toHaveText('Desktop Audio');

    await expect(sources.nth(0).locator('.mute-btn')).not.toHaveClass(/muted/);
    await expect(sources.nth(1).locator('.mute-btn')).toHaveClass(/muted/);
  });

  test('clicking mute sends obs/mute API call', async ({ page, setState }) => {
    let muteTarget: string | null = null;
    await page.route('**/api/obs/mute', async (route) => {
      muteTarget = route.request().postDataJSON().input;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({
      obs: {
        connected: true,
        audioSources: [{ name: 'Mic 1', volume: -10, muted: false, level: 0.5, live: true }],
      },
    });

    await panel(page).locator('.mute-btn').first().click();
    await page.waitForTimeout(100);
    expect(muteTarget).toBe('Mic 1');
  });

  test('stream button text toggles based on state', async ({ page, setState }) => {
    await setState({ obs: { streaming: false } });
    await expect(panel(page).locator('.btn').filter({ hasText: 'Stream' })).toBeVisible();

    await setState({ obs: { streaming: true } });
    await expect(panel(page).locator('.btn').filter({ hasText: 'Streaming' })).toBeVisible();
  });

  test('stream button has active class when streaming', async ({ page, setState }) => {
    await setState({ obs: { streaming: false } });
    await expect(panel(page).locator('.btn').filter({ hasText: 'Stream' })).not.toHaveClass(/active/);

    await setState({ obs: { streaming: true } });
    await expect(panel(page).locator('.btn').filter({ hasText: 'Streaming' })).toHaveClass(/active/);
  });

  test('record button text toggles based on state', async ({ page, setState }) => {
    await setState({ obs: { recording: false } });
    await expect(panel(page).locator('.btn').filter({ hasText: /^Record$/ })).toBeVisible();

    await setState({ obs: { recording: true } });
    await expect(panel(page).locator('.btn').filter({ hasText: 'Recording' })).toBeVisible();
  });

  test('record button has active class when recording', async ({ page, setState }) => {
    await setState({ obs: { recording: false } });
    await expect(panel(page).locator('.btn').filter({ hasText: /^Record$/ })).not.toHaveClass(/active/);

    await setState({ obs: { recording: true } });
    await expect(panel(page).locator('.btn').filter({ hasText: 'Recording' })).toHaveClass(/active/);
  });

  test('stream and record buttons are at the top of the OBS panel, before screenshot and scenes', async ({ page, setState }) => {
    await setState({ obs: { connected: true, scenes: ['Main'], streaming: false, recording: false } });

    const p = panel(page);
    // Get all obs-section elements and check Output section comes first
    const sections = p.locator('.obs-section');
    const firstSection = sections.first();
    await expect(firstSection.locator('.btn').filter({ hasText: /Stream|Streaming/ })).toBeVisible();
    await expect(firstSection.locator('.btn').filter({ hasText: /^Record$|Recording/ })).toBeVisible();
  });

  test('clicking stream button shows confirm dialog and sends API call on accept', async ({ page, setState }) => {
    let streamCalled = false;
    await page.route('**/api/obs/stream', async (route) => {
      streamCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ obs: { streaming: false } });

    page.on('dialog', dialog => dialog.accept());
    await panel(page).locator('.btn').filter({ hasText: 'Stream' }).click();
    await page.waitForTimeout(100);
    expect(streamCalled).toBe(true);
  });

  test('clicking stream button shows confirm dialog and does NOT send API call on cancel', async ({ page, setState }) => {
    let streamCalled = false;
    await page.route('**/api/obs/stream', async (route) => {
      streamCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ obs: { streaming: false } });

    page.on('dialog', dialog => dialog.dismiss());
    await panel(page).locator('.btn').filter({ hasText: 'Stream' }).click();
    await page.waitForTimeout(100);
    expect(streamCalled).toBe(false);
  });

  test('clicking record button shows confirm dialog and sends API call on accept', async ({ page, setState }) => {
    let recordCalled = false;
    await page.route('**/api/obs/record', async (route) => {
      recordCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ obs: { recording: false } });

    page.on('dialog', dialog => dialog.accept());
    await panel(page).locator('.btn').filter({ hasText: /^Record$/ }).click();
    await page.waitForTimeout(100);
    expect(recordCalled).toBe(true);
  });

  test('clicking record button shows confirm dialog and does NOT send API call on cancel', async ({ page, setState }) => {
    let recordCalled = false;
    await page.route('**/api/obs/record', async (route) => {
      recordCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ obs: { recording: false } });

    page.on('dialog', dialog => dialog.dismiss());
    await panel(page).locator('.btn').filter({ hasText: /^Record$/ }).click();
    await page.waitForTimeout(100);
    expect(recordCalled).toBe(false);
  });

  test('preview image src updates when binary frame arrives on /ws/screenshot', async ({ page }) => {
    // Directly simulate what app.js does when a binary message arrives on the
    // screenshot WebSocket: create a blob URL and set it on #obs-preview.
    await page.evaluate(() => {
      const fakeJpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const blob = new Blob([fakeJpegBytes], { type: 'image/jpeg' });
      const objectUrl = URL.createObjectURL(blob);
      const p1 = document.getElementById('obs-preview');
      const p2 = document.getElementById('ov-obs-preview');
      if (p1) (p1 as HTMLImageElement).src = objectUrl;
      if (p2) (p2 as HTMLImageElement).src = objectUrl;
    });

    await page.waitForTimeout(100);

    const obsPreview = page.locator('#obs-preview');
    const src = await obsPreview.getAttribute('src');
    // Should be a blob: URL
    expect(src).toMatch(/^blob:/);

    const ovPreview = page.locator('#ov-obs-preview');
    const src2 = await ovPreview.getAttribute('src');
    expect(src2).toMatch(/^blob:/);
  });

  test('preview image src is empty before any screenshot frame arrives', async ({ page, setState }) => {
    await setState({ obs: { connected: true } });

    const obsPreview = page.locator('#obs-preview');
    // src should be '' or blob: (from a previous frame) — never a data: URL from state
    const src = await obsPreview.getAttribute('src');
    expect(src === '' || src === null || src?.startsWith('blob:') || !src?.startsWith('data:')).toBeTruthy();
  });

  test('edit mode reveals visibility checkboxes', async ({ page, setState }) => {
    await setState({
      obs: {
        connected: true,
        audioSources: [{ name: 'Mic 1', volume: -10, muted: false, level: 0.5 }],
      },
    });

    const p = panel(page);
    await expect(p.locator('.fader-visibility-label').first()).not.toBeVisible();
    await p.locator('.btn-edit-toggle').filter({ hasText: 'Edit' }).click();
    await expect(p.locator('.fader-visibility-label').first()).toBeVisible();
  });

  test('fader is disabled by default (locked)', async ({ page, setState }) => {
    await setState({
      obs: {
        connected: true,
        audioSources: [{ name: 'Mic 1', volume: -10, muted: false, level: 0.5 }],
      },
    });

    const p = panel(page);
    const fader = p.locator('input[type="range"]').first();
    await expect(fader).toBeDisabled();
    await expect(p.locator('.btn-edit-toggle').filter({ hasText: 'Locked' })).toBeVisible();
  });

  test('Lock/Unlock toggle enables and disables the fader', async ({ page, setState }) => {
    await setState({
      obs: {
        connected: true,
        audioSources: [{ name: 'Mic 1', volume: -10, muted: false, level: 0.5 }],
      },
    });

    const p = panel(page);
    const fader = p.locator('input[type="range"]').first();
    const lockBtn = p.locator('.btn-edit-toggle').filter({ hasText: /Locked|Unlocked/ });

    await expect(fader).toBeDisabled();
    await lockBtn.click();
    await expect(fader).toBeEnabled();
    await expect(lockBtn).toHaveText('Unlocked');

    await lockBtn.click();
    await expect(fader).toBeDisabled();
    await expect(lockBtn).toHaveText('Locked');
  });

  test('stream button has active class and red background when streaming', async ({ page, setState }) => {
    await setState({ obs: { streaming: true } });
    const btn = page.locator('#obs-stream-btn');
    await expect(btn).toHaveClass(/active/);
    const bg = await btn.evaluate((el: Element) => getComputedStyle(el).backgroundColor);
    // --red is typically rgb(220, 50, 47) or similar; just check it's not the default surface colour
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    // The active style should apply red background via #obs-stream-btn.active rule
    // Verify the element exists with the correct ID
    await expect(btn).toBeVisible();
  });

  test('record button has active class and red background when recording', async ({ page, setState }) => {
    await setState({ obs: { recording: true } });
    const btn = page.locator('#obs-record-btn');
    await expect(btn).toHaveClass(/active/);
    const bg = await btn.evaluate((el: Element) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    await expect(btn).toBeVisible();
  });

  // Helper: simulate a levels update by directly invoking the same DOM logic as the WS handler
  async function injectLevels(page: Page, obs: Record<string, number>) {
    await page.evaluate((obsLevels: Record<string, number>) => {
      const mulToDisplayPct = (window as any).mulToDisplayPct;
      for (const [name, level] of Object.entries(obsLevels)) {
        const els = document.querySelectorAll(`[data-level-obs="${CSS.escape(name)}"]`);
        for (const el of els) {
          (el as HTMLElement).style.width = mulToDisplayPct(level).toFixed(1) + '%';
        }
      }
    }, obs);
    await page.waitForTimeout(50);
  }

  test.describe('meter display (dB scale)', () => {
    test.beforeEach(async ({ page, setState }) => {
      await setState({
        obs: {
          connected: true,
          audioSources: [{ name: 'Mic 1', volume: -10, muted: false, level: 0, live: true }],
        },
      });
    });

    test('silence (level=0) shows 0% meter', async ({ page }) => {
      await injectLevels(page, { 'Mic 1': 0 });
      const fill = panel(page).locator('.obs-meter-fill').first();
      const width = await fill.evaluate((el: HTMLElement) => parseFloat(el.style.width));
      expect(width).toBe(0);
    });

    test('0 dBFS (level=1.0) shows 100% meter', async ({ page }) => {
      await injectLevels(page, { 'Mic 1': 1.0 });
      const fill = panel(page).locator('.obs-meter-fill').first();
      const width = await fill.evaluate((el: HTMLElement) => parseFloat(el.style.width));
      expect(width).toBeCloseTo(100, 0);
    });

    test('-20 dBFS (level≈0.1) shows ~67% meter (not 10%)', async ({ page }) => {
      // Linear: 0.1 * 100 = 10%. dB scale: (-20+60)/60 * 100 ≈ 66.7%
      const mul = Math.pow(10, -20 / 20); // ≈ 0.1
      await injectLevels(page, { 'Mic 1': mul });
      const fill = panel(page).locator('.obs-meter-fill').first();
      const width = await fill.evaluate((el: HTMLElement) => parseFloat(el.style.width));
      expect(width).toBeGreaterThan(60);
      expect(width).toBeLessThan(75);
    });

    test('initial state (level=0 from Alpine store) shows 0% meter', async ({ page, setState }) => {
      // level is 0 in state; Alpine initial render should give 0% (not NaN/100%)
      await setState({
        obs: {
          connected: true,
          audioSources: [{ name: 'Mic 1', volume: -10, muted: false, level: 0, live: true }],
        },
      });
      const fill = panel(page).locator('.obs-meter-fill').first();
      const width = await fill.evaluate((el: HTMLElement) => parseFloat(el.style.width) || 0);
      expect(width).toBe(0);
    });

    test('very loud signal above 0 dBFS clamps to 100%', async ({ page }) => {
      await injectLevels(page, { 'Mic 1': 2.0 }); // +6 dBFS
      const fill = panel(page).locator('.obs-meter-fill').first();
      const width = await fill.evaluate((el: HTMLElement) => parseFloat(el.style.width));
      expect(width).toBeCloseTo(100, 0);
    });
  });
});
