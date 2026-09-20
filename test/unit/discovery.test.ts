import assert from 'node:assert/strict';
import { getBroadcastAddresses, discoverProclaim } from '../../src/discovery';

describe('getBroadcastAddresses', () => {
  test('returns discovered IPv4 broadcast addresses in dotted-quad format', () => {
    const addrs = getBroadcastAddresses();
    assert.ok(Array.isArray(addrs));
    for (const addr of addrs) {
      assert.match(addr, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
  });
});

describe('discoverProclaim', () => {
  test('reports a Proclaim server for any HTTP response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 401 }), {
      preconnect: globalThis.fetch.preconnect,
    });
    try {
      const result = await discoverProclaim(500);
      assert.deepEqual(result, { found: true, address: '127.0.0.1', port: 52195 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reports not found when the Proclaim connection is refused', async () => {
    const originalFetch = globalThis.fetch;
    const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    globalThis.fetch = Object.assign(async () => { throw error; }, {
      preconnect: globalThis.fetch.preconnect,
    });
    try {
      assert.deepEqual(await discoverProclaim(500), { found: false });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
