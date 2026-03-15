import { test, expect } from './fixtures';

const MOBILE_VIEWPORT = { width: 375, height: 667 };
const TABLET_VIEWPORT = { width: 900, height: 600 };
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Mobile layout (<768px)', () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test('On Air button is hidden in overview', async ({ page }) => {
    await expect(page.locator('.ov-on-air')).not.toBeVisible();
  });

  test('OBS scenes block is hidden in overview', async ({ page }) => {
    await expect(page.locator('.ov-scenes-block')).not.toBeVisible();
  });

  test('Service sidebar is hidden in overview', async ({ page }) => {
    await expect(page.locator('.ov-service-col')).not.toBeVisible();
  });

  test('tabs are displayed horizontally', async ({ page }) => {
    const tabs = page.locator('.tab');
    const first = await tabs.first().boundingBox();
    const last = await tabs.last().boundingBox();
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();
    // Horizontal: all tabs on the same Y coordinate
    expect(Math.abs(first!.y - last!.y)).toBeLessThanOrEqual(4);
  });
});

test.describe('Tablet layout (768px–1023px)', () => {
  test.use({ viewport: TABLET_VIEWPORT });

  test('On Air button is visible in overview', async ({ page }) => {
    await expect(page.locator('.ov-on-air')).toBeVisible();
  });

  test('OBS scenes block is visible in overview', async ({ page, setState }) => {
    await setState({ obs: { scenes: ['Camera 1', 'Blank', 'Titles'] } });
    await expect(page.locator('.ov-scenes-block')).toBeVisible();
    await expect(page.locator('.ov-scenes-block .scene-btn')).toHaveCount(3);
  });

  test('Service sidebar is hidden in overview on tablet', async ({ page }) => {
    await expect(page.locator('.ov-service-col')).not.toBeVisible();
  });

  test('tabs are displayed horizontally on tablet', async ({ page }) => {
    const tabs = page.locator('.tab');
    const first = await tabs.first().boundingBox();
    const last = await tabs.last().boundingBox();
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();
    expect(Math.abs(first!.y - last!.y)).toBeLessThanOrEqual(4);
  });

  test('On Air button in overview triggers confirm and sends action', async ({ page, setState }) => {
    await setState({ proclaim: { connected: true, onAir: false } });
    let lastCall: { action: string } | null = null;
    await page.route('**/api/proclaim/action', async (route) => {
      lastCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.ov-on-air').click();
    await page.waitForTimeout(100);
    expect(lastCall).not.toBeNull();
    expect((lastCall as any).action).toBe('GoOnAir');
  });

  test('OBS scene button in overview changes scene', async ({ page, setState }) => {
    await setState({ obs: { scenes: ['Camera 1', 'Blank'], currentScene: 'Camera 1' } });
    let lastCall: { scene: string } | null = null;
    await page.route('**/api/obs/scene', async (route) => {
      lastCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.locator('.ov-scenes-block .scene-btn').filter({ hasText: 'Blank' }).click();
    await page.waitForTimeout(100);
    expect(lastCall).not.toBeNull();
    expect((lastCall as any).scene).toBe('Blank');
  });
});

test.describe('Desktop layout (1024px+)', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('tabs are displayed vertically (sidebar)', async ({ page }) => {
    const tabs = page.locator('.tab');
    const first = await tabs.first().boundingBox();
    const second = await tabs.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Vertical: second tab is below first tab
    expect(second!.y).toBeGreaterThan(first!.y);
    // And they share the same X position (left-aligned)
    expect(Math.abs(first!.x - second!.x)).toBeLessThanOrEqual(4);
  });

  test('Service sidebar is visible in overview on desktop', async ({ page, setState }) => {
    await setState({
      proclaim: {
        connected: true,
        serviceItems: [
          { id: 'item1', title: 'Welcome', kind: 'Song', slideCount: 3, index: 0, section: 'Worship', group: null },
          { id: 'item2', title: 'Sermon', kind: 'Liturgy', slideCount: 1, index: 1, section: 'Main', group: null },
        ],
      },
    });
    await expect(page.locator('.ov-service-col')).toBeVisible();
    const items = page.locator('.ov-service-col .item-btn').filter({ visible: true });
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Welcome');
    await expect(items.nth(1)).toContainText('Sermon');
  });

  test('On Air button is visible in overview on desktop', async ({ page }) => {
    await expect(page.locator('.ov-on-air')).toBeVisible();
  });

  test('OBS scenes block is visible in overview on desktop', async ({ page, setState }) => {
    await setState({ obs: { scenes: ['Camera 1', 'Blank', 'Titles', 'Lyrics'] } });
    await expect(page.locator('.ov-scenes-block')).toBeVisible();
    await expect(page.locator('.ov-scenes-block .scene-btn')).toHaveCount(4);
  });

  test('service sidebar item click navigates to that item', async ({ page, setState }) => {
    await setState({
      proclaim: {
        connected: true,
        serviceItems: [
          { id: 'item1', title: 'Amazing Grace', kind: 'Song', slideCount: 3, index: 0, section: 'Worship', group: null },
        ],
      },
    });
    let lastCall: { itemId: string } | null = null;
    await page.route('**/api/proclaim/goto-item', async (route) => {
      lastCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.locator('.ov-service-col .item-btn').filter({ hasText: 'Amazing Grace' }).click();
    await page.waitForTimeout(100);
    expect(lastCall).not.toBeNull();
    expect((lastCall as any).itemId).toBe('item1');
  });

  test('active service item in sidebar is highlighted', async ({ page, setState }) => {
    await setState({
      proclaim: {
        connected: true,
        onAir: true,
        currentItemId: 'item1',
        currentItemTitle: 'Amazing Grace',
        currentItemType: 'Song',
        slideIndex: 0,
        serviceItems: [
          { id: 'item1', title: 'Amazing Grace', kind: 'Song', slideCount: 3, index: 0, section: 'Worship', group: null },
          { id: 'item2', title: 'Sermon', kind: 'Liturgy', slideCount: 1, index: 1, section: 'Main', group: null },
        ],
      },
    });
    const activeItem = page.locator('.ov-service-col .item-btn.active');
    await expect(activeItem).toHaveCount(1);
    await expect(activeItem).toContainText('Amazing Grace');
  });
});
