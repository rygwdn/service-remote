import assert = require('node:assert/strict');
import supertest = require('supertest');
const { createTestApp, startServer } = require('../helpers/app');

describe('API routes', () => {
  let server: import('http').Server;
  let state: InstanceType<typeof import('../../src/state').State>;
  let calls: ReturnType<typeof import('../helpers/app').createTestApp>['calls'];
  let stubs: import('../../src/types').Connections;
  let request: ReturnType<typeof supertest>;

  beforeAll(async () => {
    ({ server, state, calls, stubs } = createTestApp());
    await startServer(server);
    request = supertest(server);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  // Reset recorded calls before each test
  const resetCalls = () => {
    delete calls.obs.setScene; delete calls.obs.toggleMute; delete calls.obs.setInputVolume;
    delete calls.obs.toggleStream; delete calls.obs.toggleRecord;
    delete calls.x32.setFader; delete calls.x32.toggleMute;
    delete calls.proclaim.sendAction; delete calls.proclaim.goToItem;
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

    test('returns 204 when Proclaim responds with JSON instead of an image (no completionEstimateMs)', async () => {
      // Override getThumbUrl on a fresh test app stub, and mock globalThis.fetch
      // to return a JSON response (simulating Proclaim not-ready response).
      const { createTestApp, startServer } = require('../helpers/app');
      const { server: thumbServer, stubs: thumbStubs } = createTestApp();
      thumbStubs.proclaim.getThumbUrl = () => 'http://fake-proclaim/thumb';
      thumbStubs.proclaim.getSlideLocalRevision = () => null;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: async () => '{}',
        arrayBuffer: async () => new ArrayBuffer(0),
      })) as unknown as typeof fetch;

      await startServer(thumbServer);
      const thumbReq = supertest(thumbServer);

      let res: import('supertest').Response;
      try {
        res = await thumbReq.get('/api/proclaim/thumb?itemId=abc&slideIndex=0');
      } finally {
        thumbServer.close();
        globalThis.fetch = originalFetch;
      }

      assert.equal(res!.status, 204);
    });

    test('waits for completionEstimateMs and retries when Proclaim returns JSON with estimate', async () => {
      const { createTestApp, startServer } = require('../helpers/app');
      const { server: thumbServer, stubs: thumbStubs } = createTestApp();
      thumbStubs.proclaim.getThumbUrl = () => 'http://fake-proclaim/thumb';
      thumbStubs.proclaim.getSlideLocalRevision = () => null;

      let callCount = 0;
      const originalFetch = globalThis.fetch;
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      globalThis.fetch = (async (_url: string) => {
        callCount++;
        if (callCount === 1) {
          // First call: return JSON with completionEstimateMs
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            text: async () => JSON.stringify({ completionEstimateMs: 50 }),
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        // Second call: return an image
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'image/png' }),
          text: async () => '',
          arrayBuffer: async () => imageBuffer.buffer,
        };
      }) as unknown as typeof fetch;

      await startServer(thumbServer);
      const thumbReq = supertest(thumbServer);

      let res: import('supertest').Response;
      try {
        res = await thumbReq.get('/api/proclaim/thumb?itemId=abc&slideIndex=0');
      } finally {
        thumbServer.close();
        globalThis.fetch = originalFetch;
      }

      assert.equal(res!.status, 200);
      assert.ok(res!.headers['content-type']?.startsWith('image/'));
      assert.ok(callCount >= 2, `Expected at least 2 fetch calls, got ${callCount}`);
    });

    test('serves cached image on second request with same localRevision', async () => {
      const { createTestApp, startServer } = require('../helpers/app');
      const { server: thumbServer, stubs: thumbStubs } = createTestApp();
      thumbStubs.proclaim.getThumbUrl = () => 'http://fake-proclaim/thumb';
      thumbStubs.proclaim.getSlideLocalRevision = () => 'rev-42';

      let fetchCount = 0;
      const originalFetch = globalThis.fetch;
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      globalThis.fetch = (async (_url: string) => {
        fetchCount++;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'image/png' }),
          text: async () => '',
          arrayBuffer: async () => imageBuffer.buffer,
        };
      }) as unknown as typeof fetch;

      await startServer(thumbServer);
      const thumbReq = supertest(thumbServer);

      let res1: import('supertest').Response;
      let res2: import('supertest').Response;
      try {
        res1 = await thumbReq.get('/api/proclaim/thumb?itemId=abc&slideIndex=0&localRevision=rev-42');
        res2 = await thumbReq.get('/api/proclaim/thumb?itemId=abc&slideIndex=0&localRevision=rev-42');
      } finally {
        thumbServer.close();
        globalThis.fetch = originalFetch;
      }

      assert.equal(res1!.status, 200);
      assert.equal(res2!.status, 200);
      assert.equal(fetchCount, 1, 'Should only fetch from Proclaim once (second served from cache)');
    });

    test('sets immutable Cache-Control header when localRevision is known', async () => {
      const { createTestApp, startServer } = require('../helpers/app');
      const { server: thumbServer, stubs: thumbStubs } = createTestApp();
      thumbStubs.proclaim.getThumbUrl = () => 'http://fake-proclaim/thumb';
      thumbStubs.proclaim.getSlideLocalRevision = () => 'rev-99';

      const originalFetch = globalThis.fetch;
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      globalThis.fetch = (async (_url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'image/png' }),
        text: async () => '',
        arrayBuffer: async () => imageBuffer.buffer,
      })) as unknown as typeof fetch;

      await startServer(thumbServer);
      const thumbReq = supertest(thumbServer);

      let res: import('supertest').Response;
      try {
        res = await thumbReq.get('/api/proclaim/thumb?itemId=abc&slideIndex=0&localRevision=rev-99');
      } finally {
        thumbServer.close();
        globalThis.fetch = originalFetch;
      }

      assert.equal(res!.status, 200);
      assert.ok(
        res!.headers['cache-control']?.includes('immutable'),
        `Expected immutable cache-control, got: ${res!.headers['cache-control']}`
      );
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
        x32: { address: string; port: number };
        proclaim: { host: string; port: number; password: string };
      };

      // Change OBS address to trigger reconnect
      const newCfg = { ...cfg, obs: { ...cfg.obs, address: 'ws://localhost:9999' } };
      const res = await request.post('/api/config').send(newCfg);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });

      // OBS should have been disconnected and reconnected
      assert.ok(calls.obs.disconnect >= 1, 'obs.disconnect should have been called');
      assert.ok(calls.obs.connect >= 1, 'obs.connect should have been called');
      // X32 and proclaim were not changed, so they should not reconnect
      assert.equal(calls.x32.disconnect, 0);
      assert.equal(calls.proclaim.disconnect, 0);
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

  describe('GET /api/logs', () => {
    test('returns a logs array', async () => {
      const res = await request.get('/api/logs');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.logs));
    });

    test('log entries have ts, level, and msg fields', async () => {
      // Trigger a log entry via an API call
      await request.post('/api/obs/scene').send({ scene: 'TestScene' });
      const res = await request.get('/api/logs');
      assert.equal(res.status, 200);
      // There may be entries from other tests; just check the shape if any exist
      if (res.body.logs.length > 0) {
        const entry = res.body.logs[0];
        assert.ok(typeof entry.ts === 'string');
        assert.ok(['info', 'warn', 'error'].includes(entry.level));
        assert.ok(typeof entry.msg === 'string');
      }
    });
  });

  describe('GET /api/server/addresses', () => {
    test('returns port and addresses array', async () => {
      const res = await request.get('/api/server/addresses');
      assert.equal(res.status, 200);
      assert.ok(typeof res.body.port === 'number');
      assert.ok(Array.isArray(res.body.addresses));
    });

    test('always includes localhost address', async () => {
      const res = await request.get('/api/server/addresses');
      const addresses: string[] = res.body.addresses;
      assert.ok(addresses.some((a) => a.startsWith('http://localhost:')));
    });

    test('all addresses are http URLs ending with the server port', async () => {
      const res = await request.get('/api/server/addresses');
      const port: number = res.body.port;
      for (const addr of res.body.addresses as string[]) {
        assert.ok(addr.startsWith('http://'), `${addr} should start with http://`);
        assert.ok(addr.endsWith(`:${port}`), `${addr} should end with :${port}`);
      }
    });
  });

  describe('GET /api/server/qr', () => {
    test('returns SVG for a valid url param', async () => {
      const res = await request.get('/api/server/qr?url=http%3A%2F%2Flocalhost%3A3000')
        .buffer(true).parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => callback(null, data));
        });
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type']?.includes('svg'));
      assert.ok((res.body as string).includes('<svg'));
    });

    test('returns 400 when url param is missing', async () => {
      const res = await request.get('/api/server/qr');
      assert.equal(res.status, 400);
    });
  });
});
