import { test, expect, type AppState } from './fixtures';
import type { Page } from '@playwright/test';

test.describe('Proclaim whole-song lyric view', () => {
  const panel = (page: Page) => page.locator('section.panel.active');

  async function goToProclaim(page: Page, setState: (s: AppState) => Promise<void>, state?: AppState) {
    if (state) await setState(state);
    await page.locator('.tab').filter({ hasText: 'Proclaim' }).click();
    await expect(page.locator('section.panel.active')).toBeVisible();
  }

  const lyrics = {
    item2: [
      ['Verse 1', 'Amazing grace, how sweet the sound'],
      ['I once was lost, but now am found'],
      ['Chorus', 'My chains are gone'],
    ],
  };

  test('shows all slides as text blocks with current slide highlighted', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: {
        connected: true, onAir: true,
        currentItemId: 'item2', currentItemTitle: 'Amazing Grace', currentItemType: 'SongLyrics',
        slideIndex: 1,
        serviceItems: [
          { id: 'item2', title: 'Amazing Grace', kind: 'SongLyrics', slideCount: 3, index: 2, section: 'Worship', group: null },
        ],
        songLyrics: lyrics,
      },
    });
    const song = panel(page).locator('.song-lyrics');
    await expect(song).toBeVisible();
    const slides = song.locator('.song-slide');
    await expect(slides).toHaveCount(3);
    await expect(slides.nth(0)).toContainText('Amazing grace, how sweet the sound');
    await expect(slides.nth(1)).toContainText('I once was lost');
    await expect(slides.nth(1)).toHaveClass(/active/);
    await expect(slides.nth(0)).not.toHaveClass(/active/);
    await expect(slides.nth(2)).toContainText('My chains are gone');
  });

  test('clicking a slide block sends GoToSlide for that slide', async ({ page, setState }) => {
    let payload: any = null;
    await page.route('**/api/proclaim/action', async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await goToProclaim(page, setState, {
      proclaim: {
        connected: true, onAir: true,
        currentItemId: 'item2', currentItemTitle: 'Amazing Grace', currentItemType: 'SongLyrics',
        slideIndex: 0,
        serviceItems: [
          { id: 'item2', title: 'Amazing Grace', kind: 'SongLyrics', slideCount: 3, index: 2, section: 'Worship', group: null },
        ],
        songLyrics: lyrics,
      },
    });
    await panel(page).locator('.song-slide').nth(2).click();
    await expect.poll(() => payload).toEqual({ action: 'GoToSlide', index: 3 });
  });

  test('highlights follow slideIndex updates', async ({ page, setState }) => {
    const state = {
      proclaim: {
        connected: true, onAir: true,
        currentItemId: 'item2', currentItemTitle: 'Amazing Grace', currentItemType: 'SongLyrics',
        slideIndex: 0,
        serviceItems: [
          { id: 'item2', title: 'Amazing Grace', kind: 'SongLyrics', slideCount: 3, index: 2, section: 'Worship', group: null },
        ],
        songLyrics: lyrics,
      },
    };
    await goToProclaim(page, setState, state);
    await expect(panel(page).locator('.song-slide').nth(0)).toHaveClass(/active/);
    await setState({ proclaim: { ...state.proclaim, slideIndex: 2 } });
    await expect(panel(page).locator('.song-slide').nth(2)).toHaveClass(/active/);
    await expect(panel(page).locator('.song-slide').nth(0)).not.toHaveClass(/active/);
  });

  test('hides lyric view when no lyrics available for the song', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: {
        connected: true, onAir: true,
        currentItemId: 'item2', currentItemTitle: 'Amazing Grace', currentItemType: 'SongLyrics',
        slideIndex: 0,
        serviceItems: [
          { id: 'item2', title: 'Amazing Grace', kind: 'SongLyrics', slideCount: 3, index: 2, section: 'Worship', group: null },
        ],
        songLyrics: {},
      },
    });
    await expect(panel(page).locator('.song-lyrics')).toBeHidden();
  });

  test('hides lyric view for non-song items even with lyrics cached', async ({ page, setState }) => {
    await goToProclaim(page, setState, {
      proclaim: {
        connected: true, onAir: true,
        currentItemId: 'item1', currentItemTitle: 'Welcome', currentItemType: 'Slide',
        slideIndex: 0,
        serviceItems: [
          { id: 'item1', title: 'Welcome', kind: 'Slide', slideCount: 1, index: 1, section: 'Opening', group: null },
          { id: 'item2', title: 'Amazing Grace', kind: 'SongLyrics', slideCount: 3, index: 2, section: 'Worship', group: null },
        ],
        songLyrics: lyrics,
      },
    });
    await expect(panel(page).locator('.song-lyrics')).toBeHidden();
  });
});
