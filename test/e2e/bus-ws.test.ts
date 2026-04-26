import assert from 'node:assert/strict';
import { createTestApp } from '../helpers/app';

type TestServer = ReturnType<typeof createTestApp>['server'];

function connectWs(server: TestServer): Promise<{ ws: WebSocket; firstMsg: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    ws.addEventListener('message', (e) => resolve({ ws, firstMsg: JSON.parse(e.data as string) }), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
}

// Subscribe to a bus channel and wait for the immediate bus-state reply
function subscribeToBus(ws: WebSocket, busIndex: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    ws.send(JSON.stringify({ type: 'subscribe', channels: [`bus:${busIndex}`] }));
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (e) => resolve(JSON.parse(e.data as string)), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
}

function nextMessageOfType(ws: WebSocket, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    function handler(e: MessageEvent) {
      const msg = JSON.parse(e.data as string) as Record<string, unknown>;
      if (msg.type === type) { ws.removeEventListener('message', handler); resolve(msg); }
    }
    ws.addEventListener('message', handler);
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.addEventListener('close', () => resolve(), { once: true });
    ws.close();
  });
}

describe('Bus WebSocket (unified /ws + subscribe)', () => {
  let server: TestServer;
  let state: ReturnType<typeof createTestApp>['state'];
  let calls: ReturnType<typeof createTestApp>['calls'];

  beforeAll(() => {
    ({ server, state, calls } = createTestApp());
  });

  afterAll(() => server.stop(true));

  test('subscribing to bus:8 receives immediate bus-state message', async () => {
    const { ws } = await connectWs(server);
    const data = await subscribeToBus(ws, 8);
    ws.close();

    const msg = data as Record<string, unknown>;
    assert.equal(msg.type, 'bus-state');
    assert.equal(msg.busIndex, 8);
    assert.ok('busChannel' in msg);
    assert.ok(Array.isArray(msg.channels));
  });

  test('state update triggers broadcast to bus subscriber', async () => {
    const { ws } = await connectWs(server);
    await subscribeToBus(ws, 8);

    const updatePromise = nextMessageOfType(ws, 'bus-state');
    state.update('x32', { connected: true, channels: [] });
    const update = await updatePromise;
    ws.close();

    const msg = update as Record<string, unknown>;
    assert.equal(msg.type, 'bus-state');
    assert.equal(msg.busIndex, 8);
  });

  test('subscribing starts bus send tracking for the requested bus', async () => {
    const before = calls.x32.startBusSendTracking;
    const { ws } = await connectWs(server);
    await subscribeToBus(ws, 8);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls.x32.startBusSendTracking > before);
  });

  test('subscribing to bus starts bus send tracking even with x32 inactive flag', async () => {
    const { server: s2, calls: c2 } = createTestApp({ x32Active: false });
    const { ws } = await connectWs(s2);
    const busBefore = c2.x32.startBusSendTracking;
    await subscribeToBus(ws, 8);
    assert.ok(c2.x32.startBusSendTracking > busBefore);
    ws.close();
    s2.stop(true);
  });
});
