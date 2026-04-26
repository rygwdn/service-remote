import assert from 'node:assert/strict';
import { createTestApp } from '../helpers/app';
import { setPublisher, broadcast } from '../../src/screenshot-ws';

describe('screenshot broadcast (unified WS)', () => {
  test('broadcast invokes the registered publisher with the frame', () => {
    createTestApp(); // ensures setPublisher has been called at least once
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    let captured: Buffer | null = null;
    setPublisher((frame) => { captured = frame; });
    broadcast(fakeJpeg);
    assert.ok(captured !== null);
    assert.deepEqual(captured, fakeJpeg);
  });

  test('broadcast is a no-op when no publisher is set', () => {
    // Reset publisher to null via setPublisher(null cast)
    setPublisher(null as unknown as (frame: Buffer) => void);
    // Should not throw
    assert.doesNotThrow(() => broadcast(Buffer.from([0xff, 0xd8])));
  });
});
