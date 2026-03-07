import { test, expect } from './fixtures';

test.describe('OBS panel', () => {
  const panel = (page: Parameters<typeof test>[1]['page']) =>
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
});
