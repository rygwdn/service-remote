import http = require('http');
import path = require('path');
import express = require('express');
import stateModule = require('../../src/state');
const { setupRoutes } = require('../../src/routes');
const { setupWebSocket } = require('../../src/ws');
import type { Connections } from '../../src/types';
import screenshotWsModule = require('../../src/screenshot-ws');
import levelsWsModule = require('../../src/levels-ws');


interface TestCalls {
  obs: {
    connect: number; disconnect: number; startMeterUpdates: number; stopMeterUpdates: number;
    setScene?: string; toggleMute?: string; setInputVolume?: { input: string; volumeDb: number };
    toggleStream?: true; toggleRecord?: true;
  };
  x32: {
    connect: number; disconnect: number; startMeterUpdates: number; stopMeterUpdates: number;
    setFader?: { channel: number; value: number }; toggleMute?: number;
  };
  proclaim: {
    connect: number; disconnect: number; startMeterUpdates: number; stopMeterUpdates: number;
    sendAction?: { action: string; index?: number }; goToItem?: string;
  };
}

interface TestApp {
  app: ReturnType<typeof express>;
  server: http.Server;
  state: InstanceType<typeof stateModule.State>;
  stubs: Connections;
  calls: TestCalls;
}

/**
 * Creates a fresh Express + WebSocket server with stub connection objects.
 * Returns { server, state, stubs, calls }.
 * Call server.close() in afterEach/after to clean up.
 */
function createTestApp(): TestApp {
  const state = new stateModule.State();

  // Record every call made through the stubs so tests can assert on them.
  const calls: TestCalls = {
    obs:     { connect: 0, disconnect: 0, startMeterUpdates: 0, stopMeterUpdates: 0 },
    x32:     { connect: 0, disconnect: 0, startMeterUpdates: 0, stopMeterUpdates: 0 },
    proclaim:{ connect: 0, disconnect: 0, startMeterUpdates: 0, stopMeterUpdates: 0 },
  };

  const stubs: Connections = {
    obs: {
      connect: async () => { calls.obs.connect++; },
      disconnect: () => { calls.obs.disconnect++; },
      setScene: async (scene: string) => { calls.obs.setScene = scene; },
      toggleMute: async (input: string) => { calls.obs.toggleMute = input; },
      setInputVolume: async (input: string, volumeDb: number) => { calls.obs.setInputVolume = { input, volumeDb }; },
      toggleStream: async () => { calls.obs.toggleStream = true; },
      toggleRecord: async () => { calls.obs.toggleRecord = true; },
      getSceneScreenshot: async (_sceneName: string) => Buffer.alloc(0),
    },
    x32: {
      connect: () => { calls.x32.connect++; },
      disconnect: () => { calls.x32.disconnect++; },
      setFader: (channel: number, value: number, _type?: 'ch' | 'bus') => { calls.x32.setFader = { channel, value }; },
      toggleMute: (channel: number, _type?: 'ch' | 'bus') => { calls.x32.toggleMute = channel; },
      parseOscMessage: () => null,
      startMeterUpdates: () => { calls.x32.startMeterUpdates++; },
      stopMeterUpdates: () => { calls.x32.stopMeterUpdates++; },
    },
    proclaim: {
      connect: async () => { calls.proclaim.connect++; },
      disconnect: () => { calls.proclaim.disconnect++; },
      sendAction: async (action: string, index?: number) => {
        calls.proclaim.sendAction = { action, index };
        return true;
      },
      goToItem: async (itemId: string) => {
        calls.proclaim.goToItem = itemId;
        return true;
      },
      getThumbUrl: (itemId?: string, slideIndex?: string, _localRevision?: string) => `/fake-thumb/${itemId}/${slideIndex}`,
      getToken: () => 'test-token',
      getOnAirSessionId: () => null,
    },
  };

  // Use a temp path for config writes during tests to avoid touching real config.json
  const testConfigPath = path.join(require('os').tmpdir(), `test-config-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app, stubs, state, testConfigPath);

  const server = http.createServer(app);
  setupWebSocket(server, state, stubs, { disconnectDelay: 0 });
  screenshotWsModule.setupScreenshotWs(server);
  levelsWsModule.setupLevelsWs(server);

  return { app, server, state, stubs, calls };
}

/**
 * Starts the server on a random port and resolves with the bound port.
 */
function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port));
  });
}

export = { createTestApp, startServer };
