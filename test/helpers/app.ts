import http = require('http');
import path = require('path');
import express = require('express');
import stateModule = require('../../src/state');
const { setupRoutes } = require('../../src/routes');
const { setupWebSocket } = require('../../src/ws');
import type { Connections } from '../../src/types';

const { State } = stateModule;

interface TestApp {
  app: ReturnType<typeof express>;
  server: http.Server;
  state: InstanceType<typeof stateModule.State>;
  stubs: Connections;
  calls: {
    obs: Record<string, unknown>;
    x32: Record<string, unknown>;
    proclaim: Record<string, unknown>;
  };
}

/**
 * Creates a fresh Express + WebSocket server with stub connection objects.
 * Returns { server, state, stubs, calls }.
 * Call server.close() in afterEach/after to clean up.
 */
function createTestApp(): TestApp {
  const state = new stateModule.State();

  // Record every call made through the stubs so tests can assert on them.
  const calls = {
    obs: {} as Record<string, unknown>,
    x32: {} as Record<string, unknown>,
    proclaim: {} as Record<string, unknown>,
  };

  const stubs: Connections = {
    obs: {
      connect: async () => { calls.obs.connect = (calls.obs.connect as number || 0) as number + 1; },
      disconnect: () => { calls.obs.disconnect = (calls.obs.disconnect as number || 0) as number + 1; },
      setScene: async (scene: string) => { calls.obs.setScene = scene; },
      toggleMute: async (input: string) => { calls.obs.toggleMute = input; },
      setInputVolume: async (input: string, volumeDb: number) => { calls.obs.setInputVolume = { input, volumeDb }; },
      toggleStream: async () => { calls.obs.toggleStream = true; },
      toggleRecord: async () => { calls.obs.toggleRecord = true; },
      getSceneScreenshot: async (_sceneName: string) => Buffer.alloc(0),
    },
    x32: {
      connect: () => { calls.x32.connect = (calls.x32.connect as number || 0) as number + 1; },
      disconnect: () => { calls.x32.disconnect = (calls.x32.disconnect as number || 0) as number + 1; },
      setFader: (channel: number, value: number) => { calls.x32.setFader = { channel, value }; },
      toggleMute: (channel: number) => { calls.x32.toggleMute = channel; },
      parseOscMessage: () => null,
    },
    proclaim: {
      connect: async () => { calls.proclaim.connect = (calls.proclaim.connect as number || 0) as number + 1; },
      disconnect: () => { calls.proclaim.disconnect = (calls.proclaim.disconnect as number || 0) as number + 1; },
      sendAction: async (action: string, index?: number) => {
        calls.proclaim.sendAction = { action, index };
        return true;
      },
      getThumbUrl: (itemId?: string, slideIndex?: string, localRevision?: string) => `/fake-thumb/${itemId}/${slideIndex}`,
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
  setupWebSocket(server, state);

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
