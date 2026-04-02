/**
 * Tests for the pending bus-send mechanism in x32.ts.
 *
 * When the client sends a setBusSend POST, we record a pending entry so that
 * stale OSC echoes from requestBusSendUpdates do not snap the fader back.
 *
 * The mechanism mirrors pendingFaders:
 * - applyBusSendPatchWithPending(key, patch, pendingBusSends) => Partial<BusSend>
 * - If no pending entry → apply normally.
 * - If pending and age < 2000ms and |incoming.level - pending.level| > 0.05 → suppress level.
 * - If pending and incoming is within 0.05 → confirmation; clear pending and apply.
 * - If pending entry expired (>= 2000ms) → clear and apply normally.
 */
import assert from 'node:assert/strict';
import { applyBusSendPatchWithPending } from '../../src/connections/x32';

describe('x32 pending bus-send mechanism', () => {
  describe('applyBusSendPatchWithPending()', () => {
    test('is exported', () => {
      assert.equal(typeof applyBusSendPatchWithPending, 'function');
    });

    test('applies level patch normally when no pending entry', () => {
      const pending = new Map<string, { level: number; sentAt: number }>();
      const result = applyBusSendPatchWithPending('ch1-bus8', { level: 0.8 }, pending);
      assert.deepEqual(result, { level: 0.8 });
    });

    test('suppresses level when pending exists and diff > 0.05', () => {
      const pending = new Map<string, { level: number; sentAt: number }>();
      pending.set('ch1-bus8', { level: 0.75, sentAt: Date.now() });
      const result = applyBusSendPatchWithPending('ch1-bus8', { level: 0.2 }, pending);
      assert.ok(!('level' in result), 'level should be suppressed');
    });

    test('applies and clears pending on confirmation (diff <= 0.05)', () => {
      const pending = new Map<string, { level: number; sentAt: number }>();
      pending.set('ch1-bus8', { level: 0.75, sentAt: Date.now() });
      const result = applyBusSendPatchWithPending('ch1-bus8', { level: 0.77 }, pending);
      assert.ok('level' in result, 'level should be applied on confirmation');
      assert.equal(result.level, 0.77);
      assert.ok(!pending.has('ch1-bus8'), 'pending entry should be cleared after confirmation');
    });

    test('clears expired pending (>= 2000ms) and applies normally', () => {
      const pending = new Map<string, { level: number; sentAt: number }>();
      pending.set('ch1-bus8', { level: 0.75, sentAt: Date.now() - 2001 });
      const result = applyBusSendPatchWithPending('ch1-bus8', { level: 0.2 }, pending);
      assert.ok(!pending.has('ch1-bus8'), 'expired entry should be cleared');
      assert.deepEqual(result, { level: 0.2 });
    });

    test('non-level fields (on) always pass through', () => {
      const pending = new Map<string, { level: number; sentAt: number }>();
      pending.set('ch1-bus8', { level: 0.75, sentAt: Date.now() });
      const result = applyBusSendPatchWithPending('ch1-bus8', { on: true }, pending);
      assert.deepEqual(result, { on: true });
    });

    test('pending for different key does not affect other key', () => {
      const pending = new Map<string, { level: number; sentAt: number }>();
      pending.set('ch1-bus8', { level: 0.75, sentAt: Date.now() });
      const result = applyBusSendPatchWithPending('ch2-bus8', { level: 0.3 }, pending);
      assert.deepEqual(result, { level: 0.3 });
    });

    test('patch with both level and on: level suppressed, on passes through', () => {
      const pending = new Map<string, { level: number; sentAt: number }>();
      pending.set('ch3-bus4', { level: 0.5, sentAt: Date.now() });
      const result = applyBusSendPatchWithPending('ch3-bus4', { level: 0.1, on: false }, pending);
      assert.ok(!('level' in result), 'level should be suppressed');
      assert.equal(result.on, false, 'on should pass through');
    });
  });
});
