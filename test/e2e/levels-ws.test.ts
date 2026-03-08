import assert = require('node:assert/strict');
import ws = require('ws');
const { createTestApp, startServer } = require('../helpers/app');
const levelsWs = require('../../src/levels-ws');

describe('/ws/levels WebSocket endpoint', () => {
  let server: import('http').Server;
  let port: number;

  beforeAll(async () => {
    ({ server } = createTestApp());
    port = await startServer(server);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('accepts WebSocket connections on /ws/levels path', (done) => {
    const client = new ws.WebSocket(`ws://localhost:${port}/ws/levels`);
    client.on('open', () => {
      client.close();
      done();
    });
    client.on('error', (err) => done(err));
  });

  test('sends JSON level payload when broadcast is called', (done) => {
    const payload = { x32: { 'ch-1': 0.42, 'bus-3': 0.1 }, obs: { Mic: 0.3 } };

    const client = new ws.WebSocket(`ws://localhost:${port}/ws/levels`);
    client.on('open', () => {
      levelsWs.broadcast(payload);
    });
    client.on('message', (data: Buffer) => {
      const parsed = JSON.parse(data.toString());
      assert.deepEqual(parsed, payload);
      client.close();
      done();
    });
    client.on('error', (err: Error) => done(err));
  });

  test('does not send to disconnected clients', (done) => {
    const payload = { x32: { 'ch-2': 0.5 }, obs: {} };
    let messageReceived = false;

    const client = new ws.WebSocket(`ws://localhost:${port}/ws/levels`);
    client.on('open', () => {
      client.close();
    });
    client.on('close', () => {
      levelsWs.broadcast(payload);
      setTimeout(() => {
        assert.equal(messageReceived, false);
        done();
      }, 100);
    });
    client.on('message', () => { messageReceived = true; });
    client.on('error', (err: Error) => done(err));
  });

  test('broadcast with only x32 levels works', (done) => {
    const payload = { x32: { 'ch-5': 0.75 }, obs: {} };

    const client = new ws.WebSocket(`ws://localhost:${port}/ws/levels`);
    client.on('open', () => {
      levelsWs.broadcast(payload);
    });
    client.on('message', (data: Buffer) => {
      const parsed = JSON.parse(data.toString());
      assert.deepEqual(parsed.x32, payload.x32);
      client.close();
      done();
    });
    client.on('error', (err: Error) => done(err));
  });
});

describe('/ws/levels — main state WS does not carry meter ticks', () => {
  test('x32 meter update via levelsWs.broadcast does not trigger main WS state message', (done) => {
    const { server, state } = createTestApp();
    startServer(server).then((port: number) => {
      const client = new ws.WebSocket(`ws://localhost:${port}`);
      let messageCount = 0;

      client.on('message', () => { messageCount++; });

      client.on('open', () => {
        // Broadcast a levels update — should NOT cause main WS to send a state message
        levelsWs.broadcast({ x32: { 'ch-1': 0.5 }, obs: {} });

        setTimeout(() => {
          // Only the initial state message should have been received (count = 1)
          assert.equal(messageCount, 1, 'main WS should only send initial state, not level updates');
          client.close();
          server.close(() => done());
        }, 200);
      });

      client.on('error', (err: Error) => {
        client.close();
        server.close(() => done(err));
      });
    });
  });

  test('obs meter update via levelsWs.broadcast does not trigger main WS state message', (done) => {
    const { server, state } = createTestApp();
    startServer(server).then((port: number) => {
      const client = new ws.WebSocket(`ws://localhost:${port}`);
      let messageCount = 0;

      client.on('message', () => { messageCount++; });

      client.on('open', () => {
        levelsWs.broadcast({ x32: {}, obs: { Mic: 0.8 } });

        setTimeout(() => {
          assert.equal(messageCount, 1, 'main WS should only send initial state, not OBS level updates');
          client.close();
          server.close(() => done());
        }, 200);
      });

      client.on('error', (err: Error) => {
        client.close();
        server.close(() => done(err));
      });
    });
  });
});
