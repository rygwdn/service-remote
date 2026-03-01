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
