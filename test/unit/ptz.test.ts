import { strict as assert } from 'node:assert';
import { describe, test } from 'bun:test';
import ptz = require('../../src/connections/ptz');
const { buildViscaPacket, encodePos, decodePos, absPanTiltCommand, absZoomCommand, panTiltInquiry, zoomInquiry, focusCommand, presetCommand, homeCommand } = ptz;

describe('VISCA command building', () => {
  describe('buildViscaPacket', () => {
    test('wraps payload with 8-byte VISCA/IP header', () => {
      const payload = [0x81, 0x01, 0x06, 0x04, 0xFF];
      const packet = buildViscaPacket(1, payload);
      assert.equal(packet.length, 8 + payload.length);
      assert.equal(packet[0], 0x01); // payload type high
      assert.equal(packet[1], 0x00); // payload type low
      assert.equal(packet.readUInt16BE(2), payload.length);
      assert.equal(packet.readUInt32BE(4), 1);
      for (let i = 0; i < payload.length; i++) assert.equal(packet[8 + i], payload[i]);
    });

    test('encodes sequence number correctly', () => {
      const packet = buildViscaPacket(42, [0x81, 0xFF]);
      assert.equal(packet.readUInt32BE(4), 42);
    });
  });

  describe('encodePos / decodePos', () => {
    test('encodes zero as four zero nibbles', () => {
      assert.deepEqual(encodePos(0), [0, 0, 0, 0]);
    });

    test('encodes a positive value correctly', () => {
      // 880 = 0x0370 → nibbles [0, 3, 7, 0]
      assert.deepEqual(encodePos(880), [0x00, 0x03, 0x07, 0x00]);
    });

    test('encodes a negative value as two\'s complement', () => {
      // -880 = 0xFC90 → nibbles [F, C, 9, 0]
      assert.deepEqual(encodePos(-880), [0x0F, 0x0C, 0x09, 0x00]);
    });

    test('encodes -1 (0xFFFF) as all F nibbles', () => {
      assert.deepEqual(encodePos(-1), [0x0F, 0x0F, 0x0F, 0x0F]);
    });

    test('round-trips positive values through encode/decode', () => {
      for (const v of [0, 1, 100, 880, 300, 16384]) {
        assert.equal(decodePos(encodePos(v)), v, `round-trip failed for ${v}`);
      }
    });

    test('round-trips negative values through encode/decode', () => {
      for (const v of [-1, -100, -880, -300]) {
        assert.equal(decodePos(encodePos(v)), v, `round-trip failed for ${v}`);
      }
    });
  });

  describe('absPanTiltCommand', () => {
    test('builds absolute pan/tilt command with encoded positions', () => {
      const cmd = absPanTiltCommand(1, 0, 0, 12, 10);
      // 81 01 06 02 VV WW [pan 4] [tilt 4] FF
      assert.equal(cmd[0], 0x81);
      assert.equal(cmd[1], 0x01);
      assert.equal(cmd[2], 0x06);
      assert.equal(cmd[3], 0x02);
      assert.equal(cmd[4], 12);   // pan speed
      assert.equal(cmd[5], 10);   // tilt speed
      // pan=0 → [0,0,0,0], tilt=0 → [0,0,0,0]
      assert.deepEqual(cmd.slice(6, 10), [0, 0, 0, 0]);
      assert.deepEqual(cmd.slice(10, 14), [0, 0, 0, 0]);
      assert.equal(cmd[14], 0xFF);
      assert.equal(cmd.length, 15);
    });

    test('encodes non-zero pan and tilt positions', () => {
      const cmd = absPanTiltCommand(1, 880, -300, 12, 10);
      // pan=880=0x0370 → [0,3,7,0]; tilt=-300=0xFED4 → [F,E,D,4]
      assert.deepEqual(cmd.slice(6, 10), [0x00, 0x03, 0x07, 0x00]);
      assert.deepEqual(cmd.slice(10, 14), [0x0F, 0x0E, 0x0D, 0x04]);
    });

    test('clamps pan speed to 1–24', () => {
      assert.equal(absPanTiltCommand(1, 0, 0, 0, 1)[4], 1);
      assert.equal(absPanTiltCommand(1, 0, 0, 99, 1)[4], 24);
    });

    test('clamps tilt speed to 1–20', () => {
      assert.equal(absPanTiltCommand(1, 0, 0, 1, 0)[5], 1);
      assert.equal(absPanTiltCommand(1, 0, 0, 1, 99)[5], 20);
    });

    test('uses camera ID in address byte', () => {
      assert.equal(absPanTiltCommand(2, 0, 0, 1, 1)[0], 0x82);
    });
  });

  describe('absZoomCommand', () => {
    test('builds absolute zoom command for position 0 (wide)', () => {
      const cmd = absZoomCommand(1, 0);
      // 81 01 04 47 [zoom 4 nibbles] FF
      assert.equal(cmd[0], 0x81);
      assert.equal(cmd[1], 0x01);
      assert.equal(cmd[2], 0x04);
      assert.equal(cmd[3], 0x47);
      assert.deepEqual(cmd.slice(4, 8), [0, 0, 0, 0]);
      assert.equal(cmd[8], 0xFF);
      assert.equal(cmd.length, 9);
    });

    test('encodes a mid-range zoom position', () => {
      // 0x4000 = 16384 → nibbles [4, 0, 0, 0]
      const cmd = absZoomCommand(1, 0x4000);
      assert.deepEqual(cmd.slice(4, 8), [0x04, 0x00, 0x00, 0x00]);
    });

    test('clamps zoom to 0–16384', () => {
      assert.deepEqual(absZoomCommand(1, -1).slice(4, 8), [0, 0, 0, 0]);
      assert.deepEqual(absZoomCommand(1, 99999).slice(4, 8), [0x04, 0x00, 0x00, 0x00]);
    });
  });

  describe('panTiltInquiry', () => {
    test('returns correct inquiry bytes', () => {
      assert.deepEqual(panTiltInquiry(1), [0x81, 0x09, 0x06, 0x12, 0xFF]);
    });

    test('uses camera ID in address byte', () => {
      assert.equal(panTiltInquiry(2)[0], 0x82);
    });
  });

  describe('zoomInquiry', () => {
    test('returns correct inquiry bytes', () => {
      assert.deepEqual(zoomInquiry(1), [0x81, 0x09, 0x04, 0x47, 0xFF]);
    });
  });

  describe('focusCommand', () => {
    test('auto focus', () => {
      assert.deepEqual(focusCommand(1, 'auto'),   [0x81, 0x01, 0x04, 0x38, 0x02, 0xFF]);
    });
    test('manual focus', () => {
      assert.deepEqual(focusCommand(1, 'manual'), [0x81, 0x01, 0x04, 0x38, 0x03, 0xFF]);
    });
    test('focus far', () => {
      assert.deepEqual(focusCommand(1, 'far'),    [0x81, 0x01, 0x04, 0x08, 0x02, 0xFF]);
    });
    test('focus near', () => {
      assert.deepEqual(focusCommand(1, 'near'),   [0x81, 0x01, 0x04, 0x08, 0x03, 0xFF]);
    });
    test('focus stop', () => {
      assert.deepEqual(focusCommand(1, 'stop'),   [0x81, 0x01, 0x04, 0x08, 0x00, 0xFF]);
    });
  });

  describe('presetCommand', () => {
    test('recall preset 0', () => {
      assert.deepEqual(presetCommand(1, 'recall', 0), [0x81, 0x01, 0x04, 0x3F, 0x02, 0x00, 0xFF]);
    });
    test('save preset 5', () => {
      assert.deepEqual(presetCommand(1, 'save', 5),   [0x81, 0x01, 0x04, 0x3F, 0x01, 0x05, 0xFF]);
    });
    test('recall preset 8', () => {
      assert.deepEqual(presetCommand(1, 'recall', 8), [0x81, 0x01, 0x04, 0x3F, 0x02, 0x08, 0xFF]);
    });
  });

  describe('homeCommand', () => {
    test('returns home command bytes', () => {
      assert.deepEqual(homeCommand(1), [0x81, 0x01, 0x06, 0x04, 0xFF]);
    });
  });
});
