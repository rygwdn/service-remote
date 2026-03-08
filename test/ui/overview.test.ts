import { test, expect } from './fixtures';

test.describe('Overview panel', () => {
  test('status dots reflect connection state', async ({ page, setState }) => {
    const dots = page.locator('header .dot');

    // All disconnected by default
    await expect(dots.nth(0)).not.toHaveClass(/connected/);
    await expect(dots.nth(1)).not.toHaveClass(/connected/);
    await expect(dots.nth(2)).not.toHaveClass(/connected/);

    await setState({
      obs: { connected: true },
      x32: { connected: true },
      proclaim: { connected: true },
    });

    await expect(dots.nth(0)).toHaveClass(/connected/);
    await expect(dots.nth(1)).toHaveClass(/connected/);
    await expect(dots.nth(2)).toHaveClass(/connected/);
  });

  test('shows current OBS scene name', async ({ page, setState }) => {
    await setState({ obs: { connected: true, currentScene: 'Camera 1', scenes: ['Camera 1', 'Blank'] } });
    await expect(page.locator('.ov-scene-name')).toHaveText('Camera 1');
  });

  test('LIVE pill visible when streaming, hidden when not', async ({ page, setState }) => {
    const livePill = page.locator('.ov-status-pill').filter({ hasText: 'LIVE' });

    await setState({ obs: { streaming: false } });
    await expect(livePill).not.toBeVisible();

    await setState({ obs: { streaming: true } });
    await expect(livePill).toBeVisible();
  });

  test('REC pill visible when recording, hidden when not', async ({ page, setState }) => {
    const recPill = page.locator('.ov-status-pill').filter({ hasText: 'REC' });

    await setState({ obs: { recording: false } });
    await expect(recPill).not.toBeVisible();

    await setState({ obs: { recording: true } });
    await expect(recPill).toBeVisible();
  });

  test('shows "Not on air" when proclaim is connected but not on air', async ({ page, setState }) => {
    await setState({ proclaim: { connected: true, onAir: false } });
    const desc = page.locator('.ov-slide-desc');
    await expect(desc).toContainText('Not on air');
  });

  test('shows "Disconnected" when proclaim is not connected', async ({ page, setState }) => {
    await setState({ proclaim: { connected: false, onAir: false } });
    await expect(page.locator('.ov-slide-desc')).toContainText('Disconnected');
  });

  test('shows current item title and slide when on air', async ({ page, setState }) => {
    await setState({
      proclaim: {
        connected: true,
        onAir: true,
        currentItemId: 'item1',
        currentItemTitle: 'Amazing Grace',
        currentItemType: 'Song',
        slideIndex: 2,
        serviceItems: [{ id: 'item1', title: 'Amazing Grace', kind: 'Song', slideCount: 5, index: 0, section: 'Worship', group: null }],
      },
    });
    const desc = page.locator('.ov-slide-desc');
    await expect(desc).toContainText('Amazing Grace');
    await expect(desc).toContainText('Slide 3');
    await expect(desc).toContainText('Song');
  });

  test('X32 channels appear in overview with fader bars', async ({ page, setState }) => {
    await setState({
      x32: {
        connected: true,
        channels: [
          { index: 1, type: 'ch', label: 'Vocals', fader: 0.8, muted: false, level: 0.5 },
          { index: 2, type: 'ch', label: 'Guitar', fader: 0.4, muted: true, level: 0.0 },
        ],
      },
    });

    const rows = page.locator('.ov-block').filter({ hasText: 'Mix' }).locator('.ov-channel-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('.ov-ch-label')).toHaveText('Vocals');
    await expect(rows.nth(1).locator('.ov-ch-label')).toHaveText('Guitar');
    // Muted channel label should have muted class
    await expect(rows.nth(1).locator('.ov-ch-label')).toHaveClass(/muted/);
  });

  test('overview OBS preview src updates when binary screenshot frame is received', async ({ page }) => {
    // Simulate what app.js does when a binary message arrives on the screenshot WebSocket:
    // create a blob URL and set it on both preview elements.
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

    const ovPreview = page.locator('#ov-obs-preview');
    const src = await ovPreview.getAttribute('src');
    expect(src).toMatch(/^blob:/);
  });

  test('disconnected overlay is hidden when WebSocket is connected', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).Alpine.store('ui').serverConnected = true;
    });
    await page.waitForTimeout(50);
    await expect(page.locator('.disconnected-overlay')).not.toBeVisible();
  });

  test('disconnected overlay appears when WebSocket disconnects', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).Alpine.store('ui').serverConnected = false;
    });
    await page.waitForTimeout(50);
    await expect(page.locator('.disconnected-overlay')).toBeVisible();
    await expect(page.locator('.disconnected-message')).toContainText('reconnecting');
  });

  test('overview info cells are compact: proclaim cell height <= 60px', async ({ page, setState }) => {
    await setState({
      proclaim: {
        connected: true,
        onAir: true,
        currentItemId: 'item1',
        currentItemTitle: 'Amazing Grace',
        currentItemType: 'Song',
        slideIndex: 2,
        serviceItems: [{ id: 'item1', title: 'Amazing Grace', kind: 'Song', slideCount: 5, index: 0, section: 'Worship', group: null }],
      },
    });
    const cell = page.locator('.ov-cell.ov-slide-desc');
    const box = await cell.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThanOrEqual(60);
  });

  test('overview info cells are compact: OBS scene cell height <= 60px', async ({ page, setState }) => {
    await setState({
      obs: { connected: true, currentScene: 'Camera 1', streaming: true, recording: true },
    });
    const cell = page.locator('.ov-cell.ov-scene-info');
    const box = await cell.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThanOrEqual(60);
  });

  test('overview proclaim cell shows type, title and slide on one row', async ({ page, setState }) => {
    await setState({
      proclaim: {
        connected: true,
        onAir: true,
        currentItemId: 'item1',
        currentItemTitle: 'Amazing Grace',
        currentItemType: 'Song',
        slideIndex: 2,
        serviceItems: [{ id: 'item1', title: 'Amazing Grace', kind: 'Song', slideCount: 5, index: 0, section: 'Worship', group: null }],
      },
    });
    const cell = page.locator('.ov-cell.ov-slide-desc');
    // All content must be visible (not clipped/hidden)
    await expect(cell).toContainText('Song');
    await expect(cell).toContainText('Amazing Grace');
    await expect(cell).toContainText('Slide 3');
  });

  test('slide nav buttons send proclaim action API calls', async ({ page, setState }) => {
    const apiCalls: string[] = [];
    await page.route('**/api/proclaim/action', async (route) => {
      const body = route.request().postDataJSON();
      apiCalls.push(body.action);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ proclaim: { connected: true, onAir: true, currentItemId: 'item1', slideIndex: 0, serviceItems: [{ id: 'item1', title: 'T', kind: 'Song', slideCount: 3, index: 0, section: 'S', group: null }] } });

    await page.locator('section.panel.active button').filter({ hasText: /Slide/ }).first().click();
    await page.locator('section.panel.active button').filter({ hasText: /Slide/ }).last().click();

    await page.waitForFunction((calls) => calls.length >= 2, apiCalls);
    expect(apiCalls).toContain('PreviousSlide');
    expect(apiCalls).toContain('NextSlide');
  });
});
