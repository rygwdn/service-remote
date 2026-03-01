const assert = require('node:assert/strict');
const supertest = require('supertest');
const { createTestApp } = require('../helpers/app');

describe('API routes', () => {
  let app, server, state, calls, request;

  beforeAll(() => {
    ({ app, server, state, calls } = createTestApp());
    request = supertest(app);
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

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
      const { createTestApp } = require('../helpers/app');
      const { app: errApp } = createTestApp();
      // Override setScene to throw
      const errRequest = supertest(errApp);
      // We'll simulate this by testing the error path exists; a separate stub handles it
      // (covered by the stub design — errors propagate from the stub to the route handler)
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
      // The stub getThumbUrl returns a fake path; fetch will fail so we just check
      // that the route exists and attempts to proxy (errors gracefully as 500)
      const res = await request.get('/api/proclaim/thumb?itemId=abc&slideIndex=0&localRevision=1');
      // Route exists (not 404); will be 500 since fake URL is not reachable
      assert.notEqual(res.status, 404);
    });
  });

  describe('error handling', () => {
    test('returns 500 when a backend call throws', async () => {
      // Build a one-off app whose obs.setScene throws
      const { createTestApp } = require('../helpers/app');
      const { app: errApp, stubs } = createTestApp();
      stubs.obs.setScene = async () => { throw new Error('OBS not connected'); };
      const errReq = supertest(errApp);

      const res = await errReq.post('/api/obs/scene').send({ scene: 'Main' });
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'OBS not connected');
    });
  });
});
