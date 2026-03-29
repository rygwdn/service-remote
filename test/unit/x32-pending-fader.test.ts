/**
 * Tests for the pending fader mechanism in x32.ts.
 *
 * When the client sends a fader POST, we record a pending entry so that
 * stale OSC echoes from the X32 (generated before or during the drag)
 * do not snap the slider back to a different value.
 *
 * The mechanism:
 * - setPendingFader(type, index, value) records { value, sentAt: Date.now() }
 * - When an OSC fader update arrives for that channel:
 *   - If a pending entry exists AND sentAt is < 2000ms ago AND the incoming
 *     value differs by > 0.05, skip updating the fader in state.
 *   - If the incoming value is within 0.05 of the pending value, clear the
 *     pending entry (X32 confirmed our command).
 *   - If the pending entry is >= 2000ms old, clear it and apply the update normally.
 * - Non-fader fields (muted, label) are always applied regardless of pending state.
 */
import assert from 'node:assert/strict';
import { parseOscMessage, setPendingFader, applyOscPatchWithPending } from '../../src/connections/x32';

// applyOscPatchWithPending is the pure testable function that applies an OSC-parsed
// patch to a channel object, respecting the pending fader map.
// Signature: applyOscPatchWithPending(channel, patch, pendingFaders) => Partial<Channel>
// Returns the patch that should actually be applied (may have 'fader' removed).

describe('x32 pending fader mechanism', () => {
  describe('setPendingFader()', () => {
    test('setPendingFader is exported', () => {
      assert.equal(typeof setPendingFader, 'function');
    });

    test('setPendingFader does not throw for valid inputs', () => {
      assert.doesNotThrow(() => setPendingFader('ch', 1, 0.75));
      assert.doesNotThrow(() => setPendingFader('bus', 3, 0.5));
      assert.doesNotThrow(() => setPendingFader('main', 1, 0.9));
    });
  });

  describe('applyOscPatchWithPending()', () => {
    test('applyOscPatchWithPending is exported', () => {
      assert.equal(typeof applyOscPatchWithPending, 'function');
    });

    test('applies fader patch normally when no pending entry exists', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      const result = applyOscPatchWithPending({ type: 'ch', index: 1 }, { fader: 0.8 }, pendingFaders);
      assert.deepEqual(result, { fader: 0.8 });
    });

    test('skips fader update when pending entry exists and incoming differs by > 0.05', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() });
      const result = applyOscPatchWithPending({ type: 'ch', index: 1 }, { fader: 0.2 }, pendingFaders);
      // fader should be excluded from the result patch
      assert.ok(!('fader' in result), 'fader should be skipped when pending exists and value differs > 0.05');
    });

    test('clears pending entry when incoming fader is within 0.05 of pending value', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() });
      applyOscPatchWithPending({ type: 'ch', index: 1 }, { fader: 0.77 }, pendingFaders);
      // pending entry should be cleared after confirmation
      assert.ok(!pendingFaders.has('ch-1'), 'pending entry should be cleared on confirmation');
    });

    test('applies fader when incoming is within 0.05 of pending (confirmation)', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() });
      const result = applyOscPatchWithPending({ type: 'ch', index: 1 }, { fader: 0.77 }, pendingFaders);
      assert.ok('fader' in result, 'fader should be applied on confirmation');
      assert.equal(result.fader, 0.77);
    });

    test('diff of 0.04 is treated as confirmed (within tolerance)', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() });
      // 0.75 - 0.71 = 0.04, well within the 0.05 tolerance → confirmation
      const result = applyOscPatchWithPending({ type: 'ch', index: 1 }, { fader: 0.71 }, pendingFaders);
      assert.ok('fader' in result);
    });

    test('diff of 0.06 is skipped (outside tolerance)', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() });
      // 0.75 - 0.69 = 0.06, outside the 0.05 tolerance → skipped
      const result = applyOscPatchWithPending({ type: 'ch', index: 1 }, { fader: 0.69 }, pendingFaders);
      assert.ok(!('fader' in result));
    });

    test('clears expired pending entry (>= 2000ms) and applies fader normally', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      // Set sentAt to 2001ms ago (expired)
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() - 2001 });
      const result = applyOscPatchWithPending({ type: 'ch', index: 1 }, { fader: 0.2 }, pendingFaders);
      // expired pending should be cleared
      assert.ok(!pendingFaders.has('ch-1'), 'expired pending entry should be cleared');
      // fader should be applied normally
      assert.deepEqual(result, { fader: 0.2 });
    });

    test('non-fader fields (muted) are always applied even when pending fader exists', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() });
      const result = applyOscPatchWithPending({ type: 'ch', index: 1 }, { muted: true }, pendingFaders);
      assert.deepEqual(result, { muted: true });
    });

    test('non-fader fields (label) are always applied even when pending fader exists', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() });
      const result = applyOscPatchWithPending({ type: 'ch', index: 1 }, { label: 'Drums' }, pendingFaders);
      assert.deepEqual(result, { label: 'Drums' });
    });

    test('patch with both fader and other fields: fader is skipped, other fields pass through', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-2', { value: 0.5, sentAt: Date.now() });
      const result = applyOscPatchWithPending({ type: 'ch', index: 2 }, { fader: 0.1, muted: false }, pendingFaders);
      assert.ok(!('fader' in result), 'fader should be skipped');
      assert.equal(result.muted, false, 'muted should pass through');
    });

    test('pending entry for different channel does not affect other channel', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() });
      // ch-2 has no pending entry
      const result = applyOscPatchWithPending({ type: 'ch', index: 2 }, { fader: 0.3 }, pendingFaders);
      assert.deepEqual(result, { fader: 0.3 });
    });

    test('pending entry for ch does not affect bus channel with same index', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('ch-1', { value: 0.75, sentAt: Date.now() });
      const result = applyOscPatchWithPending({ type: 'bus', index: 1 }, { fader: 0.3 }, pendingFaders);
      assert.deepEqual(result, { fader: 0.3 });
    });

    test('pending entry for bus type uses correct key', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      pendingFaders.set('bus-3', { value: 0.6, sentAt: Date.now() });
      const result = applyOscPatchWithPending({ type: 'bus', index: 3 }, { fader: 0.1 }, pendingFaders);
      assert.ok(!('fader' in result), 'bus pending entry should suppress fader update');
    });

    test('empty patch is returned unchanged', () => {
      const pendingFaders = new Map<string, { value: number; sentAt: number }>();
      const result = applyOscPatchWithPending({ type: 'ch', index: 1 }, {}, pendingFaders);
      assert.deepEqual(result, {});
    });
  });
});
