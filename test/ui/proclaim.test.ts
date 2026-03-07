import { test, expect } from './fixtures';

const serviceItems = [
  { id: 'item1', title: 'Welcome', kind: 'Slide', slideCount: 1, index: 0, section: 'Opening', group: null },
  { id: 'item2', title: 'Amazing Grace', kind: 'Song', slideCount: 4, index: 1, section: 'Worship', group: null },
  { id: 'item3', title: 'Sermon', kind: 'Slide', slideCount: 8, index: 2, section: 'Message', group: null },
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

  test('clicking an item sends GoToServiceItem action', async ({ page, setState }) => {
    let lastCall: { action: string; index?: number } | null = null;
    await page.route('**/api/proclaim/action', async (route) => {
      lastCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', slideIndex: 0, serviceItems },
    });

    await panel(page).locator('.item-btn:visible').nth(2).click();
    await page.waitForTimeout(100);

    expect(lastCall).not.toBeNull();
    expect(lastCall!.action).toBe('GoToServiceItem');
    expect(lastCall!.index).toBe(2);
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
    await p.locator('.proclaim-controls button').filter({ hasText: 'Prev Item' }).click();
    await p.locator('.proclaim-controls button').filter({ hasText: 'Next Item' }).click();
    await p.locator('.proclaim-controls button').filter({ hasText: 'Prev Slide' }).click();
    await p.locator('.proclaim-controls button').filter({ hasText: 'Next Slide' }).click();

    await page.waitForTimeout(200);
    expect(calls).toEqual(['PreviousServiceItem', 'NextServiceItem', 'PreviousSlide', 'NextSlide']);
  });

  test('shows no items when not on air', async ({ page, setState }) => {
    await goToProclaim(page, setState, { proclaim: { connected: true, onAir: false } });
    await expect(panel(page).locator('.item-btn:visible')).toHaveCount(0);
  });
});
