const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { merge } = require('../../src/config');

describe('config merge()', () => {
  test('returns base fields when override is empty', () => {
    assert.deepEqual(merge({ a: 1, b: 2 }, {}), { a: 1, b: 2 });
  });

  test('override values replace base values', () => {
    assert.deepEqual(merge({ a: 1 }, { a: 99 }), { a: 99 });
  });

  test('override adds new keys not in base', () => {
    assert.deepEqual(merge({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  });

  test('nested objects are merged recursively', () => {
    const result = merge(
      { server: { port: 3000, host: 'localhost' } },
      { server: { port: 4000 } }
    );
    assert.deepEqual(result, { server: { port: 4000, host: 'localhost' } });
  });

  test('arrays in override replace (not merge) base arrays', () => {
    const result = merge(
      { items: [1, 2, 3] },
      { items: [4, 5] }
    );
    assert.deepEqual(result.items, [4, 5]);
  });

  test('null override value replaces base object', () => {
    const result = merge({ obs: { password: 'secret' } }, { obs: null });
    assert.equal(result.obs, null);
  });

  test('does not mutate the base object', () => {
    const base = { a: { x: 1 } };
    merge(base, { a: { y: 2 } });
    assert.deepEqual(base, { a: { x: 1 } });
  });

  test('deeply nested merge', () => {
    const result = merge(
      { a: { b: { c: 1, d: 2 } } },
      { a: { b: { c: 99 } } }
    );
    assert.deepEqual(result, { a: { b: { c: 99, d: 2 } } });
  });
});
