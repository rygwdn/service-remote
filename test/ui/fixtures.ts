import { test as base, expect, Page, WebSocketRoute } from '@playwright/test';
import path = require('path');
import fs = require('fs');

// Silence logger output (console.log/warn/error) from the test server process
const noop = () => {};
console.log = noop;
console.warn = noop;
console.error = noop;

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
};

type Fixtures = {
  serverUrl: string;
  setState: (state: AppState) => Promise<void>;
};

const defaultState: Required<AppState> = {
  obs: { connected: false, scenes: [], currentScene: '', streaming: false, recording: false, audioSources: [] },
  x32: { connected: false, channels: [] },
  proclaim: { connected: false, onAir: false, currentItemId: null, currentItemTitle: null, currentItemType: null, slideIndex: null, serviceItems: [] },
};

const alpinePath = path.resolve(__dirname, '../../node_modules/alpinejs/dist/cdn.js');
const alpineJs = fs.readFileSync(alpinePath, 'utf8');

export const test = base.extend<{ setState: Fixtures['setState'] }, { serverUrl: Fixtures['serverUrl'] }>({
  serverUrl: [async ({}, use) => {
    const path = require('path');
    const express = require('express');
    const { createTestApp, startServer } = require('../helpers/app');
    const { app, server } = createTestApp();
    app.use(express.static(path.resolve(__dirname, '../../public')));
    const port = await startServer(server);
    await use(`http://localhost:${port}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
      };
      await page.evaluate((state) => {
        const store = (window as any).Alpine.store('state');
        store.obs = state.obs;
        store.x32 = state.x32;
        store.proclaim = state.proclaim;
      }, merged);
      // Allow Alpine to process reactive updates
      await page.waitForTimeout(50);
    };
    await use(helper);
  },
});

export { expect };
