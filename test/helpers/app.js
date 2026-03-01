const http = require('http');
const express = require('express');
const { State } = require('../../src/state');
const { setupRoutes } = require('../../src/routes');
const { setupWebSocket } = require('../../src/ws');

/**
 * Creates a fresh Express + WebSocket server with stub connection objects.
 * Returns { server, state, stubs, calls }.
 * Call server.close() in afterEach/after to clean up.
 */
function createTestApp() {
  const state = new State();

  // Record every call made through the stubs so tests can assert on them.
  const calls = {
    obs: {},
    x32: {},
    proclaim: {},
  };

  const stubs = {
    obs: {
      setScene: async (scene) => { calls.obs.setScene = scene; },
      toggleMute: async (input) => { calls.obs.toggleMute = input; },
      setInputVolume: async (input, volumeDb) => { calls.obs.setInputVolume = { input, volumeDb }; },
      toggleStream: async () => { calls.obs.toggleStream = true; },
      toggleRecord: async () => { calls.obs.toggleRecord = true; },
    },
    x32: {
      setFader: (channel, value) => { calls.x32.setFader = { channel, value }; },
      toggleMute: (channel) => { calls.x32.toggleMute = channel; },
    },
    proclaim: {
      sendAction: async (action, index) => {
        calls.proclaim.sendAction = { action, index };
        return true;
      },
      getThumbUrl: (itemId, slideIndex, localRevision) => `/fake-thumb/${itemId}/${slideIndex}`,
      getToken: () => 'test-token',
    },
  };

  const app = express();
  app.use(express.json());
  setupRoutes(app, stubs, state);

  const server = http.createServer(app);
  setupWebSocket(server, state);

  return { app, server, state, stubs, calls };
}

/**
 * Starts the server on a random port and resolves with the bound port.
 */
function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

module.exports = { createTestApp, startServer };
