import assert = require('node:assert/strict');
import x32 = require('../../src/connections/x32');

const { parseOscMessage, parseMeterBlob, buildMeterRequests } = x32;

describe('x32 parseOscMessage()', () => {
  describe('fader messages (/ch/XX/mix/fader)', () => {
    test('single-digit channel is zero-padded', () => {
      const result = parseOscMessage('/ch/01/mix/fader', [{ value: 0.75 }]);
      assert.deepEqual(result, { index: 1, type: 'ch', patch: { fader: 0.75 } });
    });

    test('two-digit channel', () => {
      const result = parseOscMessage('/ch/16/mix/fader', [{ value: 0.5 }]);
      assert.deepEqual(result, { index: 16, type: 'ch', patch: { fader: 0.5 } });
    });

    test('fader at zero', () => {
      const result = parseOscMessage('/ch/02/mix/fader', [{ value: 0 }]);
      assert.deepEqual(result, { index: 2, type: 'ch', patch: { fader: 0 } });
    });

    test('missing args defaults fader to 0', () => {
      const result = parseOscMessage('/ch/03/mix/fader', []);
      assert.deepEqual(result, { index: 3, type: 'ch', patch: { fader: 0 } });
    });
  });

  describe('mute messages (/ch/XX/mix/on)', () => {
    test('value 0 means muted', () => {
      const result = parseOscMessage('/ch/01/mix/on', [{ value: 0 }]);
      assert.deepEqual(result, { index: 1, type: 'ch', patch: { muted: true } });
    });

    test('value 1 means not muted', () => {
      const result = parseOscMessage('/ch/01/mix/on', [{ value: 1 }]);
      assert.deepEqual(result, { index: 1, type: 'ch', patch: { muted: false } });
    });

    test('missing args defaults to not muted', () => {
      const result = parseOscMessage('/ch/04/mix/on', []);
      assert.deepEqual(result, { index: 4, type: 'ch', patch: { muted: false } });
    });
  });

  describe('name messages (/ch/XX/config/name)', () => {
    test('returns label patch for non-empty name', () => {
      const result = parseOscMessage('/ch/03/config/name', [{ value: 'Drums' }]);
      assert.deepEqual(result, { index: 3, type: 'ch', patch: { label: 'Drums' } });
    });

    test('returns null for empty string name', () => {
      const result = parseOscMessage('/ch/03/config/name', [{ value: '' }]);
      assert.equal(result, null);
    });

    test('returns null when args are missing', () => {
      const result = parseOscMessage('/ch/03/config/name', []);
      assert.equal(result, null);
    });
  });

  describe('bus fader messages (/bus/XX/mix/fader)', () => {
    test('bus fader returns type bus', () => {
      const result = parseOscMessage('/bus/01/mix/fader', [{ value: 0.6 }]);
      assert.deepEqual(result, { index: 1, type: 'bus', patch: { fader: 0.6 } });
    });

    test('two-digit bus', () => {
      const result = parseOscMessage('/bus/16/mix/fader', [{ value: 0.3 }]);
      assert.deepEqual(result, { index: 16, type: 'bus', patch: { fader: 0.3 } });
    });

    test('missing args defaults bus fader to 0', () => {
      const result = parseOscMessage('/bus/02/mix/fader', []);
      assert.deepEqual(result, { index: 2, type: 'bus', patch: { fader: 0 } });
    });
  });

  describe('bus mute messages (/bus/XX/mix/on)', () => {
    test('value 0 means bus muted', () => {
      const result = parseOscMessage('/bus/01/mix/on', [{ value: 0 }]);
      assert.deepEqual(result, { index: 1, type: 'bus', patch: { muted: true } });
    });

    test('value 1 means bus not muted', () => {
      const result = parseOscMessage('/bus/01/mix/on', [{ value: 1 }]);
      assert.deepEqual(result, { index: 1, type: 'bus', patch: { muted: false } });
    });
  });

  describe('bus name messages (/bus/XX/config/name)', () => {
    test('returns label patch for non-empty bus name', () => {
      const result = parseOscMessage('/bus/03/config/name', [{ value: 'IEM Mix' }]);
      assert.deepEqual(result, { index: 3, type: 'bus', patch: { label: 'IEM Mix' } });
    });

    test('returns null for empty bus name', () => {
      const result = parseOscMessage('/bus/03/config/name', [{ value: '' }]);
      assert.equal(result, null);
    });

    test('returns null when bus name args are missing', () => {
      const result = parseOscMessage('/bus/03/config/name', []);
      assert.equal(result, null);
    });
  });

  describe('matrix faders', () => {
    test('parses mtx fader', () => {
      const result = parseOscMessage('/mtx/01/mix/fader', [{ value: 0.8 }]);
      assert.deepEqual(result, { index: 1, type: 'mtx', patch: { fader: 0.8 } });
    });

    test('parses mtx mute (on=0 → muted)', () => {
      const result = parseOscMessage('/mtx/03/mix/on', [{ value: 0 }]);
      assert.deepEqual(result, { index: 3, type: 'mtx', patch: { muted: true } });
    });

    test('parses mtx mute (on=1 → not muted)', () => {
      const result = parseOscMessage('/mtx/03/mix/on', [{ value: 1 }]);
      assert.deepEqual(result, { index: 3, type: 'mtx', patch: { muted: false } });
    });

    test('parses mtx name', () => {
      const result = parseOscMessage('/mtx/02/config/name', [{ value: 'Lobby' }]);
      assert.deepEqual(result, { index: 2, type: 'mtx', patch: { label: 'Lobby' } });
    });

    test('returns null for empty mtx name', () => {
      assert.equal(parseOscMessage('/mtx/01/config/name', [{ value: '' }]), null);
    });
  });

  describe('main faders', () => {
    test('parses main L/R fader', () => {
      const result = parseOscMessage('/main/st/mix/fader', [{ value: 0.9 }]);
      assert.deepEqual(result, { index: 1, type: 'main', patch: { fader: 0.9 } });
    });

    test('parses main L/R mute', () => {
      const result = parseOscMessage('/main/st/mix/on', [{ value: 0 }]);
      assert.deepEqual(result, { index: 1, type: 'main', patch: { muted: true } });
    });

    test('parses main M/C fader', () => {
      const result = parseOscMessage('/main/m/mix/fader', [{ value: 0.7 }]);
      assert.deepEqual(result, { index: 2, type: 'main', patch: { fader: 0.7 } });
    });

    test('parses main M/C mute', () => {
      const result = parseOscMessage('/main/m/mix/on', [{ value: 1 }]);
      assert.deepEqual(result, { index: 2, type: 'main', patch: { muted: false } });
    });
  });

  describe('unrecognised addresses', () => {
    test('returns null for unknown OSC address', () => {
      assert.equal(parseOscMessage('/xremote', []), null);
      assert.equal(parseOscMessage('/dca/1/fader', [{ value: 0.5 }]), null);
      assert.equal(parseOscMessage('/ch/01/eq/on', [{ value: 1 }]), null);
    });
  });
});

describe('x32 parseMeterBlob()', () => {
  // Helper: build a meter blob matching the X32 wire format:
  // 4-byte big-endian count, followed by little-endian float32 values.
  function makeBlob(floats: number[]): Buffer {
    const buf = Buffer.allocUnsafe(4 + floats.length * 4);
    buf.writeUInt32BE(floats.length, 0);
    for (let i = 0; i < floats.length; i++) {
      buf.writeFloatLE(floats[i], 4 + i * 4);
    }
    return buf;
  }

  test('returns empty array for blob shorter than 4 bytes', () => {
    assert.deepEqual(parseMeterBlob(Buffer.alloc(3)), []);
    assert.deepEqual(parseMeterBlob(Buffer.alloc(0)), []);
  });

  test('returns empty array when count is 0', () => {
    const buf = Buffer.alloc(4); // count = 0, no floats
    assert.deepEqual(parseMeterBlob(buf), []);
  });

  test('parses a single float value', () => {
    const blob = makeBlob([0.5]);
    const result = parseMeterBlob(blob);
    assert.equal(result.length, 1);
    assert.ok(Math.abs(result[0] - 0.5) < 1e-6);
  });

  test('parses multiple float values in order', () => {
    const input = [0.0, 0.25, 0.5, 0.75, 1.0];
    const result = parseMeterBlob(makeBlob(input));
    assert.equal(result.length, input.length);
    for (let i = 0; i < input.length; i++) {
      assert.ok(Math.abs(result[i] - input[i]) < 1e-6, `value at index ${i}`);
    }
  });

  test('stops reading when blob is shorter than declared count', () => {
    // Declare 4 floats but only provide data for 2
    const buf = Buffer.allocUnsafe(4 + 2 * 4);
    buf.writeUInt32BE(4, 0);       // claims 4 floats
    buf.writeFloatLE(0.1, 4);
    buf.writeFloatLE(0.2, 8);
    // bytes 12-19 are missing → only 2 values should be returned
    const result = parseMeterBlob(buf);
    assert.equal(result.length, 2);
  });

  test('32-channel bank 0 blob: channel positions 0–31 map to ch 1–32', () => {
    // Simulate a 32-float bank-0 blob where ch 5 (index 4) has level 0.8
    const floats = new Array(32).fill(0);
    floats[4] = 0.8; // ch 5 is at 0-based position 4
    const result = parseMeterBlob(makeBlob(floats));
    assert.ok(Math.abs(result[4] - 0.8) < 1e-6);
    assert.equal(result[0], 0);
  });
});

describe('x32 buildMeterRequests()', () => {
  test('returns three OSC messages for banks 0, 2, and 3', () => {
    const requests = buildMeterRequests();
    assert.equal(requests.length, 3);
  });

  test('each meter request uses /meters/N address (not /meters)', () => {
    const requests = buildMeterRequests();
    const addresses = requests.map((r) => r.address);
    assert.ok(addresses.includes('/meters/0'), 'must include /meters/0 for input channels');
    assert.ok(addresses.includes('/meters/2'), 'must include /meters/2 for mix buses');
    assert.ok(addresses.includes('/meters/3'), 'must include /meters/3 for main/matrix');
    for (const addr of addresses) {
      assert.notEqual(addr, '/meters', `address "${addr}" must not be bare /meters — X32 ignores that`);
    }
  });

  test('each meter request has exactly one arg (duration), not two', () => {
    const requests = buildMeterRequests();
    for (const req of requests) {
      assert.equal(req.args.length, 1, `${req.address} should have 1 arg (duration), not ${req.args.length}`);
    }
  });

  test('duration arg is a positive integer', () => {
    const requests = buildMeterRequests();
    for (const req of requests) {
      const duration = req.args[0].value;
      assert.ok(typeof duration === 'number' && Number.isInteger(duration) && duration > 0,
        `${req.address} duration must be a positive integer, got ${duration}`);
    }
  });
});
