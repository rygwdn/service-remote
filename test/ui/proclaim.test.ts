import { test, expect } from './fixtures';

const serviceItems = [
  { id: 'item1', title: 'Welcome', kind: 'Slide', slideCount: 1, index: 1, sectionIndex: 1, sectionCommand: 'StartPreService', section: 'Opening', group: null },
  { id: 'item2', title: 'Amazing Grace', kind: 'Song', slideCount: 4, index: 2, sectionIndex: 1, sectionCommand: 'StartService', section: 'Worship', group: null },
  { id: 'item3', title: 'Sermon', kind: 'Slide', slideCount: 8, index: 3, sectionIndex: 2, sectionCommand: 'StartService', section: 'Message', group: null },
];

test.describe('Proclaim panel', () => {
  const panel = (page: Parameters<typeof test>[1]['page']) =>
    page.locator('section.panel.active');

  // Set state first so x-for renders correctly when the panel becomes visible
  async function goToProclaim(page: Parameters<typeof test>[1]['page'], setState: (s: any) => Promise<void>, state?: any) {
    if (state) await setState(state);
    await page.locator('.tab').filter({ hasText: 'Proclaim' }).click();
    await expect(page.locator('section.panel.active')).toBeVisible();
  }

  test('shows "Not on air" when disconnected', async ({ page, setState }) => {
    await goToProclaim(page, setState, { proclaim: { connected: false, onAir: false } });
    await expect(panel(page).locator('.proclaim-now-playing')).toContainText('Disconnected');
  });

  test('shows "Not on air" when connected but not on air', async ({ page, setState }) => {
    await goToProclaim(page, setState, { proclaim: { connected: true, onAir: false } });
    await expect(panel(page).locator('.proclaim-now-playing')).toContainText('Not on air');
  });

  test('shows current item title and slide when on air', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', currentItemTitle: 'Amazing Grace', currentItemType: 'Song', slideIndex: 2, serviceItems },
    });
    const nowPlaying = panel(page).locator('.proclaim-now-playing');
    await expect(nowPlaying).toContainText('Amazing Grace');
    await expect(nowPlaying).toContainText('Slide 3');
    await expect(nowPlaying).toContainText('Song');
  });

  test('shows service items list when on air', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', slideIndex: 0, serviceItems },
    });

    const items = panel(page).locator('.item-btn:visible');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('Welcome');
    await expect(items.nth(1)).toContainText('Amazing Grace');
    await expect(items.nth(2)).toContainText('Sermon');
  });

  test('active item is highlighted', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', slideIndex: 1, serviceItems },
    });

    const items = panel(page).locator('.item-btn:visible');
    await expect(items.nth(1)).toHaveClass(/active/);
    await expect(items.nth(0)).not.toHaveClass(/active/);
    await expect(items.nth(2)).not.toHaveClass(/active/);
  });

  test('shows section headers', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', slideIndex: 0, serviceItems },
    });

    const sections = panel(page).locator('.item-section-header:visible');
    await expect(sections).toHaveCount(3);
    await expect(sections.nth(0)).toHaveText('Opening');
    await expect(sections.nth(1)).toHaveText('Worship');
    await expect(sections.nth(2)).toHaveText('Message');
  });

  test('shows slide count for multi-slide items', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', slideIndex: 0, serviceItems },
    });

    const items = panel(page).locator('.item-btn:visible');
    await expect(items.nth(1)).toContainText('4 slides');
    await expect(items.nth(0)).not.toContainText('slides');
  });

  test('clicking an item calls goto-item with the item id', async ({ page, setState }) => {
    let lastCall: { itemId: string } | null = null;
    await page.route('**/api/proclaim/goto-item', async (route) => {
      lastCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', slideIndex: 0, serviceItems },
    });

    await panel(page).locator('.item-btn:visible').nth(2).click();
    await page.waitForTimeout(100);

    expect(lastCall).not.toBeNull();
    expect(lastCall!.itemId).toBe('item3');
  });

  test('slide nav buttons send correct actions', async ({ page, setState }) => {
    const calls: string[] = [];
    await page.route('**/api/proclaim/action', async (route) => {
      calls.push(route.request().postDataJSON().action);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', slideIndex: 1, serviceItems },
    });

    const p = panel(page);
    await p.locator('.proclaim-controls button').filter({ hasText: 'Prev Slide' }).click();
    await p.locator('.proclaim-controls button').filter({ hasText: 'Next Slide' }).click();

    await page.waitForTimeout(200);
    expect(calls).toEqual(['PreviousSlide', 'NextSlide']);
  });

  test('Prev Item and Next Item buttons are not present', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', slideIndex: 1, serviceItems },
    });

    const p = panel(page);
    await expect(p.locator('.proclaim-controls button').filter({ hasText: 'Prev Item' })).toHaveCount(0);
    await expect(p.locator('.proclaim-controls button').filter({ hasText: 'Next Item' })).toHaveCount(0);
  });

  test('shows no items when not on air', async ({ page, setState }) => {
    await goToProclaim(page, setState, { proclaim: { connected: true, onAir: false } });
    await expect(panel(page).locator('.item-btn:visible')).toHaveCount(0);
  });

  test('OnAir button shows "Go On Air" when off air and sends GoOnAir', async ({ page, setState }) => {
    const calls: string[] = [];
    await page.route('**/api/proclaim/action', async (route) => {
      calls.push(route.request().postDataJSON().action);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await goToProclaim(page, setState, { proclaim: { connected: true, onAir: false } });

    const btn = panel(page).locator('.btn-on-air');
    await expect(btn).toHaveText('Go On Air');
    await expect(btn).not.toHaveClass(/active/);

    await btn.click();
    await page.waitForTimeout(100);
    expect(calls).toContain('GoOnAir');
  });

  test('OnAir button shows "On Air" when on air and sends GoOffAir', async ({ page, setState }) => {
    const calls: string[] = [];
    await page.route('**/api/proclaim/action', async (route) => {
      calls.push(route.request().postDataJSON().action);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', slideIndex: 0, serviceItems },
    });

    const btn = panel(page).locator('.btn-on-air');
    await expect(btn).toHaveText('On Air');
    await expect(btn).toHaveClass(/active/);

    await btn.click();
    await page.waitForTimeout(100);
    expect(calls).toContain('GoOffAir');
  });

  test('renders without Alpine error when items have section and group entries', async ({ page, setState }) => {
    const itemsWithGroups = [
      { id: 'g1', title: 'Opening Song', kind: 'Song', slideCount: 3, index: 1, sectionIndex: 1, sectionCommand: 'StartService', section: 'Service', group: 'Worship Set' },
      { id: 'g2', title: 'Second Song', kind: 'Song', slideCount: 2, index: 2, sectionIndex: 2, sectionCommand: 'StartService', section: 'Service', group: 'Worship Set' },
      { id: 'g3', title: 'Sermon', kind: 'Slide', slideCount: 5, index: 3, sectionIndex: 3, sectionCommand: 'StartService', section: 'Service', group: null },
    ];

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'g1', slideIndex: 0, serviceItems: itemsWithGroups },
    });

    const items = panel(page).locator('.item-btn:visible');
    await expect(items).toHaveCount(3);

    // The group header should render
    const groupHeader = panel(page).locator('.item-group-header:visible');
    await expect(groupHeader).toHaveCount(1);
    await expect(groupHeader).toHaveText('Worship Set');

    // Grouped items should have the item-grouped class
    await expect(items.nth(0)).toHaveClass(/item-grouped/);
    await expect(items.nth(1)).toHaveClass(/item-grouped/);
    await expect(items.nth(2)).not.toHaveClass(/item-grouped/);

    // No Alpine expression errors
    const alpineErrors = errors.filter((e) => e.includes('Alpine Expression Error'));
    expect(alpineErrors).toHaveLength(0);
  });

  test('video controls are hidden when current item is not a Video', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', currentItemType: 'Song', slideIndex: 0, serviceItems },
    });
    await expect(panel(page).locator('.proclaim-av-controls').filter({ hasText: '⏸' })).toBeHidden();
  });

  test('video controls are visible when current item is a Video', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', currentItemType: 'Video', slideIndex: 0, serviceItems },
    });
    await expect(panel(page).locator('.proclaim-av-controls').filter({ hasText: '⏸' })).toBeVisible();
  });

  // --- Slide thumbnail grid tests ---

  test('slide grid is not shown when current item has slideCount <= 1', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', slideIndex: 0, serviceItems },
    });
    // item1 has slideCount: 1, so no grid
    await expect(panel(page).locator('.slide-grid')).toBeHidden();
  });

  test('slide grid is not shown when there is no current item', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: false },
    });
    await expect(panel(page).locator('.slide-grid')).toBeHidden();
  });

  test('slide grid is shown when current item has slideCount > 1', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', slideIndex: 0, serviceItems },
    });
    // item2 has slideCount: 4
    await expect(panel(page).locator('.slide-grid')).toBeVisible();
  });

  test('slide grid shows correct number of thumbnails for current item', async ({ page, setState }) => {
    await page.route('**/api/proclaim/thumb**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.alloc(0) })
    );
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', slideIndex: 0, serviceItems },
    });
    // item2 has slideCount: 4
    await expect(panel(page).locator('.slide-grid .slide-thumb-btn')).toHaveCount(4);
  });

  test('each thumbnail uses correct itemId and slideIndex in URL', async ({ page, setState }) => {
    const requestedUrls: string[] = [];
    await page.route('**/api/proclaim/thumb**', (route) => {
      requestedUrls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.alloc(0) });
    });

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item3', slideIndex: 0, serviceItems },
    });
    // item3 has slideCount: 8
    const thumbs = panel(page).locator('.slide-grid .slide-thumb-btn img');
    await expect(thumbs).toHaveCount(8);

    // Check that all slide indices 0-7 are present in image src attributes
    for (let i = 0; i < 8; i++) {
      const src = await thumbs.nth(i).getAttribute('src');
      expect(src).toContain('itemId=item3');
      expect(src).toContain(`slideIndex=${i}`);
    }
  });

  test('clicking a thumbnail sends GoToSlide action with correct index', async ({ page, setState }) => {
    let lastCall: { action: string; index?: number } | null = null;
    await page.route('**/api/proclaim/action', async (route) => {
      lastCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/proclaim/thumb**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.alloc(0) })
    );

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', slideIndex: 0, serviceItems },
    });

    // Click the 3rd thumbnail (index 2)
    await panel(page).locator('.slide-grid .slide-thumb-btn').nth(2).click();
    await page.waitForTimeout(100);

    expect(lastCall).not.toBeNull();
    expect(lastCall!.action).toBe('GoToSlide');
    expect(lastCall!.index).toBe(2);
  });

  test('active slide thumbnail is highlighted', async ({ page, setState }) => {
    await page.route('**/api/proclaim/thumb**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.alloc(0) })
    );

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', slideIndex: 1, serviceItems },
    });

    // slideIndex 1 should be active
    const thumbBtns = panel(page).locator('.slide-grid .slide-thumb-btn');
    await expect(thumbBtns.nth(1)).toHaveClass(/active/);
    await expect(thumbBtns.nth(0)).not.toHaveClass(/active/);
    await expect(thumbBtns.nth(2)).not.toHaveClass(/active/);
  });

  test('slide grid appears above service item list', async ({ page, setState }) => {
    await page.route('**/api/proclaim/thumb**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.alloc(0) })
    );

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', slideIndex: 0, serviceItems },
    });

    const grid = panel(page).locator('.slide-grid');
    const itemList = panel(page).locator('.proclaim-items');
    const gridBox = await grid.boundingBox();
    const listBox = await itemList.boundingBox();
    expect(gridBox).not.toBeNull();
    expect(listBox).not.toBeNull();
    expect(gridBox!.y + gridBox!.height).toBeLessThanOrEqual(listBox!.y);
  });

  test('AV transport buttons send correct actions', async ({ page, setState }) => {
    const calls: string[] = [];
    await page.route('**/api/proclaim/action', async (route) => {
      calls.push(route.request().postDataJSON().action);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', currentItemType: 'Video', slideIndex: 0, serviceItems },
    });

    const p = panel(page);
    await p.locator('.proclaim-av-controls button').filter({ hasText: '⏸' }).first().click();
    await p.locator('.proclaim-av-controls button').filter({ hasText: '▶' }).first().click();
    await p.locator('.proclaim-av-controls button').filter({ hasText: '⏪' }).first().click();
    await p.locator('.proclaim-av-controls button').filter({ hasText: '⏩' }).first().click();
    await p.locator('.proclaim-av-controls button').filter({ hasText: '⏮' }).first().click();

    await page.waitForTimeout(200);
    expect(calls).toContain('VideoPause');
    expect(calls).toContain('VideoPlay');
    expect(calls).toContain('VideoRewind');
    expect(calls).toContain('VideoFastForward');
    expect(calls).toContain('VideoRestart');
    expect(calls).not.toContain('PreviousAudioItem');
  });

  test('audio controls row has no PreviousAudioItem button', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', currentItemType: 'Song', slideIndex: 0, serviceItems },
    });
    await expect(panel(page).locator('.proclaim-av-controls button').filter({ hasText: /Audio/ }).filter({ hasText: /◀|◁|⏪|prev/i })).toHaveCount(0);
    await expect(panel(page).locator('.proclaim-av-controls button').filter({ hasText: /Audio/ })).toHaveCount(1);
  });

  test('audio controls row is hidden when current item is a Video', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', currentItemType: 'Video', slideIndex: 0, serviceItems },
    });
    await expect(panel(page).locator('.proclaim-av-controls').filter({ hasText: /Audio/ })).toBeHidden();
  });

  test('audio controls row is visible when current item is not a Video', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item2', currentItemType: 'Song', slideIndex: 0, serviceItems },
    });
    await expect(panel(page).locator('.proclaim-av-controls').filter({ hasText: /Audio/ })).toBeVisible();
  });
});
