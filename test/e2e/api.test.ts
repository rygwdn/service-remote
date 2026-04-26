import assert from 'node:assert/strict';
import { createTestApp } from '../helpers/app';

// Helper: fetch against the test server
function req(server: ReturnType<typeof createTestApp>['server'], method: string, path: string, body?: unknown): Promise<Response> {
  const url = `http://localhost:${server.port}${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return fetch(url, init);
}

describe('API routes', () => {
  let server: ReturnType<typeof createTestApp>['server'];
  let state: ReturnType<typeof createTestApp>['state'];
  let calls: ReturnType<typeof createTestApp>['calls'];
  let stubs: ReturnType<typeof createTestApp>['stubs'];

  beforeAll(() => {
    ({ server, state, calls, stubs } = createTestApp());
  });

  afterAll(() => server.stop(true));

  const resetCalls = () => {
    delete calls.obs.setScene; delete calls.obs.toggleMute; delete calls.obs.setInputVolume;
    delete calls.obs.toggleStream; delete calls.obs.toggleRecord;
    delete calls.x32.setFader; delete calls.x32.toggleMute;
    delete calls.proclaim.sendAction; delete calls.proclaim.goToItem;
    delete calls.ptz.panTilt; delete calls.ptz.zoom; delete calls.ptz.focus;
    delete calls.ptz.preset; delete calls.ptz.home;
  };

  describe('GET /api/state', () => {
    test('returns the full state object', async () => {
      const res = await req(server, 'GET', '/api/state');
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.ok('obs' in body);
      assert.ok('x32' in body);
      assert.ok('proclaim' in body);
      assert.ok('ptz' in body);
      assert.ok('youtube' in body);
    });

    test('reflects state updates', async () => {
      state.update('obs', { connected: true, currentScene: 'Camera 1' });
      const res = await req(server, 'GET', '/api/state');
      const body = await res.json() as { obs: { connected: boolean; currentScene: string } };
      assert.equal(body.obs.connected, true);
      assert.equal(body.obs.currentScene, 'Camera 1');
    });
  });

  describe('POST /api/obs/scene', () => {
    test('calls obs.setScene and returns ok', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/obs/scene', { scene: 'Main' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.obs.setScene, 'Main');
    });
  });

  describe('POST /api/obs/mute', () => {
    test('calls obs.toggleMute with the input name', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/obs/mute', { input: 'Mic 1' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.obs.toggleMute, 'Mic 1');
    });
  });

  describe('POST /api/obs/volume', () => {
    test('calls obs.setInputVolume with input and dB value', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/obs/volume', { input: 'Mic 1', volumeDb: -10 });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(calls.obs.setInputVolume, { input: 'Mic 1', volumeDb: -10 });
    });
  });

  describe('POST /api/obs/stream', () => {
    test('calls obs.toggleStream', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/obs/stream', {});
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.obs.toggleStream, true);
    });
  });

  describe('POST /api/obs/record', () => {
    test('calls obs.toggleRecord', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/obs/record', {});
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.obs.toggleRecord, true);
    });
  });

  describe('POST /api/x32/fader', () => {
    test('calls x32.setFader with channel and value', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/x32/fader', { channel: 1, value: 0.8 });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(calls.x32.setFader, { channel: 1, value: 0.8 });
    });
  });

  describe('POST /api/x32/mute', () => {
    test('calls x32.toggleMute with the channel index', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/x32/mute', { channel: 3 });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.x32.toggleMute, 3);
    });
  });

  describe('POST /api/x32/spill', () => {
    test('calls x32.setSpill to assign a channel to DCA 8', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/x32/spill', { channel: 5, type: 'ch', assigned: true });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(calls.x32.setSpill, { channel: 5, type: 'ch', assigned: true });
    });

    test('calls x32.setSpill to unassign a bus from DCA 8', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/x32/spill', { channel: 2, type: 'bus', assigned: false });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(calls.x32.setSpill, { channel: 2, type: 'bus', assigned: false });
    });

    test('defaults type to ch when not specified', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/x32/spill', { channel: 3, assigned: true });
      assert.equal(res.status, 200);
      assert.deepEqual(calls.x32.setSpill, { channel: 3, type: 'ch', assigned: true });
    });
  });

  describe('POST /api/x32/bus-send', () => {
    test('calls x32.setBusSend with channel, busIndex, and value', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/x32/bus-send', { channel: 3, busIndex: 8, value: 0.7 });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(calls.x32.setBusSend, { channel: 3, busIndex: 8, value: 0.7 });
    });

    test('returns 400 when busIndex is missing', async () => {
      const res = await req(server, 'POST', '/api/x32/bus-send', { channel: 1, value: 0.5 });
      assert.equal(res.status, 400);
    });

    test('returns 400 when value is missing', async () => {
      const res = await req(server, 'POST', '/api/x32/bus-send', { channel: 1, busIndex: 8 });
      assert.equal(res.status, 400);
    });
  });

  describe('POST /api/proclaim/action', () => {
    test('calls proclaim.sendAction with command name and returns ok', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/proclaim/action', { action: 'NextSlide' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(calls.proclaim.sendAction, { action: 'NextSlide', index: undefined });
    });

    test('passes index through to sendAction', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/proclaim/action', { action: 'GoToServiceItem', index: 3 });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(calls.proclaim.sendAction, { action: 'GoToServiceItem', index: 3 });
    });
  });

  describe('GET /api/proclaim/thumb', () => {
    test('route exists (not 404)', async () => {
      const res = await req(server, 'GET', '/api/proclaim/thumb?itemId=abc&slideIndex=0&localRevision=1');
      assert.notEqual(res.status, 404);
    });

    test('returns 204 when Proclaim responds with JSON and no completionEstimateMs', async () => {
      const { server: s2, stubs: s2stubs } = createTestApp();
      s2stubs.proclaim.getThumbUrl = () => 'http://fake-proclaim/thumb';
      s2stubs.proclaim.getSlideLocalRevision = () => null;
      const realFetch = globalThis.fetch;
      const mockReply = { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(0) };
      globalThis.fetch = (async (url: string) => url.startsWith('http://fake-proclaim') ? mockReply : realFetch(url)) as unknown as typeof fetch;
      try {
        const res = await realFetch(`http://localhost:${s2.port}/api/proclaim/thumb?itemId=abc&slideIndex=0`);
        assert.equal(res.status, 204);
      } finally { globalThis.fetch = realFetch; s2.stop(true); }
    });

    test('waits for completionEstimateMs and retries when Proclaim returns JSON with estimate', async () => {
      const { server: s2, stubs: s2stubs } = createTestApp();
      s2stubs.proclaim.getThumbUrl = () => 'http://fake-proclaim/thumb';
      s2stubs.proclaim.getSlideLocalRevision = () => null;
      let callCount = 0;
      const realFetch = globalThis.fetch;
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      globalThis.fetch = (async (url: string) => {
        if (!url.startsWith('http://fake-proclaim')) return realFetch(url);
        callCount++;
        if (callCount === 1) return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), text: async () => JSON.stringify({ completionEstimateMs: 50 }), arrayBuffer: async () => new ArrayBuffer(0) };
        return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'image/png' }), text: async () => '', arrayBuffer: async () => imageBuffer.buffer };
      }) as unknown as typeof fetch;
      try {
        const res = await realFetch(`http://localhost:${s2.port}/api/proclaim/thumb?itemId=abc&slideIndex=0`);
        assert.equal(res.status, 200);
        assert.ok(callCount >= 2);
      } finally { globalThis.fetch = realFetch; s2.stop(true); }
    });

    test('serves cached image on second request with same localRevision', async () => {
      const { server: s2, stubs: s2stubs } = createTestApp();
      s2stubs.proclaim.getThumbUrl = () => 'http://fake-proclaim/thumb';
      s2stubs.proclaim.getSlideLocalRevision = () => 'rev-42';
      let fetchCount = 0;
      const realFetch = globalThis.fetch;
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      globalThis.fetch = (async (url: string) => {
        if (!url.startsWith('http://fake-proclaim')) return realFetch(url);
        fetchCount++;
        return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'image/png' }), text: async () => '', arrayBuffer: async () => imageBuffer.buffer };
      }) as unknown as typeof fetch;
      try {
        const thumbUrl = `http://localhost:${s2.port}/api/proclaim/thumb?itemId=abc&slideIndex=0&localRevision=rev-42`;
        const r1 = await realFetch(thumbUrl); const afterR1 = fetchCount;
        const r2 = await realFetch(thumbUrl);
        assert.equal(r1.status, 200); assert.equal(r2.status, 200);
        assert.ok(afterR1 >= 1);
        assert.equal(fetchCount, afterR1, 'second request served from cache');
      } finally { globalThis.fetch = realFetch; s2.stop(true); }
    });

    test('sets immutable Cache-Control header when localRevision is known', async () => {
      const { server: s2, stubs: s2stubs } = createTestApp();
      s2stubs.proclaim.getThumbUrl = () => 'http://fake-proclaim/thumb';
      s2stubs.proclaim.getSlideLocalRevision = () => 'rev-99';
      const realFetch = globalThis.fetch;
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      globalThis.fetch = (async (url: string) => {
        if (!url.startsWith('http://fake-proclaim')) return realFetch(url);
        return { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'image/png' }), text: async () => '', arrayBuffer: async () => imageBuffer.buffer };
      }) as unknown as typeof fetch;
      try {
        const res = await realFetch(`http://localhost:${s2.port}/api/proclaim/thumb?itemId=abc&slideIndex=0&localRevision=rev-99`);
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('cache-control')?.includes('immutable'));
      } finally { globalThis.fetch = realFetch; s2.stop(true); }
    });
  });

  describe('error handling', () => {
    test('returns 500 when a backend call throws', async () => {
      const { server: s2, stubs: s2stubs } = createTestApp();
      s2stubs.obs.setScene = async () => { throw new Error('OBS not connected'); };
      const res = await fetch(`http://localhost:${s2.port}/api/obs/scene`, { method: 'POST', body: JSON.stringify({ scene: 'Main' }), headers: { 'Content-Type': 'application/json' } });
      s2.stop(true);
      assert.equal(res.status, 500);
      const body = await res.json() as { error: string };
      assert.equal(body.error, 'OBS not connected');
    });
  });

  describe('GET /api/config', () => {
    test('returns obs, x32, proclaim, and youtube config sections', async () => {
      const res = await req(server, 'GET', '/api/config');
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.ok('obs' in body); assert.ok('x32' in body);
      assert.ok('proclaim' in body); assert.ok('youtube' in body);
      assert.ok('address' in (body.obs as Record<string, unknown>));
      assert.ok('address' in (body.x32 as Record<string, unknown>));
      assert.ok('broadcastId' in (body.youtube as Record<string, unknown>));
    });
  });

  describe('POST /api/config', () => {
    test('rejects request missing required keys', async () => {
      const res = await req(server, 'POST', '/api/config', { obs: {} });
      assert.equal(res.status, 400);
      const body = await res.json() as { error: string };
      assert.ok(body.error);
    });

    test('saves and reconnects changed connections', async () => {
      resetCalls();
      const cfgRes = await req(server, 'GET', '/api/config');
      const cfg = await cfgRes.json() as { obs: { address: string; password: string }; x32: { address: string; port: number }; proclaim: { host: string; port: number; password: string } };
      const newCfg = { ...cfg, obs: { ...cfg.obs, address: 'ws://localhost:9999' } };
      const res = await req(server, 'POST', '/api/config', newCfg);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.ok(calls.obs.disconnect >= 1);
      assert.ok(calls.obs.connect >= 1);
      assert.equal(calls.x32.disconnect, 0);
      assert.equal(calls.proclaim.disconnect, 0);
    });

    test('reconnects PTZ when camera config changes', async () => {
      resetCalls();
      calls.obs.disconnect = 0; calls.obs.connect = 0;
      calls.x32.disconnect = 0; calls.x32.connect = 0;
      calls.proclaim.disconnect = 0; calls.proclaim.connect = 0;
      calls.ptz.disconnect = 0; calls.ptz.connect = 0;
      const cfgRes = await req(server, 'GET', '/api/config');
      const cfg = await cfgRes.json() as { ptz: { cameras: object[] } };
      const newCameras = [{ ...(cfg.ptz.cameras[0] ?? {}), address: '192.168.99.99' }];
      const res = await req(server, 'POST', '/api/config', { ...cfg, ptz: { cameras: newCameras } });
      assert.equal(res.status, 200);
      assert.ok(calls.ptz.disconnect >= 1);
      assert.ok(calls.ptz.connect >= 1);
      assert.equal(calls.obs.disconnect, 0);
      assert.equal(calls.x32.disconnect, 0);
      assert.equal(calls.proclaim.disconnect, 0);
    });
  });

  describe('POST /api/youtube/start', () => {
    test('returns 500 with error message when OAuth not configured', async () => {
      const res = await req(server, 'POST', '/api/youtube/start', {});
      assert.equal(res.status, 500);
      const body = await res.json() as { error: string };
      assert.ok(body.error);
    });
  });

  describe('POST /api/youtube/stop', () => {
    test('returns 500 with error message when OAuth not configured', async () => {
      const res = await req(server, 'POST', '/api/youtube/stop', {});
      assert.equal(res.status, 500);
      const body = await res.json() as { error: string };
      assert.ok(body.error);
    });
  });

  describe('POST /api/youtube/import-obs-creds', () => {
    test('returns found: false when OBS config not found', async () => {
      const res = await req(server, 'POST', '/api/youtube/import-obs-creds', { obsConfigDir: '/nonexistent/path' });
      assert.equal(res.status, 200);
      const body = await res.json() as { found: boolean };
      assert.equal(body.found, false);
    });
  });

  describe('GET /api/youtube/broadcasts', () => {
    test('returns 500 with error when no OAuth token available', async () => {
      const res = await req(server, 'GET', '/api/youtube/broadcasts');
      assert.equal(res.status, 500);
      const body = await res.json() as { error: string };
      assert.ok(body.error);
    });
  });

  describe('POST /api/discover/x32', () => {
    test('returns a result with found boolean', async () => {
      const res = await req(server, 'POST', '/api/discover/x32');
      assert.equal(res.status, 200);
      const body = await res.json() as { found: boolean };
      assert.ok(typeof body.found === 'boolean');
    });
  });

  describe('POST /api/discover/obs', () => {
    test('returns a result with found boolean', async () => {
      const res = await req(server, 'POST', '/api/discover/obs');
      assert.equal(res.status, 200);
      const body = await res.json() as { found: boolean };
      assert.ok(typeof body.found === 'boolean');
    });
  });

  describe('POST /api/discover/proclaim', () => {
    test('returns a result with found boolean', async () => {
      const res = await req(server, 'POST', '/api/discover/proclaim');
      assert.equal(res.status, 200);
      const body = await res.json() as { found: boolean };
      assert.ok(typeof body.found === 'boolean');
    });
  });

  describe('GET /api/logs', () => {
    test('returns a logs array', async () => {
      const res = await req(server, 'GET', '/api/logs');
      assert.equal(res.status, 200);
      const body = await res.json() as { logs: unknown[] };
      assert.ok(Array.isArray(body.logs));
    });

    test('log entries have ts, level, and msg fields', async () => {
      await req(server, 'POST', '/api/obs/scene', { scene: 'TestScene' });
      const res = await req(server, 'GET', '/api/logs');
      const body = await res.json() as { logs: Array<{ ts: string; level: string; msg: string }> };
      if (body.logs.length > 0) {
        const entry = body.logs[0];
        assert.ok(typeof entry.ts === 'string');
        assert.ok(['info', 'warn', 'error'].includes(entry.level));
        assert.ok(typeof entry.msg === 'string');
      }
    });
  });

  describe('GET /api/server/addresses', () => {
    test('returns port and addresses array', async () => {
      const res = await req(server, 'GET', '/api/server/addresses');
      assert.equal(res.status, 200);
      const body = await res.json() as { port: number; addresses: string[] };
      assert.ok(typeof body.port === 'number');
      assert.ok(Array.isArray(body.addresses));
    });

    test('always includes localhost address', async () => {
      const res = await req(server, 'GET', '/api/server/addresses');
      const body = await res.json() as { addresses: string[] };
      assert.ok(body.addresses.some((a) => a.startsWith('http://localhost:')));
    });
  });

  describe('POST /api/ptz/pan-tilt', () => {
    test('calls ptz.panTilt and returns ok', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/ptz/pan-tilt', { panDir: 1, tiltDir: 0, panSpeed: 8 });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.ptz.panTilt?.camera, 0);
      assert.equal(calls.ptz.panTilt?.panDir, 1);
      assert.equal(calls.ptz.panTilt?.panSpeed, 8);
    });

    test('passes explicit camera index', async () => {
      resetCalls();
      await req(server, 'POST', '/api/ptz/pan-tilt', { camera: 1, panDir: -1, tiltDir: 1 });
      assert.equal(calls.ptz.panTilt?.camera, 1);
    });
  });

  describe('POST /api/ptz/zoom', () => {
    test('calls ptz.zoom and returns ok', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/ptz/zoom', { direction: 'in' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.ptz.zoom?.direction, 'in');
    });
  });

  describe('POST /api/ptz/focus', () => {
    test('calls ptz.focus and returns ok', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/ptz/focus', { mode: 'auto' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.ptz.focus?.mode, 'auto');
    });
  });

  describe('POST /api/ptz/preset', () => {
    test('calls ptz.preset and returns ok', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/ptz/preset', { action: 'recall', preset: 3 });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(calls.ptz.preset, { camera: 0, action: 'recall', preset: 3 });
    });
  });

  describe('POST /api/ptz/home', () => {
    test('calls ptz.home and returns ok', async () => {
      resetCalls();
      const res = await req(server, 'POST', '/api/ptz/home', {});
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.ptz.home, 0);
    });
  });

  describe('GET /api/server/qr', () => {
    test('returns SVG for a valid url param', async () => {
      const res = await req(server, 'GET', '/api/server/qr?url=http%3A%2F%2Flocalhost%3A3000');
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('svg'));
      const body = await res.text();
      assert.ok(body.includes('<svg'));
    });

    test('returns 400 when url param is missing', async () => {
      const res = await req(server, 'GET', '/api/server/qr');
      assert.equal(res.status, 400);
    });
  });
});
