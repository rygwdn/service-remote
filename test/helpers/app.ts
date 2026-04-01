import http from 'http';
import path from 'path';
import os from 'os';
import express from 'express';
import { State } from '../../src/state';
import { setupRoutes } from '../../src/routes';
import { setupWebSocket } from '../../src/ws';
import type { Connections } from '../../src/types';
import { setupScreenshotWs } from '../../src/screenshot-ws';
import { setupLevelsWs } from '../../src/levels-ws';
import { setupBusWs } from '../../src/bus-ws';


interface TestCalls {
  obs: {
    connect: number; disconnect: number; startMeterUpdates: number; stopMeterUpdates: number;
    setScene?: string; toggleMute?: string; setInputVolume?: { input: string; volumeDb: number };
    toggleStream?: true; toggleRecord?: true;
  };
  x32: {
    connect: number; disconnect: number; startMeterUpdates: number; stopMeterUpdates: number;
    startBusSendTracking: number; stopBusSendTracking: number;
    setFader?: { channel: number; value: number }; toggleMute?: number;
    setSpill?: { channel: number; type: string; assigned: boolean };
    setBusSend?: { channel: number; busIndex: number; value: number };
  };
  proclaim: {
    connect: number; disconnect: number; startMeterUpdates: number; stopMeterUpdates: number;
    sendAction?: { action: string; index?: number }; goToItem?: string;
  };
  ptz: {
    connect: number; disconnect: number;
    panTilt?: { camera: number; panDir: number; tiltDir: number; panSpeed?: number; tiltSpeed?: number };
    zoom?: { camera: number; direction: string };
    focus?: { camera: number; mode: string };
    preset?: { camera: number; action: string; preset: number };
    home?: number;
  };
}

interface TestApp {
  app: ReturnType<typeof express>;
  server: http.Server;
  state: InstanceType<typeof State>;
  stubs: Connections;
  calls: TestCalls;
}

/**
 * Creates a fresh Express + WebSocket server with stub connection objects.
 * Returns { server, state, stubs, calls }.
 * Call server.close() in afterEach/after to clean up.
 */
function createTestApp(): TestApp {
  const state = new State();

  // Record every call made through the stubs so tests can assert on them.
  const calls: TestCalls = {
    obs:     { connect: 0, disconnect: 0, startMeterUpdates: 0, stopMeterUpdates: 0 },
    x32:     { connect: 0, disconnect: 0, startMeterUpdates: 0, stopMeterUpdates: 0, startBusSendTracking: 0, stopBusSendTracking: 0 },
    proclaim:{ connect: 0, disconnect: 0, startMeterUpdates: 0, stopMeterUpdates: 0 },
    ptz:     { connect: 0, disconnect: 0 },
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
      setSpill: (channel: number, type: 'ch' | 'bus', assigned: boolean) => { calls.x32.setSpill = { channel, type, assigned }; },
      startBusSendTracking: (_busIndex: number) => { calls.x32.startBusSendTracking++; },
      stopBusSendTracking: (_busIndex: number) => { calls.x32.stopBusSendTracking++; },
      setBusSend: (channel: number, busIndex: number, value: number) => { calls.x32.setBusSend = { channel, busIndex, value }; },
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
      getSlideLocalRevision: (_itemId?: string, _slideIndex?: string) => null as string | null,
      getToken: () => 'test-token',
      getOnAirSessionId: () => null,
    },
    ptz: {
      connect: () => { calls.ptz.connect++; },
      disconnect: () => { calls.ptz.disconnect++; },
      panTilt: (camera: number, panDir: number, tiltDir: number, panSpeed?: number, tiltSpeed?: number) => {
        calls.ptz.panTilt = { camera, panDir, tiltDir, panSpeed, tiltSpeed };
      },
      zoom: (camera: number, direction: string) => { calls.ptz.zoom = { camera, direction }; },
      focus: (camera: number, mode: string) => { calls.ptz.focus = { camera, mode }; },
      preset: (camera: number, action: string, preset: number) => { calls.ptz.preset = { camera, action, preset }; },
      home: (camera: number) => { calls.ptz.home = camera; },
    },
  };

  // Use a temp path for config writes during tests to avoid touching real config.json
  const testConfigPath = path.join(os.tmpdir(), `test-config-${Date.now()}.json`);

  const app = express();
  app.use(express.json());
  setupRoutes(app, stubs, state, testConfigPath);

  const server = http.createServer(app);
  setupWebSocket(server, state, stubs, { disconnectDelay: 0 });
  setupScreenshotWs(server);
  setupLevelsWs(server);
  setupBusWs(server, state, stubs.x32, { disconnectDelay: 0 });

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

export { createTestApp, startServer };
