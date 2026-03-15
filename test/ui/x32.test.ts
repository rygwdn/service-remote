import { test, expect } from './fixtures';

const channels = [
  { index: 1, type: 'ch' as const, label: 'Vocals', fader: 0.8, muted: false, level: 0.5, spill: true },
  { index: 2, type: 'ch' as const, label: 'Guitar', fader: 0.5, muted: false, level: 0.3, spill: true },
  { index: 1, type: 'bus' as const, label: 'Main Bus', fader: 1.0, muted: false, level: 0.7, spill: true },
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
    let spillCall: { channel: number; type: string; assigned: boolean } | null = null;
    await page.route('**/api/x32/spill', async (route) => {
      spillCall = route.request().postDataJSON();
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

    // Verify the API call was made
    expect(spillCall).not.toBeNull();
    expect(spillCall!.assigned).toBe(false);
  });

  test('channels with spill:false are hidden, spill:true are shown', async ({ page, setState }) => {
    const mixedChannels = [
      { index: 1, type: 'ch' as const, label: 'Vocals', fader: 0.8, muted: false, level: 0.5, spill: true },
      { index: 2, type: 'ch' as const, label: 'Guitar', fader: 0.5, muted: false, level: 0.0, spill: false },
      { index: 1, type: 'bus' as const, label: 'Main Bus', fader: 0.7, muted: false, level: 0.0, spill: false },
      { index: 1, type: 'main' as const, label: 'Main L/R', fader: 0.9, muted: false, level: 0.6, spill: false },
    ];

    await setState({ x32: { connected: true, channels: mixedChannels } });

    const p = panel(page);
    // spill:true channel is visible
    await expect(p.locator('.channel-row-h').filter({ hasText: 'Vocals' })).toBeVisible();
    // spill:false channels are hidden
    await expect(p.locator('.channel-row-h').filter({ hasText: 'Guitar' })).not.toBeVisible();
    await expect(p.locator('.channel-row-h').filter({ hasText: 'Main Bus' })).not.toBeVisible();
    // main type is always shown regardless of spill
    await expect(p.locator('.channel-row-h').filter({ hasText: 'Main L/R' })).toBeVisible();
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

  // Helper: simulate a levels update by directly invoking the same DOM logic as the WS handler
  async function injectLevels(page: Parameters<typeof test>[1]['page'], x32: Record<string, number>) {
    await page.evaluate((x32Levels) => {
      const mulToDisplayPct = (window as any).mulToDisplayPct;
      for (const [key, level] of Object.entries(x32Levels)) {
        const els = document.querySelectorAll(`[data-level-key="${key}"]`);
        for (const el of els) {
          (el as HTMLElement).style.width = mulToDisplayPct(level).toFixed(1) + '%';
        }
      }
    }, x32);
    await page.waitForTimeout(50);
  }

  test.describe('meter display (dB scale)', () => {
    test.beforeEach(async ({ page, setState }) => {
      await setState({
        x32: {
          connected: true,
          channels: [
            { index: 1, type: 'ch' as const, label: 'Vocals', fader: 0.8, muted: false, level: 0 },
          ],
        },
      });
    });

    test('silence (level=0) shows 0% meter', async ({ page }) => {
      await injectLevels(page, { 'ch-1': 0 });
      const fill = panel(page).locator('.ch-meter-fill-h').first();
      const width = await fill.evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0);
      expect(width).toBe(0);
    });

    test('0 dBFS (level=1.0) shows 100% meter', async ({ page }) => {
      await injectLevels(page, { 'ch-1': 1.0 });
      const fill = panel(page).locator('.ch-meter-fill-h').first();
      const width = await fill.evaluate((el) => parseFloat((el as HTMLElement).style.width));
      expect(width).toBeCloseTo(100, 0);
    });

    test('-20 dBFS (level≈0.1) shows ~67% meter (not 10%)', async ({ page }) => {
      const mul = Math.pow(10, -20 / 20); // ≈ 0.1
      await injectLevels(page, { 'ch-1': mul });
      const fill = panel(page).locator('.ch-meter-fill-h').first();
      const width = await fill.evaluate((el) => parseFloat((el as HTMLElement).style.width));
      expect(width).toBeGreaterThan(60);
      expect(width).toBeLessThan(75);
    });

    test('initial state (level=0 from Alpine store) shows 0% meter', async ({ page, setState }) => {
      await setState({
        x32: {
          connected: true,
          channels: [
            { index: 1, type: 'ch' as const, label: 'Vocals', fader: 0.8, muted: false, level: 0 },
          ],
        },
      });
      const fill = panel(page).locator('.ch-meter-fill-h').first();
      const width = await fill.evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0);
      expect(width).toBe(0);
    });

    test('very loud signal above 0 dBFS clamps to 100%', async ({ page }) => {
      await injectLevels(page, { 'ch-1': 2.0 });
      const fill = panel(page).locator('.ch-meter-fill-h').first();
      const width = await fill.evaluate((el) => parseFloat((el as HTMLElement).style.width));
      expect(width).toBeCloseTo(100, 0);
    });
  });
});
