import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createTestApp, startServer } from '../helpers/app';

type WsClient = InstanceType<typeof WebSocket>;

function connectBusWs(port: number, busIndex: number): Promise<{ ws: WsClient; data: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/bus?bus=${busIndex}`);
    ws.once('message', (raw: Buffer | string) => resolve({ ws, data: JSON.parse(raw.toString()) }));
    ws.once('error', reject);
    // Reject if closed before first message
    ws.once('close', (code) => { if (code !== 1000) reject(new Error(`closed early with code ${code}`)); });
  });
}

function nextMessage(ws: WsClient): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw: Buffer | string) => resolve(JSON.parse(raw.toString())));
    ws.once('error', reject);
  });
}

describe('Bus WebSocket (/ws/bus)', () => {
  let server: import('http').Server;
  let state: InstanceType<typeof import('../../src/state').State>;
  let calls: ReturnType<typeof createTestApp>['calls'];
  let port: number;

  beforeAll(async () => {
    ({ server, state, calls } = createTestApp());
    port = await startServer(server);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('connecting to /ws/bus?bus=8 receives initial bus-state message', async () => {
    const { ws, data } = await connectBusWs(port, 8);
    ws.close();

    assert.ok(typeof data === 'object' && data !== null);
    const msg = data as Record<string, unknown>;
    assert.equal(msg.type, 'bus-state');
    assert.equal(msg.busIndex, 8);
    assert.ok('busChannel' in msg, 'should have busChannel');
    assert.ok(Array.isArray(msg.channels), 'should have channels array');
  });

  test('state update triggers broadcast to bus WS client', async () => {
    const { ws } = await connectBusWs(port, 8);

    const updatePromise = nextMessage(ws);
    state.update('x32', { connected: true, channels: [] });
    const update = await updatePromise;
    ws.close();

    const msg = update as Record<string, unknown>;
    assert.equal(msg.type, 'bus-state');
    assert.equal(msg.busIndex, 8);
  });

  test('connecting starts bus send tracking for the requested bus', async () => {
    const before = calls.x32.startBusSendTracking;
    const { ws } = await connectBusWs(port, 8);
    ws.close();
    // Allow close to propagate
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls.x32.startBusSendTracking > before, 'startBusSendTracking should have been called');
  });

  test('connecting starts x32 and meter updates when x32 is not active', async () => {
    const { server: s2, calls: c2 } = createTestApp({ x32Active: false });
    const p2 = await startServer(s2);
    const connectBefore = c2.x32.connect;
    const meterBefore = c2.x32.startMeterUpdates;

    const { ws } = await connectBusWs(p2, 8);
    assert.ok(c2.x32.connect > connectBefore, 'x32.connect() should be called');
    assert.ok(c2.x32.startMeterUpdates > meterBefore, 'x32.startMeterUpdates() should be called');

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((resolve) => s2.close(() => resolve()));
  });

  test('does not call x32.connect when x32 is already active', async () => {
    const { server: s2, calls: c2 } = createTestApp({ x32Active: true });
    const p2 = await startServer(s2);
    const connectBefore = c2.x32.connect;

    const { ws } = await connectBusWs(p2, 8);
    assert.equal(c2.x32.connect, connectBefore, 'x32.connect() should NOT be called when already active');

    ws.close();
    await new Promise<void>((resolve) => s2.close(() => resolve()));
  });

  test('channels array contains only ch-type channels with busSend on for the bus', async () => {
    const channels = [
      { index: 1, type: 'ch' as const, label: 'Vox', fader: 0.8, muted: false, level: 0, source: 1, linkedToNext: false, spill: false, color: 0,
        busSends: [{ busIndex: 8, level: 0.7, on: true }] },
      { index: 2, type: 'ch' as const, label: 'Guitar', fader: 0.5, muted: false, level: 0, source: 2, linkedToNext: false, spill: false, color: 0,
        busSends: [{ busIndex: 8, level: 0.3, on: false }] },
      { index: 8, type: 'bus' as const, label: 'Stage', fader: 0.9, muted: false, level: 0, source: 0, linkedToNext: false, spill: false, color: 0 },
    ];
    state.update('x32', { connected: true, channels });

    const { ws, data } = await connectBusWs(port, 8);
    ws.close();

    const msg = data as Record<string, unknown>;
    const chans = msg.channels as Array<Record<string, unknown>>;
    assert.equal(chans.length, 1, 'only ch 1 has busSend on for bus 8');
    assert.equal(chans[0].index, 1);
    assert.equal((msg.busChannel as Record<string, unknown>).index, 8);
  });
});
