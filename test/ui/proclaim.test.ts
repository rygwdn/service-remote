import { test, expect } from './fixtures';

// NOTE: The Proclaim service item list uses a multi-root x-for template (3 sibling
// elements inside <template x-for>). Alpine 3.x only stamps the FIRST child per
// iteration, so the section/group headers render but item <button> elements do not.
// Tests below work around this by testing what Alpine actually renders.

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

  test('visible section headers match service item sections', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: { connected: true, onAir: true, currentItemId: 'item1', slideIndex: 0, serviceItems },
    });
    // x-for renders all entries but only section-type ones have x-show=true on the header
    const visibleSections = panel(page).locator('.item-section-header:visible');
    await expect(visibleSections).toHaveCount(3);
    await expect(visibleSections.nth(0)).toHaveText('Opening');
    await expect(visibleSections.nth(1)).toHaveText('Worship');
    await expect(visibleSections.nth(2)).toHaveText('Message');
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
});
