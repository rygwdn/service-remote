import assert = require('node:assert/strict');
import wsModule = require('ws');
const { createTestApp, startServer } = require('../helpers/app');

const { WebSocket } = wsModule;
type WsClient = InstanceType<typeof wsModule.WebSocket>;

// Helper: open a WebSocket and wait for the first message.
function connectAndReceive(port: number): Promise<{ ws: WsClient; data: { type: string; data: Record<string, unknown> } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.once('message', (raw: Buffer | string) => resolve({ ws, data: JSON.parse(raw.toString()) }));
    ws.once('error', reject);
  });
}

// Helper: wait for the next message on an already-open WebSocket.
function nextMessage(ws: WsClient): Promise<{ type: string; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw: Buffer | string) => resolve(JSON.parse(raw.toString())));
    ws.once('error', reject);
  });
}

describe('WebSocket', () => {
  let server: import('http').Server;
  let state: InstanceType<typeof import('../../src/state').State>;
  let port: number;

  beforeAll(async () => {
    ({ server, state } = createTestApp());
    port = await startServer(server);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('new client receives full state immediately on connect', async () => {
    const { ws, data } = await connectAndReceive(port);
    ws.close();

    assert.equal(data.type, 'state');
    assert.ok('obs' in data.data);
    assert.ok('x32' in data.data);
    assert.ok('proclaim' in data.data);
  });

  test('state update is broadcast to connected client', async () => {
    const { ws, data: initial } = await connectAndReceive(port);

    // Trigger a state change after we're connected
    const updatePromise = nextMessage(ws);
    state.update('obs', { connected: true, currentScene: 'Camera 2' });
    const update = await updatePromise;
    ws.close();

    assert.equal(update.type, 'state');
    assert.equal((update.data as any).obs.connected, true);
    assert.equal((update.data as any).obs.currentScene, 'Camera 2');
  });

  test('broadcast reaches all connected clients', async () => {
    const [c1, c2] = await Promise.all([
      connectAndReceive(port),
      connectAndReceive(port),
    ]);

    const p1 = nextMessage(c1.ws);
    const p2 = nextMessage(c2.ws);

    state.update('x32', { connected: true });

    const [m1, m2] = await Promise.all([p1, p2]);
    c1.ws.close();
    c2.ws.close();

    assert.equal((m1.data as any).x32.connected, true);
    assert.equal((m2.data as any).x32.connected, true);
  });

  test('late-connecting client receives the current (updated) state', async () => {
    state.update('proclaim', { connected: true });

    // Connect after the update has already happened
    const { ws, data } = await connectAndReceive(port);
    ws.close();

    assert.equal((data.data as any).proclaim.connected, true);
  });
});

describe('WebSocket meter subscription lifecycle', () => {
  // Each test in this suite gets its own isolated server so call counts are fresh.

  function waitForClose(socket: InstanceType<typeof wsModule.WebSocket>): Promise<void> {
    return new Promise((resolve) => {
      if (socket.readyState === wsModule.WebSocket.CLOSED) { resolve(); return; }
      socket.once('close', resolve);
      socket.close();
    });
  }

  test('startMeterUpdates is called when the first client connects', async () => {
    const { server, calls } = createTestApp();
    const testPort = await startServer(server);

    const { ws } = await connectAndReceive(testPort);
    assert.equal(calls.x32.startMeterUpdates, 1, 'startMeterUpdates should be called once');

    await waitForClose(ws);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('startMeterUpdates is NOT called again when a second client connects', async () => {
    const { server, calls } = createTestApp();
    const testPort = await startServer(server);

    const { ws: ws1 } = await connectAndReceive(testPort);
    const { ws: ws2 } = await connectAndReceive(testPort);
    assert.equal(calls.x32.startMeterUpdates, 1, 'startMeterUpdates should only be called for the first client');

    await waitForClose(ws1);
    await waitForClose(ws2);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('stopMeterUpdates is called when the last client disconnects', async () => {
    const { server, calls } = createTestApp();
    const testPort = await startServer(server);

    const { ws } = await connectAndReceive(testPort);
    await waitForClose(ws);

    // Allow the server-side close event to propagate.
    // The server-side 'close' fires after the client-side 'close' (TCP FIN exchange
    // needs one extra I/O poll cycle), so setImmediate alone is insufficient.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.x32.stopMeterUpdates, 1, 'stopMeterUpdates should be called when last client leaves');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('stopMeterUpdates is NOT called while other clients remain connected', async () => {
    const { server, calls } = createTestApp();
    const testPort = await startServer(server);

    const { ws: ws1 } = await connectAndReceive(testPort);
    const { ws: ws2 } = await connectAndReceive(testPort);

    // Close only the first client
    await waitForClose(ws1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.x32.stopMeterUpdates, 0, 'stopMeterUpdates should not be called while ws2 is still open');

    await waitForClose(ws2);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('WebSocket level stripping', () => {
  let server: import('http').Server;
  let state: InstanceType<typeof import('../../src/state').State>;
  let port: number;

  beforeAll(async () => {
    ({ server, state } = createTestApp());
    port = await startServer(server);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('initial state broadcast does not include level on audioSources', async () => {
    state.update('obs', {
      audioSources: [{ name: 'Mic 1', volume: -10, muted: false, live: true, level: 0.75 }],
    });

    const { ws, data } = await connectAndReceive(port);
    ws.close();

    const sources = (data.data as any).obs.audioSources as Array<Record<string, unknown>>;
    assert.ok(sources.length > 0, 'audioSources should be non-empty');
    assert.equal(sources[0].level, undefined, 'level must be stripped from audioSources in main WS');
  });

  test('initial state broadcast does not include level on x32 channels', async () => {
    state.update('x32', {
      channels: [{ index: 1, type: 'ch', label: 'Vocals', fader: 0.8, muted: false, level: 0.5, source: 1, linkedToNext: false, spill: false, color: 0 }],
    });

    const { ws, data } = await connectAndReceive(port);
    ws.close();

    const channels = (data.data as any).x32.channels as Array<Record<string, unknown>>;
    assert.ok(channels.length > 0, 'channels should be non-empty');
    assert.equal(channels[0].level, undefined, 'level must be stripped from channels in main WS');
  });

  test('state update broadcast does not include level on audioSources', async () => {
    const { ws } = await connectAndReceive(port);

    const updatePromise = nextMessage(ws);
    state.update('obs', {
      audioSources: [{ name: 'Mic 2', volume: -5, muted: false, live: true, level: 0.9 }],
    });
    const update = await updatePromise;
    ws.close();

    const sources = (update.data as any).obs.audioSources as Array<Record<string, unknown>>;
    assert.ok(sources.length > 0, 'audioSources should be non-empty');
    assert.equal(sources[0].level, undefined, 'level must be stripped from audioSources in update broadcast');
  });

  test('state update broadcast does not include level on x32 channels', async () => {
    const { ws } = await connectAndReceive(port);

    const updatePromise = nextMessage(ws);
    state.update('x32', {
      channels: [{ index: 2, type: 'ch', label: 'Guitar', fader: 0.6, muted: false, level: 0.3, source: 2, linkedToNext: false, spill: false, color: 0 }],
    });
    const update = await updatePromise;
    ws.close();

    const channels = (update.data as any).x32.channels as Array<Record<string, unknown>>;
    assert.ok(channels.length > 0, 'channels should be non-empty');
    assert.equal(channels[0].level, undefined, 'level must be stripped from channels in update broadcast');
  });
});

describe('WebSocket connection lifecycle', () => {
  function waitForClose(socket: InstanceType<typeof wsModule.WebSocket>): Promise<void> {
    return new Promise((resolve) => {
      if (socket.readyState === wsModule.WebSocket.CLOSED) { resolve(); return; }
      socket.once('close', resolve);
      socket.close();
    });
  }

  test('all connections are started when the first client connects', async () => {
    const { server, calls } = createTestApp();
    const testPort = await startServer(server);

    const { ws } = await connectAndReceive(testPort);

    assert.equal(calls.obs.connect, 1, 'obs.connect should be called once');
    assert.equal(calls.x32.connect, 1, 'x32.connect should be called once');
    assert.equal(calls.proclaim.connect, 1, 'proclaim.connect should be called once');

    await waitForClose(ws);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('connections are NOT started again when a second client connects', async () => {
    const { server, calls } = createTestApp();
    const testPort = await startServer(server);

    const { ws: ws1 } = await connectAndReceive(testPort);
    const { ws: ws2 } = await connectAndReceive(testPort);

    assert.equal(calls.obs.connect, 1, 'obs.connect should only be called for the first client');
    assert.equal(calls.x32.connect, 1, 'x32.connect should only be called for the first client');
    assert.equal(calls.proclaim.connect, 1, 'proclaim.connect should only be called for the first client');

    await waitForClose(ws1);
    await waitForClose(ws2);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('all connections are stopped when the last client disconnects', async () => {
    const { server, calls } = createTestApp();
    const testPort = await startServer(server);

    const { ws } = await connectAndReceive(testPort);
    await waitForClose(ws);

    // Allow the server-side close event to propagate
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.obs.disconnect, 1, 'obs.disconnect should be called when last client leaves');
    assert.equal(calls.x32.disconnect, 1, 'x32.disconnect should be called when last client leaves');
    assert.equal(calls.proclaim.disconnect, 1, 'proclaim.disconnect should be called when last client leaves');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('connections are NOT stopped while other clients remain connected', async () => {
    const { server, calls } = createTestApp();
    const testPort = await startServer(server);

    const { ws: ws1 } = await connectAndReceive(testPort);
    const { ws: ws2 } = await connectAndReceive(testPort);

    // Close only the first client
    await waitForClose(ws1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.obs.disconnect, 0, 'obs.disconnect should not be called while ws2 is still open');
    assert.equal(calls.x32.disconnect, 0, 'x32.disconnect should not be called while ws2 is still open');
    assert.equal(calls.proclaim.disconnect, 0, 'proclaim.disconnect should not be called while ws2 is still open');

    await waitForClose(ws2);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
