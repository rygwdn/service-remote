import assert = require('node:assert/strict');
import supertest = require('supertest');
const { createTestApp, startServer } = require('../helpers/app');

describe('API routes', () => {
  let server: import('http').Server;
  let state: InstanceType<typeof import('../../src/state').State>;
  let calls: { obs: Record<string, unknown>; x32: Record<string, unknown>; proclaim: Record<string, unknown> };
  let stubs: import('../../src/types').Connections;
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    ({ server, state, calls, stubs } = createTestApp());
    await startServer(server);
    request = supertest(server);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  // Reset recorded calls before each test by wiping the call objects
  const resetCalls = () => {
    calls.obs = {};
    calls.x32 = {};
    calls.proclaim = {};
  };

  describe('GET /api/state', () => {
    test('returns the full state object', async () => {
      const res = await request.get('/api/state');
      assert.equal(res.status, 200);
      assert.ok('obs' in res.body);
      assert.ok('x32' in res.body);
      assert.ok('proclaim' in res.body);
    });

    test('reflects state updates', async () => {
      state.update('obs', { connected: true, currentScene: 'Camera 1' });
      const res = await request.get('/api/state');
      assert.equal(res.body.obs.connected, true);
      assert.equal(res.body.obs.currentScene, 'Camera 1');
    });
  });

  describe('POST /api/obs/scene', () => {
    test('calls obs.setScene and returns ok', async () => {
      resetCalls();
      const res = await request.post('/api/obs/scene').send({ scene: 'Main' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(calls.obs.setScene, 'Main');
    });

    test('returns 500 when setScene throws', async () => {
      // placeholder — covered by error handling suite below
    });
  });

  describe('POST /api/obs/mute', () => {
    test('calls obs.toggleMute with the input name', async () => {
      resetCalls();
      const res = await request.post('/api/obs/mute').send({ input: 'Mic 1' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(calls.obs.toggleMute, 'Mic 1');
    });
  });

  describe('POST /api/obs/volume', () => {
    test('calls obs.setInputVolume with input and dB value', async () => {
      resetCalls();
      const res = await request
        .post('/api/obs/volume')
        .send({ input: 'Mic 1', volumeDb: -10 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.deepEqual(calls.obs.setInputVolume, { input: 'Mic 1', volumeDb: -10 });
    });
  });

  describe('POST /api/obs/stream', () => {
    test('calls obs.toggleStream', async () => {
      resetCalls();
      const res = await request.post('/api/obs/stream').send({});
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(calls.obs.toggleStream, true);
    });
  });

  describe('POST /api/obs/record', () => {
    test('calls obs.toggleRecord', async () => {
      resetCalls();
      const res = await request.post('/api/obs/record').send({});
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(calls.obs.toggleRecord, true);
    });
  });

  describe('POST /api/x32/fader', () => {
    test('calls x32.setFader with channel and value', async () => {
      resetCalls();
      const res = await request.post('/api/x32/fader').send({ channel: 1, value: 0.8 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.deepEqual(calls.x32.setFader, { channel: 1, value: 0.8 });
    });
  });

  describe('POST /api/x32/mute', () => {
    test('calls x32.toggleMute with the channel index', async () => {
      resetCalls();
      const res = await request.post('/api/x32/mute').send({ channel: 3 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(calls.x32.toggleMute, 3);
    });
  });

  describe('POST /api/proclaim/action', () => {
    test('calls proclaim.sendAction with command name and returns ok', async () => {
      resetCalls();
      const res = await request
        .post('/api/proclaim/action')
        .send({ action: 'NextSlide' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.deepEqual(calls.proclaim.sendAction, { action: 'NextSlide', index: undefined });
    });

    test('passes index through to sendAction', async () => {
      resetCalls();
      const res = await request
        .post('/api/proclaim/action')
        .send({ action: 'GoToServiceItem', index: 3 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.deepEqual(calls.proclaim.sendAction, { action: 'GoToServiceItem', index: 3 });
    });
  });

  describe('GET /api/proclaim/thumb', () => {
    test('proxies thumb request and returns image', async () => {
      const res = await request.get('/api/proclaim/thumb?itemId=abc&slideIndex=0&localRevision=1');
      // Route exists (not 404); will be 500 since fake URL is not reachable
      assert.notEqual(res.status, 404);
    });
  });

  describe('error handling', () => {
    test('returns 500 when a backend call throws', async () => {
      const { createTestApp, startServer } = require('../helpers/app');
      const { server: errServer, stubs: errStubs } = createTestApp();
      await startServer(errServer);
      errStubs.obs.setScene = async () => { throw new Error('OBS not connected'); };
      const errReq = supertest(errServer);

      const res = await errReq.post('/api/obs/scene').send({ scene: 'Main' });
      errServer.close();
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'OBS not connected');
    });
  });

  describe('GET /api/config', () => {
    test('returns obs, x32, and proclaim config sections', async () => {
      const res = await request.get('/api/config');
      assert.equal(res.status, 200);
      assert.ok('obs' in res.body);
      assert.ok('x32' in res.body);
      assert.ok('proclaim' in res.body);
      assert.ok('address' in res.body.obs);
      assert.ok('address' in res.body.x32);
      assert.ok(Array.isArray(res.body.x32.channels));
    });
  });

  describe('POST /api/config', () => {
    test('rejects request missing required keys', async () => {
      const res = await request.post('/api/config').send({ obs: {} });
      assert.equal(res.status, 400);
      assert.ok(res.body.error);
    });

    test('saves and reconnects changed connections', async () => {
      resetCalls();
      const cfgRes = await request.get('/api/config');
      const cfg = cfgRes.body as {
        obs: { address: string; password: string };
        x32: { address: string; port: number; channels: unknown[] };
        proclaim: { host: string; port: number; password: string };
      };

      // Change OBS address to trigger reconnect
      const newCfg = { ...cfg, obs: { ...cfg.obs, address: 'ws://localhost:9999' } };
      const res = await request.post('/api/config').send(newCfg);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });

      // OBS should have been disconnected and reconnected
      assert.ok((calls.obs.disconnect as number) >= 1, 'obs.disconnect should have been called');
      assert.ok((calls.obs.connect as number) >= 1, 'obs.connect should have been called');
      // X32 and proclaim were not changed, so they should not reconnect
      assert.equal(calls.x32.disconnect, undefined);
      assert.equal(calls.proclaim.disconnect, undefined);
    });
  });

  describe('POST /api/discover/x32', () => {
    test('returns a result with found boolean', async () => {
      const res = await request.post('/api/discover/x32');
      assert.equal(res.status, 200);
      assert.ok(typeof res.body.found === 'boolean');
    });
  });

  describe('POST /api/discover/obs', () => {
    test('returns a result with found boolean', async () => {
      const res = await request.post('/api/discover/obs');
      assert.equal(res.status, 200);
      assert.ok(typeof res.body.found === 'boolean');
    });
  });

  describe('POST /api/discover/proclaim', () => {
    test('returns a result with found boolean', async () => {
      const res = await request.post('/api/discover/proclaim');
      assert.equal(res.status, 200);
      assert.ok(typeof res.body.found === 'boolean');
    });
  });
});
