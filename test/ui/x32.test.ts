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

  test('renders channel strips for each channel', async ({ page, setState }) => {
    await setState({ x32: { connected: true, channels } });

    const strips = panel(page).locator('.channel-strip');
    await expect(strips).toHaveCount(3);
    await expect(strips.nth(0).locator('.ch-label')).toHaveText('Vocals');
    await expect(strips.nth(1).locator('.ch-label')).toHaveText('Guitar');
    await expect(strips.nth(2).locator('.ch-label')).toHaveText('Main Bus');
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

    const strips = panel(page).locator('.channel-strip');
    await expect(strips.nth(0).locator('.ch-mute')).toHaveText('MUTED');
    await expect(strips.nth(0).locator('.ch-mute')).toHaveClass(/muted/);
    await expect(strips.nth(1).locator('.ch-mute')).toHaveText('ON');
    await expect(strips.nth(1).locator('.ch-mute')).not.toHaveClass(/muted/);
  });

  test('clicking mute sends x32/mute API call', async ({ page, setState }) => {
    let muteCall: { channel: number; type: string } | null = null;
    await page.route('**/api/x32/mute', async (route) => {
      muteCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ x32: { connected: true, channels: [channels[0]] } });

    await panel(page).locator('.ch-mute').first().click();
    await page.waitForTimeout(100);

    expect(muteCall).not.toBeNull();
    expect(muteCall!.channel).toBe(1);
    expect(muteCall!.type).toBe('ch');
  });

  test('edit mode reveals visibility checkboxes', async ({ page, setState }) => {
    await setState({ x32: { connected: true, channels } });

    const p = panel(page);
    await expect(p.locator('.fader-visibility-label').first()).not.toBeVisible();
    await p.locator('.btn-edit-toggle').click();
    await expect(p.locator('.fader-visibility-label').first()).toBeVisible();
  });

  test('unchecking visibility hides a channel strip after leaving edit mode', async ({ page, setState }) => {
    await page.route('**/api/ui/hidden', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({ x32: { connected: true, channels } });

    const p = panel(page);
    await p.locator('.btn-edit-toggle').click();

    const firstCb = p.locator('.fader-visibility-cb').first();
    await firstCb.uncheck();

    await p.locator('.btn-edit-toggle').click();

    const strips = p.locator('.channel-strip');
    await expect(strips.nth(0)).not.toBeVisible();
    await expect(strips.nth(1)).toBeVisible();
  });
});
