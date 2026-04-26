import { test as base, expect, Page, WebSocketRoute } from '@playwright/test';
import path = require('path');
import fs = require('fs');

// Silence logger output (console.log/warn/error) from the test server process
const noop = () => {};
console.log = noop;
console.warn = noop;
console.error = noop;

type PtzCameraState = { name: string; connected: boolean; pan: number | null; tilt: number | null; zoom: number | null; presets: number[] };

type AppState = {
  obs?: {
    connected?: boolean;
    scenes?: string[];
    currentScene?: string;
    streaming?: boolean;
    recording?: boolean;
    audioSources?: { name: string; volume: number; muted: boolean; level: number; live?: boolean }[];
  };
  x32?: {
    connected?: boolean;
    channels?: { index: number; type: 'ch' | 'bus' | 'main' | 'mtx'; label: string; fader: number; muted: boolean; level: number; spill?: boolean }[];
  };
  proclaim?: {
    connected?: boolean;
    onAir?: boolean;
    currentItemId?: string | null;
    currentItemTitle?: string | null;
    currentItemType?: string | null;
    slideIndex?: number | null;
    serviceItems?: { id: string; title: string; kind: string; slideCount: number; index: number; section: string; group: string | null }[];
  };
  ptz?: {
    cameras?: PtzCameraState[];
  };
  youtube?: {
    connected?: boolean;
    viewerCount?: number | null;
    broadcastTitle?: string | null;
    broadcastId?: string | null;
    broadcastStatus?: 'ready' | 'testing' | 'live' | 'complete' | null;
  };
};

type Fixtures = {
  serverUrl: string;
  setState: (state: AppState) => Promise<void>;
};

const defaultState: Required<AppState> = {
  obs: { connected: false, scenes: [], currentScene: '', streaming: false, recording: false, audioSources: [] },
  x32: { connected: false, channels: [] },
  proclaim: { connected: false, onAir: false, currentItemId: null, currentItemTitle: null, currentItemType: null, slideIndex: null, serviceItems: [] },
  ptz: { cameras: [] },
  youtube: { connected: false, viewerCount: null, broadcastTitle: null, broadcastId: null, broadcastStatus: null },
};

const alpinePath = path.resolve(__dirname, '../../node_modules/alpinejs/dist/cdn.js');
const alpineJs = fs.readFileSync(alpinePath, 'utf8');

export const test = base.extend<{ setState: Fixtures['setState'] }, { serverUrl: Fixtures['serverUrl'] }>({
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
    // Serve Alpine locally to avoid CDN dependency
    await page.route('**cdn.jsdelivr.net/npm/alpinejs**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: alpineJs })
    );

    // Stub API endpoints called on init
    await page.route('**/api/config', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        obs: { address: '', password: '', screenshotInterval: 1000 },
        x32: { address: '', port: 10023 },
        proclaim: { host: '', port: 52195, password: '', pollInterval: 1000 },
        youtube: { apiKey: '', broadcastId: '', pollInterval: 30000 },
      }) })
    );
    await page.route('**/api/logs', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ logs: [] }) })
    );
    await page.route('**/api/ui/hidden', (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hiddenObs: [], hiddenX32: [] }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    // Drop WebSocket messages from the real server so they don't overwrite test state.
    // This intercepts both the main state WS and the /ws/screenshot binary WS.
    let wsRoute: WebSocketRoute | null = null;
    await page.routeWebSocket(/.*/, (ws) => {
      wsRoute = ws;
      const server = ws.connectToServer();
      server.onMessage(() => { /* absorb server pushes (state and screenshot frames) */ });
      ws.onMessage((msg) => server.send(msg));
    });

    await page.goto(serverUrl);
    await page.waitForFunction(() => {
      const w = window as any;
      return w.Alpine && w.Alpine.store('state') && w.Alpine.store('ui');
    });

    await use(page);
  },

  setState: async ({ page }, use) => {
    const helper = async (patch: AppState) => {
      const merged = {
        obs: { ...defaultState.obs, ...patch.obs },
        x32: { ...defaultState.x32, ...patch.x32 },
        proclaim: { ...defaultState.proclaim, ...patch.proclaim },
        ptz: { ...defaultState.ptz, ...patch.ptz },
        youtube: { ...defaultState.youtube, ...patch.youtube },
      };
      await page.evaluate((state) => {
        const store = (window as any).Alpine.store('state');
        store.obs = state.obs;
        store.x32 = state.x32;
        store.proclaim = state.proclaim;
        store.ptz = state.ptz;
        store.youtube = state.youtube;
      }, merged);
      // Allow Alpine to process reactive updates
      await page.waitForTimeout(50);
    };
    await use(helper);
  },
});

export { expect };
