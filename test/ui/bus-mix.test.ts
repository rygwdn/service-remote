import { test as base, expect } from '@playwright/test';
import path = require('path');
import fs = require('fs');

// Silence logger output from the test server process
const noop = () => {};
console.log = noop;
console.warn = noop;
console.error = noop;

const alpinePath = path.resolve(__dirname, '../../node_modules/alpinejs/dist/cdn.js');
const alpineJs = fs.readFileSync(alpinePath, 'utf8');

type BusState = {
  connected?: boolean;
  busIndex?: number;
  busChannel?: { index: number; type: 'bus'; label: string; fader: number; muted: boolean; level: number; spill?: boolean; color?: number } | null;
  channels?: Array<{ index: number; type: 'ch'; label: string; fader: number; muted: boolean; level: number; spill?: boolean; color?: number; busSends?: Array<{ busIndex: number; level: number; on: boolean }> }>;
};

type BusMixFixtures = {
  setState: (state: BusState) => Promise<void>;
};

const test = base.extend<BusMixFixtures, { serverUrl: string }>({
  serverUrl: [async ({}, use) => {
    const { spawn } = require('child_process') as typeof import('child_process');
    const nodePath = require('path') as typeof import('path');
    const serverScript = nodePath.resolve(__dirname, '../helpers/test-server.ts');
    const proc = spawn('bun', ['run', serverScript], { stdio: ['ignore', 'pipe', 'ignore'] });
    const port: number = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test server did not start in time')), 10000);
      let buf = '';
      proc.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const line = buf.split('\n')[0].trim();
        if (line) { clearTimeout(timeout); resolve(parseInt(line, 10)); }
      });
      proc.on('error', reject);
    });
    await use(`http://localhost:${port}`);
    proc.kill('SIGTERM');
  }, { scope: 'worker' }],

  page: async ({ page, serverUrl }, use) => {
    await page.route('**cdn.jsdelivr.net/npm/alpinejs**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: alpineJs })
    );

    // Drop WebSocket messages from real server so they don't overwrite test state
    await page.routeWebSocket(/.*/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage(() => { /* absorb server pushes */ });
      ws.onMessage((msg) => server.send(msg));
    });

    await page.goto(`${serverUrl}/bus-mix.html?bus=8`);
    // Wait for Alpine to initialize and the bus store to be ready
    await page.waitForFunction(() => {
      const w = window as any;
      return w.Alpine && w.Alpine.store && w.Alpine.store('bus');
    });

    await use(page);
  },

  setState: async ({ page }, use) => {
    const helper = async (state: BusState) => {
      await page.evaluate((s) => {
        const store = (window as any).Alpine.store('bus');
        if (s.connected !== undefined) store.connected = s.connected;
        if (s.busChannel !== undefined) store.busChannel = s.busChannel;
        if (s.channels !== undefined) store.channels = s.channels;
      }, state);
      await page.waitForTimeout(50);
    };
    await use(helper);
  },
});

test.describe('Bus Mix page (/bus-mix.html?bus=8)', () => {
  test('renders the page title with the bus label', async ({ page, setState }) => {
    await setState({
      connected: true,
      busChannel: { index: 8, type: 'bus', label: 'Stage Mon', fader: 0.9, muted: false, level: 0, color: 0 },
      channels: [],
    });
    await expect(page.locator('h1')).toContainText('Stage Mon');
  });

  test('renders a fader row for the bus master', async ({ page, setState }) => {
    await setState({
      connected: true,
      busChannel: { index: 8, type: 'bus', label: 'Stage Mon', fader: 0.75, muted: false, level: 0, color: 0 },
      channels: [],
    });
    const busRow = page.locator('.bus-master-row');
    await expect(busRow).toBeVisible();
    await expect(busRow.locator('input[type=range]')).toHaveValue('0.75');
  });

  test('renders a row for each channel in the store (backend pre-filters to enabled sends)', async ({ page, setState }) => {
    // The backend (/ws/bus) pre-filters channels to only those with on=true for this bus.
    // The UI renders all channels it receives — it trusts the server-provided list.
    await setState({
      connected: true,
      busChannel: { index: 8, type: 'bus', label: 'Stage Mon', fader: 0.9, muted: false, level: 0, color: 0 },
      channels: [
        { index: 1, type: 'ch', label: 'Vocals', fader: 0.8, muted: false, level: 0, color: 0,
          busSends: [{ busIndex: 8, level: 0.7, on: true }] },
        { index: 3, type: 'ch', label: 'Keys', fader: 0.6, muted: false, level: 0, color: 0,
          busSends: [{ busIndex: 8, level: 0.5, on: true }] },
      ],
    });
    const rows = page.locator('.channel-send-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Vocals');
    await expect(rows.nth(1)).toContainText('Keys');
  });

  test('slider value reflects busSend level for the bus', async ({ page, setState }) => {
    await setState({
      connected: true,
      busChannel: { index: 8, type: 'bus', label: 'Stage Mon', fader: 0.9, muted: false, level: 0, color: 0 },
      channels: [
        { index: 1, type: 'ch', label: 'Vocals', fader: 0.8, muted: false, level: 0, color: 0,
          busSends: [{ busIndex: 8, level: 0.6, on: true }] },
      ],
    });
    const row = page.locator('.channel-send-row').first();
    await expect(row.locator('input[type=range]')).toHaveValue('0.6');
  });

  test('moving a channel send slider posts to /api/x32/bus-send', async ({ page, setState }) => {
    let busSendCall: { channel: number; busIndex: number; value: number } | null = null;
    await page.route('**/api/x32/bus-send', async (route) => {
      busSendCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({
      connected: true,
      busChannel: { index: 8, type: 'bus', label: 'Stage Mon', fader: 0.9, muted: false, level: 0, color: 0 },
      channels: [
        { index: 1, type: 'ch', label: 'Vocals', fader: 0.8, muted: false, level: 0, color: 0,
          busSends: [{ busIndex: 8, level: 0.5, on: true }] },
      ],
    });

    const slider = page.locator('.channel-send-row').first().locator('input[type=range]');
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '0.8';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Allow debounce
    await page.waitForTimeout(150);

    expect(busSendCall).not.toBeNull();
    expect(busSendCall!.channel).toBe(1);
    expect(busSendCall!.busIndex).toBe(8);
    expect(busSendCall!.value).toBeCloseTo(0.8, 1);
  });

  test('moving the bus master fader posts to /api/x32/fader with type bus', async ({ page, setState }) => {
    let faderCall: { channel: number; type: string; value: number } | null = null;
    await page.route('**/api/x32/fader', async (route) => {
      faderCall = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await setState({
      connected: true,
      busChannel: { index: 8, type: 'bus', label: 'Stage Mon', fader: 0.5, muted: false, level: 0, color: 0 },
      channels: [],
    });

    const slider = page.locator('.bus-master-row input[type=range]');
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '0.9';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(150);

    expect(faderCall).not.toBeNull();
    expect(faderCall!.channel).toBe(8);
    expect(faderCall!.type).toBe('bus');
    expect(faderCall!.value).toBeCloseTo(0.9, 1);
  });

  test('level meter element has data-level-key attribute for levels WS updates', async ({ page, setState }) => {
    await setState({
      connected: true,
      busChannel: { index: 8, type: 'bus', label: 'Stage Mon', fader: 0.9, muted: false, level: 0, color: 0 },
      channels: [
        { index: 1, type: 'ch', label: 'Vocals', fader: 0.8, muted: false, level: 0, color: 0,
          busSends: [{ busIndex: 8, level: 0.5, on: true }] },
      ],
    });
    // Bus master meter
    const busMeter = page.locator('.bus-master-row [data-level-key="bus-8"]');
    await expect(busMeter).toBeAttached();
    // Channel meter
    const chMeter = page.locator('.channel-send-row [data-level-key="ch-1"]');
    await expect(chMeter).toBeAttached();
  });

  test('shows disconnected overlay when x32 is not connected', async ({ page, setState }) => {
    await setState({ connected: false, busChannel: null, channels: [] });
    await expect(page.locator('.disconnected-overlay')).toBeVisible();
  });
});
