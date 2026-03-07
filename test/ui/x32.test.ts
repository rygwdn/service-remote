import { test, expect } from './fixtures';

const channels = [
  { index: 1, type: 'ch' as const, label: 'Vocals', fader: 0.8, muted: false, level: 0.5 },
  { index: 2, type: 'ch' as const, label: 'Guitar', fader: 0.5, muted: false, level: 0.3 },
  { index: 1, type: 'bus' as const, label: 'Main Bus', fader: 1.0, muted: false, level: 0.7 },
];

test.describe('Sound (X32) panel', () => {
  const panel = (page: Parameters<typeof test>[1]['page']) =>
    page.locator('section.panel.active');

  test.beforeEach(async ({ page }) => {
    await page.locator('.tab').filter({ hasText: 'Sound' }).click();
    await expect(page.locator('section.panel.active')).toBeVisible();
  });

  test('renders channel rows for each channel', async ({ page, setState }) => {
    await setState({ x32: { connected: true, channels } });

    const rows = panel(page).locator('.channel-row-h');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator('.ch-label')).toHaveText('Vocals');
    await expect(rows.nth(1).locator('.ch-label')).toHaveText('Guitar');
    await expect(rows.nth(2).locator('.ch-label')).toHaveText('Main Bus');
  });

  test('mute button shows MUTED when channel is muted', async ({ page, setState }) => {
    await setState({
      x32: {
        connected: true,
        channels: [
          { ...channels[0], muted: true },
          { ...channels[1], muted: false },
        ],
      },
    });

    const rows = panel(page).locator('.channel-row-h');
    await expect(rows.nth(0).locator('.ch-mute')).toHaveText('MUTED');
    await expect(rows.nth(0).locator('.ch-mute')).toHaveClass(/muted/);
    await expect(rows.nth(1).locator('.ch-mute')).toHaveText('ON');
    await expect(rows.nth(1).locator('.ch-mute')).not.toHaveClass(/muted/);
  });

  test('clicking mute sends x32/mute API call', async ({ page, setState }) => {
    let muteCall: { channel: number; type: string } | null = null;
    await page.route('**/api/x32/mute', async (route) => {
      muteCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ x32: { connected: true, channels: [channels[0]] } });

    // Unlock faders first so the mute button is enabled
    const p = panel(page);
    await p.locator('.btn-edit-toggle').filter({ hasText: /Locked|Unlocked/ }).click();

    await p.locator('.ch-mute').first().click();
    await page.waitForTimeout(100);

    expect(muteCall).not.toBeNull();
    expect(muteCall!.channel).toBe(1);
    expect(muteCall!.type).toBe('ch');
  });

  test('edit mode reveals visibility checkboxes', async ({ page, setState }) => {
    await setState({ x32: { connected: true, channels } });

    const p = panel(page);
    await expect(p.locator('.fader-visibility-label').first()).not.toBeVisible();
    await p.locator('.btn-edit-toggle').filter({ hasText: 'Edit' }).click();
    await expect(p.locator('.fader-visibility-label').first()).toBeVisible();
  });

  test('unchecking visibility hides a channel row after leaving edit mode', async ({ page, setState }) => {
    await page.route('**/api/ui/hidden', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ x32: { connected: true, channels } });

    const p = panel(page);
    await p.locator('.btn-edit-toggle').filter({ hasText: 'Edit' }).click();

    const firstCb = p.locator('.fader-visibility-cb').first();
    await firstCb.uncheck();

    await p.locator('.btn-edit-toggle').filter({ hasText: 'Done' }).click();

    const rows = p.locator('.channel-row-h');
    await expect(rows.nth(0)).not.toBeVisible();
    await expect(rows.nth(1)).toBeVisible();
  });

  test('default-named channels are hidden by default', async ({ page, setState }) => {
    const mixedChannels = [
      { index: 1, type: 'ch' as const, label: 'Vocals', fader: 0.8, muted: false, level: 0.5 },
      { index: 2, type: 'ch' as const, label: 'CH 02', fader: 0.5, muted: false, level: 0.0 },
      { index: 1, type: 'bus' as const, label: 'Bus 01', fader: 0.7, muted: false, level: 0.0 },
      { index: 1, type: 'main' as const, label: 'Main L/R', fader: 0.9, muted: false, level: 0.6 },
    ];

    await setState({ x32: { connected: true, channels: mixedChannels } });

    const p = panel(page);
    // Custom-named and Main L/R channels should be visible
    await expect(p.locator('.channel-row-h').filter({ hasText: 'Vocals' })).toBeVisible();
    await expect(p.locator('.channel-row-h').filter({ hasText: 'Main L/R' })).toBeVisible();
    // Default-named channels should be hidden
    await expect(p.locator('.channel-row-h').filter({ hasText: 'CH 02' })).not.toBeVisible();
    await expect(p.locator('.channel-row-h').filter({ hasText: 'Bus 01' })).not.toBeVisible();
  });

  test('fader is disabled by default (locked)', async ({ page, setState }) => {
    await setState({ x32: { connected: true, channels: [channels[0]] } });

    const p = panel(page);
    const fader = p.locator('input[type="range"]').first();
    await expect(fader).toBeDisabled();
    await expect(p.locator('.btn-edit-toggle').filter({ hasText: 'Locked' })).toBeVisible();
  });

  test('Lock/Unlock toggle enables and disables the fader', async ({ page, setState }) => {
    await setState({ x32: { connected: true, channels: [channels[0]] } });

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

  test('mute button is disabled when faders are locked', async ({ page, setState }) => {
    await setState({ x32: { connected: true, channels: [channels[0]] } });

    const p = panel(page);
    const muteBtn = p.locator('.ch-mute').first();
    // By default faders are locked, so mute should be disabled
    await expect(muteBtn).toBeDisabled();
  });

  test('mute button is enabled when faders are unlocked', async ({ page, setState }) => {
    await setState({ x32: { connected: true, channels: [channels[0]] } });

    const p = panel(page);
    const lockBtn = p.locator('.btn-edit-toggle').filter({ hasText: /Locked|Unlocked/ });
    const muteBtn = p.locator('.ch-mute').first();

    // Unlock faders
    await lockBtn.click();
    await expect(muteBtn).toBeEnabled();
  });

  test('Lock/Unlock toggle disables and enables the mute button', async ({ page, setState }) => {
    await setState({ x32: { connected: true, channels: [channels[0]] } });

    const p = panel(page);
    const lockBtn = p.locator('.btn-edit-toggle').filter({ hasText: /Locked|Unlocked/ });
    const muteBtn = p.locator('.ch-mute').first();

    // Initially locked
    await expect(muteBtn).toBeDisabled();

    // Unlock
    await lockBtn.click();
    await expect(muteBtn).toBeEnabled();

    // Lock again
    await lockBtn.click();
    await expect(muteBtn).toBeDisabled();
  });
});
