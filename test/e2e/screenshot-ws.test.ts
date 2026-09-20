import assert from 'node:assert/strict';
import { setPublisher, broadcast } from '../../src/screenshot-ws';

describe('screenshot broadcast (unified WS)', () => {
  test('broadcast invokes the registered publisher with the frame', () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    let captured: Buffer | null = null;
    setPublisher((frame) => { captured = frame; });
    broadcast(fakeJpeg);
    assert.ok(captured !== null);
    assert.deepEqual(captured, fakeJpeg);
  });
});
