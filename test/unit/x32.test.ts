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

  describe('DCA group messages (/ch/XX/grp/dca and /bus/XX/grp/dca)', () => {
    test('ch dca bitmask with bit 7 set → spill: true', () => {
      const result = parseOscMessage('/ch/01/grp/dca', [{ value: 128 }]);
      assert.deepEqual(result, { index: 1, type: 'ch', patch: { spill: true } });
    });

    test('ch dca bitmask with bit 7 clear → spill: false', () => {
      const result = parseOscMessage('/ch/01/grp/dca', [{ value: 0 }]);
      assert.deepEqual(result, { index: 1, type: 'ch', patch: { spill: false } });
    });

    test('ch dca bitmask with multiple bits set including bit 7 → spill: true', () => {
      const result = parseOscMessage('/ch/05/grp/dca', [{ value: 136 }]); // 128 + 8 = DCA 4 + DCA 8
      assert.deepEqual(result, { index: 5, type: 'ch', patch: { spill: true } });
    });

    test('ch dca bitmask with only lower bits set → spill: false', () => {
      const result = parseOscMessage('/ch/03/grp/dca', [{ value: 7 }]); // DCA 1+2+3 only
      assert.deepEqual(result, { index: 3, type: 'ch', patch: { spill: false } });
    });

    test('missing args defaults to spill: false', () => {
      const result = parseOscMessage('/ch/02/grp/dca', []);
      assert.deepEqual(result, { index: 2, type: 'ch', patch: { spill: false } });
    });

    test('bus dca bitmask with bit 7 set → spill: true', () => {
      const result = parseOscMessage('/bus/03/grp/dca', [{ value: 128 }]);
      assert.deepEqual(result, { index: 3, type: 'bus', patch: { spill: true } });
    });

    test('bus dca bitmask with bit 7 clear → spill: false', () => {
      const result = parseOscMessage('/bus/16/grp/dca', [{ value: 64 }]);
      assert.deepEqual(result, { index: 16, type: 'bus', patch: { spill: false } });
    });

    test('two-digit channel', () => {
      const result = parseOscMessage('/ch/32/grp/dca', [{ value: 128 }]);
      assert.deepEqual(result, { index: 32, type: 'ch', patch: { spill: true } });
    });
  });
});

describe('x32 parseMeterBlob()', () => {
  // Helper: build a meter blob as the X32 sends it (after node-osc strips the OSC
  // blob-length header). The X32 prepends a 4-byte little-endian count field
  // (number of floats that follow), then packed little-endian float32 values.
  function makeBlob(floats: number[]): Buffer {
    const countBuf = Buffer.allocUnsafe(4);
    countBuf.writeUInt32LE(floats.length, 0);
    const dataBuf = Buffer.allocUnsafe(floats.length * 4);
    for (let i = 0; i < floats.length; i++) {
      dataBuf.writeFloatLE(floats[i], i * 4);
    }
    return Buffer.concat([countBuf, dataBuf]);
  }

  test('returns empty array for empty blob', () => {
    assert.deepEqual(parseMeterBlob(Buffer.alloc(0)), []);
  });

  test('returns empty array for blob shorter than count+one float (< 8 bytes)', () => {
    assert.deepEqual(parseMeterBlob(Buffer.alloc(7)), []);
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

  test('ignores trailing bytes that do not form a complete float', () => {
    // 2 full floats + 3 partial bytes = only 2 values returned
    const full = makeBlob([0.1, 0.2]);
    const buf = Buffer.concat([full, Buffer.alloc(3)]);
    const result = parseMeterBlob(buf);
    assert.equal(result.length, 2);
  });

  test('32-channel bank 0 blob: channel positions 0–31 map to ch 1–32', () => {
    // Simulate a 32-float bank-0 blob where ch 5 (index 4) has level 0.8
    const floats = new Array(32).fill(0);
    floats[4] = 0.8; // ch 5 is at 0-based position 4
    const result = parseMeterBlob(makeBlob(floats));
    assert.equal(result.length, 32);
    assert.ok(Math.abs(result[4] - 0.8) < 1e-6);
    assert.equal(result[0], 0);
  });
});

describe('x32 parseMeterBlob() level rounding', () => {
  // makeBlob matches the X32 wire format: 4-byte LE count prefix + packed LE float32s
  function makeBlob(floats: number[]): Buffer {
    const countBuf = Buffer.allocUnsafe(4);
    countBuf.writeUInt32LE(floats.length, 0);
    const dataBuf = Buffer.allocUnsafe(floats.length * 4);
    for (let i = 0; i < floats.length; i++) {
      dataBuf.writeFloatLE(floats[i], i * 4);
    }
    return Buffer.concat([countBuf, dataBuf]);
  }

  test('level values are rounded to 3 decimal places', () => {
    // A value that would produce many decimal places when read as float32
    // e.g. 0.123456789 stored as float32 rounds to a specific representation
    const blob = makeBlob([0.123456789]);
    const result = parseMeterBlob(blob);
    assert.equal(result.length, 1);
    // The result must be rounded to exactly 3 decimal places
    assert.equal(result[0], Math.round(result[0] * 1000) / 1000,
      'level should be rounded to 3 decimal places');
    // And the number of decimal places must not exceed 3
    const str = result[0].toString();
    const decimals = str.includes('.') ? str.split('.')[1].length : 0;
    assert.ok(decimals <= 3, `expected at most 3 decimal places, got ${decimals} in ${str}`);
  });

  test('level 0.5 rounds to 0.5 (no change)', () => {
    const blob = makeBlob([0.5]);
    const result = parseMeterBlob(blob);
    assert.equal(result[0], 0.5);
  });

  test('level 0.0 rounds to 0.0 (no change)', () => {
    const blob = makeBlob([0.0]);
    const result = parseMeterBlob(blob);
    assert.equal(result[0], 0.0);
  });

  test('level 1.0 rounds to 1.0 (no change)', () => {
    const blob = makeBlob([1.0]);
    const result = parseMeterBlob(blob);
    assert.equal(result[0], 1.0);
  });

  test('all values in a multi-float blob are rounded to 3 decimal places', () => {
    // Use values that produce float32 precision noise
    const floats = [0.1, 0.2, 0.3, 0.7, 0.9];
    const result = parseMeterBlob(makeBlob(floats));
    for (let i = 0; i < result.length; i++) {
      const rounded = Math.round(result[i] * 1000) / 1000;
      assert.equal(result[i], rounded,
        `value at index ${i} (${result[i]}) should equal its 3dp-rounded form (${rounded})`);
    }
  });
});

describe('x32 buildMeterRequests()', () => {
  // The X32 protocol uses /meters ,si <bank-path> <time_factor>
  // where bank-path is e.g. "/meters/0" and time_factor controls update interval (50ms * time_factor).
  // The X32 replies with messages addressed /meters/0, /meters/2, etc.

  test('returns two OSC messages for banks 0 and 2', () => {
    const requests = buildMeterRequests();
    assert.equal(requests.length, 2);
  });

  test('all requests use /meters address (not /meters/N)', () => {
    const requests = buildMeterRequests();
    for (const req of requests) {
      assert.equal(req.address, '/meters', `address must be "/meters", got "${req.address}"`);
    }
  });

  test('bank paths are /meters/0 (channels) and /meters/2 (bus/mtx/main)', () => {
    const requests = buildMeterRequests();
    const bankPaths = requests.map((r) => r.args[0].value);
    assert.ok(bankPaths.includes('/meters/0'), 'must subscribe to /meters/0 for input channels');
    assert.ok(bankPaths.includes('/meters/2'), 'must subscribe to /meters/2 for bus/mtx/main');
  });

  test('each request has exactly two args: bank path string and time_factor int', () => {
    const requests = buildMeterRequests();
    for (const req of requests) {
      assert.equal(req.args.length, 2, `${req.args[0].value} should have 2 args, not ${req.args.length}`);
      assert.equal(typeof req.args[0].value, 'string', 'first arg must be a string (bank path)');
      const timeFactor = req.args[1].value;
      assert.ok(typeof timeFactor === 'number' && Number.isInteger(timeFactor) && timeFactor > 0,
        `time_factor must be a positive integer, got ${timeFactor}`);
    }
  });
});
