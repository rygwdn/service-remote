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
function rawReq(server: ReturnType<typeof createTestApp>['server'], path: string, body: string, contentType = 'application/json'): Promise<Response> {
  return fetch(`http://localhost:${server.port}${path}`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': contentType },
  });
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
      const newCfg = {
        server: { port: 3000, openBrowser: true },
        obs: { address: 'ws://localhost:9999', password: '', screenshotInterval: 1000 },
        x32: { address: '192.168.1.100', port: 10023 },
        proclaim: { host: '127.0.0.1', port: 52195, password: '', pollInterval: 1000, presentationDbPath: '' },
        ptz: { cameras: [{ name: 'AV-CM20-NDI', enabled: false, address: '192.168.1.101', port: 52381, cameraId: 1, numPresets: 9, panStep: 100, tiltStep: 70, zoomStep: 1000, panRange: [-1700, 1700], tiltRange: [-300, 900], zoomRange: [0, 16384] }] },
        youtube: { broadcastId: '', pollInterval: 30000 },
        ui: { hiddenObs: [], hiddenX32: [] },
      };
      const res = await req(server, 'POST', '/api/config', newCfg);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.ok(calls.obs.disconnect >= 1);
      assert.ok(calls.obs.connect >= 1);
      assert.equal(calls.x32.disconnect, 0);
      assert.equal(calls.proclaim.disconnect, 0);
    });

    test('accepts server.allowedHosts and rejects non-string entries', async () => {
      resetCalls();
      const base = {
        obs: { address: 'ws://localhost:4455', password: '', screenshotInterval: 1000 },
        x32: { address: '192.168.1.100', port: 10023 },
        proclaim: { host: '127.0.0.1', port: 52195, password: '', pollInterval: 1000, presentationDbPath: '' },
        ptz: { cameras: [] },
        youtube: { broadcastId: '', pollInterval: 30000 },
        ui: { hiddenObs: [], hiddenX32: [] },
      };
      const ok = await req(server, 'POST', '/api/config', {
        ...base,
        server: { port: 3000, openBrowser: true, allowedHosts: ['soundroom.tailcb2070.ts.net'] },
      });
      assert.equal(ok.status, 200);

      const bad = await req(server, 'POST', '/api/config', {
        ...base,
        server: { port: 3000, openBrowser: true, allowedHosts: ['soundroom.tailcb2070.ts.net', 42] },
      });
      assert.equal(bad.status, 400);

      const okPath = await req(server, 'POST', '/api/config', {
        ...base,
        server: { port: 3000, openBrowser: true, basePath: '/service' },
      });
      assert.equal(okPath.status, 200);

      const badPath = await req(server, 'POST', '/api/config', {
        ...base,
        server: { port: 3000, openBrowser: true, basePath: 'service/' },
      });
      assert.equal(badPath.status, 400);
    });

    test('reconnects PTZ when camera config changes', async () => {
      resetCalls();
      calls.obs.disconnect = 0; calls.obs.connect = 0;
      calls.x32.disconnect = 0; calls.x32.connect = 0;
      calls.proclaim.disconnect = 0; calls.proclaim.connect = 0;
      calls.ptz.disconnect = 0; calls.ptz.connect = 0;
      const newCfg = {
        server: { port: 3000, openBrowser: true },
        obs: { address: 'ws://localhost:4455', password: '', screenshotInterval: 1000 },
        x32: { address: '192.168.1.100', port: 10023 },
        proclaim: { host: '127.0.0.1', port: 52195, password: '', pollInterval: 1000, presentationDbPath: '' },
        ptz: { cameras: [{ name: 'AV-CM20-NDI', enabled: false, address: '192.168.99.99', port: 52381, cameraId: 1, numPresets: 9, panStep: 100, tiltStep: 70, zoomStep: 1000, panRange: [-1700, 1700], tiltRange: [-300, 900], zoomRange: [0, 16384] }] },
        youtube: { broadcastId: '', pollInterval: 30000 },
        ui: { hiddenObs: [], hiddenX32: [] },
      };
      const res = await req(server, 'POST', '/api/config', newCfg);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
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
    test('rejects caller-supplied OBS config paths and uses the default path', async () => {
      const rejected = await req(server, 'POST', '/api/youtube/import-obs-creds', { obsConfigDir: '/nonexistent/path' });
      assert.equal(rejected.status, 400);
      const rejectedBody = await rejected.json() as { error: string };
      assert.match(rejectedBody.error, /Unexpected fields/);

      const res = await req(server, 'POST', '/api/youtube/import-obs-creds', {});
      assert.equal(res.status, 200);
      const body = await res.json() as { found: boolean };
      assert.equal(typeof body.found, 'boolean');
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
      const res = await req(server, 'POST', '/api/discover/x32', {});
      assert.equal(res.status, 200);
      const body = await res.json() as { found: boolean };
      assert.ok(typeof body.found === 'boolean');
    });
  });

  describe('POST /api/discover/obs', () => {
    test('returns a result with found boolean', async () => {
      const res = await req(server, 'POST', '/api/discover/obs', {});
      assert.equal(res.status, 200);
      const body = await res.json() as { found: boolean };
      assert.ok(typeof body.found === 'boolean');
    });
  });

  describe('POST /api/discover/proclaim', () => {
    test('returns a result with found boolean', async () => {
      const res = await req(server, 'POST', '/api/discover/proclaim', {});
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
      const res = await req(server, 'POST', '/api/ptz/pan-tilt', { camera: 1, panDir: -1, tiltDir: 1 });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(calls.ptz.panTilt?.camera, 1);
      assert.equal(calls.ptz.panTilt?.panDir, -1);
      assert.equal(calls.ptz.panTilt?.tiltDir, 1);
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
  describe('request validation and secret boundaries', () => {
    test('GET /api/config exposes configuration status without secret values', async () => {
      const res = await req(server, 'GET', '/api/config');
      assert.equal(res.status, 200);
      const body = await res.json() as {
        obs: { password?: unknown; passwordConfigured?: unknown };
        proclaim: { password?: unknown; passwordConfigured?: unknown };
        youtube: {
          apiKey?: unknown;
          apiKeyConfigured?: unknown;
          oauth: { clientId?: unknown; clientSecret?: unknown; refreshToken?: unknown };
        };
      };
      assert.equal(body.obs.password, undefined);
      assert.equal(body.proclaim.password, undefined);
      assert.equal(body.youtube.apiKey, undefined);
      assert.equal(body.youtube.oauth.clientId, undefined);
      assert.equal(body.youtube.oauth.clientSecret, undefined);
      assert.equal(body.youtube.oauth.refreshToken, undefined);
      assert.equal(typeof body.obs.passwordConfigured, 'boolean');
      assert.equal(typeof body.proclaim.passwordConfigured, 'boolean');
      assert.equal(typeof body.youtube.apiKeyConfigured, 'boolean');
    });

    test('rejects JSON mutation routes without an application/json content type', async () => {
      resetCalls();
      const res = await rawReq(server, '/api/obs/scene', JSON.stringify({ scene: 'Ignored' }), 'text/plain');
      assert.equal(res.status, 400);
      assert.equal(calls.obs.setScene, undefined);
    });

    test('rejects invalid and non-finite OBS volume values before calling OBS', async () => {
      for (const body of ['{"input":"Mic","volumeDb":-61}', '{"input":"Mic","volumeDb":7}', '{"input":"Mic","volumeDb":null}', '{"input":"Mic","volumeDb":"Infinity"}', '{"input":"Mic","volumeDb":1e999}']) {
        resetCalls();
        const res = await rawReq(server, '/api/obs/volume', body);
        assert.equal(res.status, 400);
        assert.equal(calls.obs.setInputVolume, undefined);
      }
    });

    test('rejects invalid X32 command ranges before calling the mixer', async () => {
      for (const [path, body] of [
        ['/api/x32/fader', { channel: 1, value: -0.01 }],
        ['/api/x32/fader', { channel: 1, value: 1.01 }],
        ['/api/x32/fader', { channel: 0, value: 0.5 }],
        ['/api/x32/mute', { channel: 33 }],
        ['/api/x32/bus-send', { channel: 1, busIndex: 17, value: 0.5 }],
        ['/api/x32/bus-send', { channel: 1, busIndex: 1, value: NaN }],
      ] as Array<[string, Record<string, unknown>]>) {
        resetCalls();
        delete calls.x32.setBusSend;
        const res = await req(server, 'POST', path, body);
        assert.equal(res.status, 400);
        assert.equal(calls.x32.setFader, undefined);
        assert.equal(calls.x32.toggleMute, undefined);
        assert.equal(calls.x32.setBusSend, undefined);
      }
      resetCalls();
      delete calls.x32.setBusSend;
      const nonFinite = await rawReq(server, '/api/x32/bus-send', '{"channel":1,"busIndex":1,"value":1e999}');
      assert.equal(nonFinite.status, 400);
      assert.equal(calls.x32.setBusSend, undefined);
    });

    test('rejects invalid Proclaim actions and indexes before sending commands', async () => {
      for (const body of [
        { action: 'NotACommand' },
        { action: 'GoToSlide' },
        { action: 'GoToServiceItem', index: 0 },
        { action: 'GoToServiceItem', index: 10001 },
        { action: 'NextSlide', index: Infinity },
      ]) {
        resetCalls();
        const res = await req(server, 'POST', '/api/proclaim/action', body);
        assert.equal(res.status, 400);
        assert.equal(calls.proclaim.sendAction, undefined);
      }
      resetCalls();
      const nonFinite = await rawReq(server, '/api/proclaim/action', '{"action":"NextSlide","index":1e999}');
      assert.equal(nonFinite.status, 400);
      assert.equal(calls.proclaim.sendAction, undefined);
    });

    test('rejects poisoned configuration payloads without writing or reconnecting', async () => {
      resetCalls();
      const before = {
        obsConnect: calls.obs.connect,
        obsDisconnect: calls.obs.disconnect,
        x32Connect: calls.x32.connect,
        x32Disconnect: calls.x32.disconnect,
        proclaimConnect: calls.proclaim.connect,
        proclaimDisconnect: calls.proclaim.disconnect,
      };
      const res = await rawReq(server, '/api/config', '{"server":{"port":3000,"openBrowser":true},"obs":{"address":"ws://localhost:4455","password":""},"x32":{"address":"192.168.1.100","port":10023},"proclaim":{"host":"127.0.0.1","port":52195},"ptz":{"cameras":[]},"youtube":{},"ui":{"hiddenObs":[],"hiddenX32":[]},"__proto__":{"obs":{"address":"ws://evil"}}}');
      assert.equal(res.status, 400);
      assert.deepEqual({
        obsConnect: calls.obs.connect,
        obsDisconnect: calls.obs.disconnect,
        x32Connect: calls.x32.connect,
        x32Disconnect: calls.x32.disconnect,
        proclaimConnect: calls.proclaim.connect,
        proclaimDisconnect: calls.proclaim.disconnect,
      }, before);
    });
  });
});
