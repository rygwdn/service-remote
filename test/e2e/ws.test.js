const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createTestApp, startServer } = require('../helpers/app');

// Helper: open a WebSocket and wait for the first message.
function connectAndReceive(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.once('message', (raw) => resolve({ ws, data: JSON.parse(raw) }));
    ws.once('error', reject);
  });
}

// Helper: wait for the next message on an already-open WebSocket.
function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw)));
    ws.once('error', reject);
  });
}

describe('WebSocket', () => {
  let server, state, port;

  before(async () => {
    ({ server, state } = createTestApp());
    port = await startServer(server);
  });

  after(() => new Promise((resolve) => server.close(resolve)));

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
    assert.equal(update.data.obs.connected, true);
    assert.equal(update.data.obs.currentScene, 'Camera 2');
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

    assert.equal(m1.data.x32.connected, true);
    assert.equal(m2.data.x32.connected, true);
  });

  test('late-connecting client receives the current (updated) state', async () => {
    state.update('proclaim', { connected: true });

    // Connect after the update has already happened
    const { ws, data } = await connectAndReceive(port);
    ws.close();

    assert.equal(data.data.proclaim.connected, true);
  });
});
