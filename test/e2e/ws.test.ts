import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { createTestApp } from '../helpers/app';
import { setupWebSocket } from '../../src/ws';
import { State } from '../../src/state';
import type { SocketData } from '../../src/ws';


type TestServer = ReturnType<typeof createTestApp>['server'];

// Connect to /ws and wait for the initial state message (auto-subscribed to 'state')
function connectAndReceive(server: TestServer): Promise<{ ws: WebSocket; data: { type: string; data: Record<string, unknown> } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    ws.addEventListener('message', (e) => {
      resolve({ ws, data: JSON.parse(e.data as string) as { type: string; data: Record<string, unknown> } });
    }, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
  });
}

function nextMessage(ws: WebSocket): Promise<{ type: string; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (e) => resolve(JSON.parse(e.data as string) as { type: string; data: Record<string, unknown> }), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.addEventListener('close', () => resolve(), { once: true });
    ws.close();
  });
}

describe('WebSocket', () => {
  let server: TestServer;
  let state: ReturnType<typeof createTestApp>['state'];

  beforeAll(() => {
    ({ server, state } = createTestApp());
  });

  afterAll(() => server.stop(true));

  test('new client receives full state immediately on connect', async () => {
    const { ws, data } = await connectAndReceive(server);
    ws.close();
    assert.equal(data.type, 'state');
    assert.ok('obs' in data.data);
    assert.ok('x32' in data.data);
    assert.ok('proclaim' in data.data);
  });

  test('state update is broadcast to connected client', async () => {
    const { ws } = await connectAndReceive(server);
    const updatePromise = nextMessage(ws);
    state.update('obs', { connected: true, currentScene: 'Camera 2' });
    const update = await updatePromise;
    ws.close();
    assert.equal(update.type, 'state');
    assert.equal((update.data as any).obs.connected, true);
    assert.equal((update.data as any).obs.currentScene, 'Camera 2');
  });

  test('broadcast reaches all connected clients', async () => {
    const [c1, c2] = await Promise.all([connectAndReceive(server), connectAndReceive(server)]);
    const p1 = nextMessage(c1.ws);
    const p2 = nextMessage(c2.ws);
    state.update('x32', { connected: true });
    const [m1, m2] = await Promise.all([p1, p2]);
    c1.ws.close(); c2.ws.close();
    assert.equal((m1.data as any).x32.connected, true);
    assert.equal((m2.data as any).x32.connected, true);
  });

  test('late-connecting client receives the current (updated) state', async () => {
    state.update('proclaim', { connected: true });
    const { ws, data } = await connectAndReceive(server);
    ws.close();
    assert.equal((data.data as any).proclaim.connected, true);
  });
});

describe('WebSocket meter subscription lifecycle', () => {
  test('startMeterUpdates is called when the first client connects', async () => {
    const { server: s, calls } = createTestApp();
    const { ws } = await connectAndReceive(s);
    assert.equal(calls.x32.startMeterUpdates, 1);
    await waitForClose(ws);
    s.stop(true);
  });

  test('startMeterUpdates is NOT called again when a second client connects', async () => {
    const { server: s, calls } = createTestApp();
    const { ws: ws1 } = await connectAndReceive(s);
    const { ws: ws2 } = await connectAndReceive(s);
    assert.equal(calls.x32.startMeterUpdates, 1);
    await waitForClose(ws1); await waitForClose(ws2);
    s.stop(true);
  });

  test('stopMeterUpdates is called when the last client disconnects', async () => {
    const { server: s, calls } = createTestApp();
    const { ws } = await connectAndReceive(s);
    await waitForClose(ws);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.x32.stopMeterUpdates, 1);
    s.stop(true);
  });

  test('stopMeterUpdates is NOT called while other clients remain connected', async () => {
    const { server: s, calls } = createTestApp();
    const { ws: ws1 } = await connectAndReceive(s);
    const { ws: ws2 } = await connectAndReceive(s);
    await waitForClose(ws1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.x32.stopMeterUpdates, 0);
    await waitForClose(ws2);
    s.stop(true);
  });

  test('x32 is NOT stopped when main ws client leaves but bus-mix clients remain', async () => {
    const { server: s, calls } = createTestApp();
    const { ws: mainWs } = await connectAndReceive(s);

    // Open a bus subscription on the same unified WS
    const busWs = new WebSocket(`ws://localhost:${s.port}/ws`);
    await new Promise<void>((resolve) => busWs.addEventListener('message', () => resolve(), { once: true }));
    busWs.send(JSON.stringify({ type: 'subscribe', channels: ['bus:8'] }));
    await new Promise((r) => setTimeout(r, 20));

    await waitForClose(mainWs);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(calls.x32.disconnect, 0);
    assert.equal(calls.x32.stopMeterUpdates, 0);

    busWs.close();
    s.stop(true);
  });
});

describe('WebSocket level stripping', () => {
  let server: TestServer;
  let state: ReturnType<typeof createTestApp>['state'];

  beforeAll(() => {
    ({ server, state } = createTestApp());
  });

  afterAll(() => server.stop(true));

  test('initial state broadcast does not include level on audioSources', async () => {
    state.update('obs', { audioSources: [{ name: 'Mic 1', volume: -10, muted: false, live: true, level: 0.75 }] });
    const { ws, data } = await connectAndReceive(server);
    ws.close();
    const sources = (data.data as any).obs.audioSources as Array<Record<string, unknown>>;
    assert.ok(sources.length > 0);
    assert.equal(sources[0].level, undefined);
  });

  test('initial state broadcast does not include level on x32 channels', async () => {
    state.update('x32', { channels: [{ index: 1, type: 'ch', label: 'Vocals', fader: 0.8, muted: false, level: 0.5, source: 1, linkedToNext: false, spill: false, color: 0 }] });
    const { ws, data } = await connectAndReceive(server);
    ws.close();
    const channels = (data.data as any).x32.channels as Array<Record<string, unknown>>;
    assert.ok(channels.length > 0);
    assert.equal(channels[0].level, undefined);
  });

  test('state update broadcast does not include level on audioSources', async () => {
    const { ws } = await connectAndReceive(server);
    const updatePromise = nextMessage(ws);
    state.update('obs', { audioSources: [{ name: 'Mic 2', volume: -5, muted: false, live: true, level: 0.9 }] });
    const update = await updatePromise;
    ws.close();
    const sources = (update.data as any).obs.audioSources as Array<Record<string, unknown>>;
    assert.ok(sources.length > 0);
    assert.equal(sources[0].level, undefined);
  });

  test('state update broadcast does not include level on x32 channels', async () => {
    const { ws } = await connectAndReceive(server);
    const updatePromise = nextMessage(ws);
    state.update('x32', { channels: [{ index: 2, type: 'ch', label: 'Guitar', fader: 0.6, muted: false, level: 0.3, source: 2, linkedToNext: false, spill: false, color: 0 }] });
    const update = await updatePromise;
    ws.close();
    const channels = (update.data as any).x32.channels as Array<Record<string, unknown>>;
    assert.ok(channels.length > 0);
    assert.equal(channels[0].level, undefined);
  });
});

describe('WebSocket connection lifecycle', () => {
  test('all connections are started when the first client connects', async () => {
    const { server: s, calls } = createTestApp();
    const { ws } = await connectAndReceive(s);
    assert.equal(calls.obs.connect, 1);
    assert.equal(calls.x32.connect, 1);
    assert.equal(calls.proclaim.connect, 1);
    await waitForClose(ws);
    s.stop(true);
  });

  test('connections are NOT started again when a second client connects', async () => {
    const { server: s, calls } = createTestApp();
    const { ws: ws1 } = await connectAndReceive(s);
    const { ws: ws2 } = await connectAndReceive(s);
    assert.equal(calls.obs.connect, 1);
    assert.equal(calls.x32.connect, 1);
    assert.equal(calls.proclaim.connect, 1);
    await waitForClose(ws1); await waitForClose(ws2);
    s.stop(true);
  });

  test('all connections are stopped when the last client disconnects', async () => {
    const { server: s, calls } = createTestApp();
    const { ws } = await connectAndReceive(s);
    await waitForClose(ws);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.obs.disconnect, 1);
    assert.equal(calls.x32.disconnect, 1);
    assert.equal(calls.proclaim.disconnect, 1);
    s.stop(true);
  });

  test('connections are NOT stopped while other clients remain connected', async () => {
    const { server: s, calls } = createTestApp();
    const { ws: ws1 } = await connectAndReceive(s);
    const { ws: ws2 } = await connectAndReceive(s);
    await waitForClose(ws1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.obs.disconnect, 0);
    assert.equal(calls.x32.disconnect, 0);
    assert.equal(calls.proclaim.disconnect, 0);
    await waitForClose(ws2);
    s.stop(true);
  });
});

function openWs(server: TestServer, suffix: string): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const ws = new WebSocket(`ws://localhost:${server.port}/ws${suffix}`);
  ws.addEventListener('open', () => resolve(ws), { once: true });
  ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
  return promise;
}

function messagesFor(ws: WebSocket, durationMs = 50): Promise<Record<string, unknown>[]> {
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown>[]>();
  const messages: Record<string, unknown>[] = [];
  const handler = (event: MessageEvent) => {
    try { messages.push(JSON.parse(event.data as string) as Record<string, unknown>); } catch { /* ignore non-JSON */ }
  };
  ws.addEventListener('message', handler);
  // A timeout is required here because the contract under test is that no message arrives.
  setTimeout(() => { ws.removeEventListener('message', handler); resolve(messages); }, durationMs);
  return promise;
}

type UpgradeOptions = { headers?: HeadersInit; data: SocketData };

function fakeServer(upgrade: (request: Request, options: UpgradeOptions) => boolean): Server<SocketData> {
  let server!: Server<SocketData>;
  server = {
    stop: async () => {},
    reload: <R extends string>(_options: Bun.Serve.Options<SocketData, R>) => server,
    fetch: () => new Response(),
    upgrade,
    publish: () => 0,
    subscriberCount: () => 0,
    requestIP: () => null,
    timeout: () => {},
    ref: () => {},
    unref: () => {},
    pendingRequests: 0,
    pendingWebSockets: 0,
    url: new URL('http://localhost'),
    port: 0,
    hostname: 'localhost',
    protocol: 'http',
    development: false,
    id: 'test',
    [Symbol.dispose]: () => {},
  };
  return server;
}

describe('WebSocket security and bounded topic protocol', () => {
  test('setupWebSocket rejects failed security checks before attempting upgrade', () => {
    const state = new State();
    let upgrades = 0;
    const setup = setupWebSocket(state, undefined, {
      security: {
        checkHost: () => new Response('Forbidden', { status: 403 }),
        authenticate: () => { throw new Error('must not authenticate rejected host'); },
        bootstrap: () => null,
        requireAuth: () => null,
      },
    });
    const fake = fakeServer(() => { upgrades++; return true; });
    assert.equal(setup.upgrade(new Request('http://localhost/ws'), fake), false);
    assert.equal(upgrades, 0);
  });

  test('setupWebSocket accepts authenticated requests and injects bounded topic data', () => {
    let captured: unknown;
    const setup = setupWebSocket(new State(), undefined, {
      security: {
        checkHost: () => null,
        authenticate: () => true,
        bootstrap: () => null,
        requireAuth: () => null,
      },
    });
    const fake = fakeServer((_req, options) => { captured = options.data; return true; });
    assert.equal(setup.upgrade(new Request('http://localhost/ws?topics=levels,bus:8,bus:9,bus:10,bus:11,bus:12,bus:13,unknown'), fake), true);
    const data = captured as { defaultTopics?: unknown };
    assert.deepEqual(data.defaultTopics, ['levels', 'bus:8', 'bus:9', 'bus:10', 'bus:11']);
  });

  test('topics=levels,bus:N sends bus state without an unwanted full state', async () => {
    const { server } = createTestApp();
    const ws = await openWs(server, '?topics=levels,bus:8');
    const messages = await messagesFor(ws);
    ws.close(); server.stop(true);
    assert.equal(messages.some((message) => message.type === 'state'), false);
    const bus = messages.find((message) => message.type === 'bus-state');
    assert.ok(bus);
    assert.equal(bus.busIndex, 8);
  });

  test('bus topic reports the current X32 connected flag', async () => {
    const { server, state } = createTestApp();
    state.update('x32', { connected: true });
    const ws = await openWs(server, '?topics=bus:3');
    const messages = await messagesFor(ws);
    ws.close(); server.stop(true);
    const bus = messages.find((message) => message.type === 'bus-state');
    assert.ok(bus);
    assert.equal(bus.connected, true);
  });

  test('invalid bus topics and unknown topics produce no snapshots', async () => {
    const { server } = createTestApp();
    for (const suffix of ['?topics=bus:0', '?topics=bus:17', '?topics=not-a-topic']) {
      const ws = await openWs(server, suffix);
      const messages = await messagesFor(ws);
      ws.close();
      assert.deepEqual(messages, []);
    }
    server.stop(true);
  });

  test('per-socket bus topic cap limits initial snapshots to four buses', async () => {
    const { server } = createTestApp();
    const ws = await openWs(server, '?topics=bus:1,bus:2,bus:3,bus:4,bus:5,bus:6,bus:7,bus:8,bus:9');
    const messages = await messagesFor(ws);
    ws.close(); server.stop(true);
    assert.equal(messages.filter((message) => message.type === 'bus-state').length, 4);
    assert.equal(messages.some((message) => message.type === 'state'), false);
  });

  test('oversized messages are ignored without creating a subscription', async () => {
    const { server } = createTestApp();
    const ws = await openWs(server, '?topics=');
    ws.send('x'.repeat(8193));
    const messages = await messagesFor(ws);
    ws.close(); server.stop(true);
    assert.deepEqual(messages, []);
  });
});