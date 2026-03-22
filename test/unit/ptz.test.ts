import assert = require('node:assert/strict');
import { describe, test } from 'bun:test';
import {
  buildViscaPacket,
  panTiltCommand,
  zoomCommand,
  focusCommand,
  presetCommand,
  homeCommand,
} from '../../src/connections/ptz';

describe('VISCA command building', () => {
  describe('buildViscaPacket', () => {
    test('wraps payload with 8-byte VISCA/IP header', () => {
      const payload = [0x81, 0x01, 0x06, 0x04, 0xFF];
      const packet = buildViscaPacket(1, payload);
      assert.equal(packet.length, 8 + payload.length);
      // Payload type: 0x0100 = VISCA command
      assert.equal(packet[0], 0x01);
      assert.equal(packet[1], 0x00);
      // Payload length (big-endian)
      assert.equal(packet.readUInt16BE(2), payload.length);
      // Sequence number (big-endian)
      assert.equal(packet.readUInt32BE(4), 1);
      // Payload
      for (let i = 0; i < payload.length; i++) {
        assert.equal(packet[8 + i], payload[i]);
      }
    });

    test('encodes sequence number correctly', () => {
      const packet = buildViscaPacket(42, [0x81, 0xFF]);
      assert.equal(packet.readUInt32BE(4), 42);
    });
  });

  describe('panTiltCommand', () => {
    test('pan right, tilt up at given speeds', () => {
      const cmd = panTiltCommand(1, 1, 1, 12, 10);
      assert.deepEqual(cmd, [0x81, 0x01, 0x06, 0x01, 12, 10, 0x02, 0x01, 0xFF]);
    });

    test('pan left, tilt down', () => {
      const cmd = panTiltCommand(1, -1, -1, 5, 5);
      assert.deepEqual(cmd, [0x81, 0x01, 0x06, 0x01, 5, 5, 0x01, 0x02, 0xFF]);
    });

    test('stop (pan=0, tilt=0)', () => {
      const cmd = panTiltCommand(1, 0, 0, 1, 1);
      assert.deepEqual(cmd, [0x81, 0x01, 0x06, 0x01, 1, 1, 0x03, 0x03, 0xFF]);
    });

    test('pan only (tilt=0)', () => {
      const cmd = panTiltCommand(1, 1, 0, 8, 8);
      assert.deepEqual(cmd, [0x81, 0x01, 0x06, 0x01, 8, 8, 0x02, 0x03, 0xFF]);
    });

    test('clamps pan speed to 1–24', () => {
      const low = panTiltCommand(1, 1, 0, 0, 1);
      assert.equal(low[4], 1); // clamped from 0 to 1
      const high = panTiltCommand(1, 1, 0, 99, 1);
      assert.equal(high[4], 24); // clamped from 99 to 24
    });

    test('clamps tilt speed to 1–20', () => {
      const low = panTiltCommand(1, 0, 1, 1, 0);
      assert.equal(low[5], 1);
      const high = panTiltCommand(1, 0, 1, 1, 99);
      assert.equal(high[5], 20);
    });

    test('uses camera ID in address byte', () => {
      const cmd = panTiltCommand(2, 0, 0, 1, 1);
      assert.equal(cmd[0], 0x82); // 0x80 | 2
    });
  });

  describe('zoomCommand', () => {
    test('zoom in at speed 3', () => {
      const cmd = zoomCommand(1, 'in', 3);
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x07, 0x23, 0xFF]);
    });

    test('zoom out at speed 5', () => {
      const cmd = zoomCommand(1, 'out', 5);
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x07, 0x35, 0xFF]);
    });

    test('zoom stop', () => {
      const cmd = zoomCommand(1, 'stop', 0);
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x07, 0x00, 0xFF]);
    });

    test('clamps speed to 0–7', () => {
      const low = zoomCommand(1, 'in', -1);
      assert.equal(low[4], 0x20); // speed clamped to 0
      const high = zoomCommand(1, 'in', 99);
      assert.equal(high[4], 0x27); // speed clamped to 7
    });
  });

  describe('focusCommand', () => {
    test('auto focus', () => {
      const cmd = focusCommand(1, 'auto');
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x38, 0x02, 0xFF]);
    });

    test('manual focus', () => {
      const cmd = focusCommand(1, 'manual');
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x38, 0x03, 0xFF]);
    });

    test('focus far', () => {
      const cmd = focusCommand(1, 'far');
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x08, 0x02, 0xFF]);
    });

    test('focus near', () => {
      const cmd = focusCommand(1, 'near');
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x08, 0x03, 0xFF]);
    });

    test('focus stop', () => {
      const cmd = focusCommand(1, 'stop');
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x08, 0x00, 0xFF]);
    });
  });

  describe('presetCommand', () => {
    test('recall preset 0', () => {
      const cmd = presetCommand(1, 'recall', 0);
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x3F, 0x02, 0x00, 0xFF]);
    });

    test('save preset 5', () => {
      const cmd = presetCommand(1, 'save', 5);
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x3F, 0x01, 0x05, 0xFF]);
    });

    test('recall preset 8 (max typical)', () => {
      const cmd = presetCommand(1, 'recall', 8);
      assert.deepEqual(cmd, [0x81, 0x01, 0x04, 0x3F, 0x02, 0x08, 0xFF]);
    });
  });

  describe('homeCommand', () => {
    test('returns home command bytes', () => {
      const cmd = homeCommand(1);
      assert.deepEqual(cmd, [0x81, 0x01, 0x06, 0x04, 0xFF]);
    });
  });
});
