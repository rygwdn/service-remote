import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createTestApp, startServer } from '../helpers/app';
import { broadcast } from '../../src/screenshot-ws';

describe('/ws/screenshot WebSocket endpoint', () => {
  let server: import('http').Server;
  let port: number;

  beforeAll(async () => {
    ({ server } = createTestApp());
    port = await startServer(server);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('accepts WebSocket connections on /ws/screenshot path', (done) => {
    const client = new WebSocket(`ws://localhost:${port}/ws/screenshot`);
    client.on('open', () => {
      client.close();
      done();
    });
    client.on('error', (err) => done(err));
  });

  test('sends binary JPEG data when broadcast is called', (done) => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG magic bytes

    const client = new WebSocket(`ws://localhost:${port}/ws/screenshot`);
    client.on('open', () => {
      broadcast(fakeJpeg);
    });
    client.on('message', (data: Buffer, isBinary: boolean) => {
      assert.ok(isBinary, 'message should be binary');
      assert.ok(data instanceof Buffer);
      assert.deepEqual(data, fakeJpeg);
      client.close();
      done();
    });
    client.on('error', (err: Error) => done(err));
  });

  test('does not send to disconnected clients', (done) => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    let messageReceived = false;

    const client = new WebSocket(`ws://localhost:${port}/ws/screenshot`);
    client.on('open', () => {
      client.close();
    });
    client.on('close', () => {
      // After close, broadcast — should not error or deliver to closed client
      broadcast(fakeJpeg);
      setTimeout(() => {
        assert.equal(messageReceived, false);
        done();
      }, 100);
    });
    client.on('message', () => { messageReceived = true; });
    client.on('error', (err: Error) => done(err));
  });
});
