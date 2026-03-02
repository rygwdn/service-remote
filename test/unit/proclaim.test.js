const assert = require('node:assert/strict');

// We need to isolate the module for each test to reset module-level state.
// We do this by deleting from require cache after each test.
function freshProclaim() {
  // Clear cached modules so module-level vars are reset
  for (const key of Object.keys(require.cache)) {
    if (key.includes('connections/proclaim') || key.includes('src/config') || key.includes('src/state')) {
      delete require.cache[key];
    }
  }
  return require('../../src/connections/proclaim');
}

function mockFetch(responses) {
  let callIndex = 0;
  globalThis.fetch = async (url, opts) => {
    const resp = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    if (resp.throws) throw new Error(resp.throws);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status || 200,
      json: async () => resp.body,
      text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)),
      arrayBuffer: async () => Buffer.from(''),
    };
  };
}

describe('proclaim._authenticate', () => {
  afterEach(() => {
    // Remove mock fetch
    delete globalThis.fetch;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('connections/proclaim')) delete require.cache[key];
    }
  });

  test('returns token on success', async () => {
    mockFetch([{ status: 200, body: { proclaimAuthToken: 'abc123' } }]);
    const proclaim = freshProclaim();
    const token = await proclaim._authenticate();
    assert.equal(token, 'abc123');
  });

  test('throws on HTTP error', async () => {
    mockFetch([{ status: 403, body: {} }]);
    const proclaim = freshProclaim();
    await assert.rejects(() => proclaim._authenticate(), /auth failed/);
  });

  test('throws when token is missing from response', async () => {
    mockFetch([{ status: 200, body: { other: 'field' } }]);
    const proclaim = freshProclaim();
    await assert.rejects(() => proclaim._authenticate(), /no token/);
  });
});

describe('proclaim.sendAction', () => {
  afterEach(() => {
    delete globalThis.fetch;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('connections/proclaim')) delete require.cache[key];
    }
  });

  test('returns false when not authenticated', async () => {
    const proclaim = freshProclaim();
    const result = await proclaim.sendAction('NextSlide');
    assert.equal(result, false);
  });

  test('sends correct URL and headers after auth', async () => {
    let capturedUrl, capturedHeaders;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('authenticate')) {
        return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok1' }), text: async () => '' };
      }
      capturedUrl = url;
      capturedHeaders = opts && opts.headers;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };

    const proclaim = freshProclaim();
    await proclaim._authenticate().then((t) => {
      // Manually set internal token by connecting
    });

    // Use connect to set token, then sendAction
    // Since connect calls authenticate and startPolling, we need a controlled approach
    // Instead test authenticate result then sendAction via a fresh module with token set via connect
    // Reset and use a simpler fetch mock that sets the token
    delete globalThis.fetch;

    let fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, headers: opts && opts.headers });
      if (url.includes('authenticate')) {
        return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok1' }), text: async () => '' };
      }
      if (url.includes('onair/session')) {
        return { ok: true, status: 200, json: async () => null, text: async () => '' };
      }
      // perform endpoint
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };

    const proclaim2 = freshProclaim();
    await proclaim2.connect();
    // Wait a tick for async startPolling
    await new Promise((r) => setTimeout(r, 10));

    fetchCalls = [];
    const result = await proclaim2.sendAction('NextSlide');
    assert.equal(result, true);
    assert.ok(fetchCalls.length > 0);
    const performCall = fetchCalls.find((c) => c.url.includes('perform'));
    assert.ok(performCall, 'Expected a perform fetch call');
    assert.ok(performCall.url.includes('NextSlide'), 'URL should include command name');
    assert.equal(performCall.headers.ProclaimAuthToken, 'tok1');
  });

  test('includes index in URL when provided', async () => {
    let fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, headers: opts && opts.headers });
      if (url.includes('authenticate')) {
        return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok2' }), text: async () => '' };
      }
      if (url.includes('onair/session')) {
        return { ok: true, status: 200, json: async () => null, text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };

    const proclaim = freshProclaim();
    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 10));

    fetchCalls = [];
    await proclaim.sendAction('GoToServiceItem', 3);
    const performCall = fetchCalls.find((c) => c.url.includes('perform'));
    assert.ok(performCall.url.includes('index=3'), 'URL should include index');
  });
});

describe('proclaim._pollStatus', () => {
  afterEach(() => {
    delete globalThis.fetch;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('connections/proclaim') || key.includes('src/state')) {
        delete require.cache[key];
      }
    }
  });

  test('sets connected=true, onAir=false when session returns empty', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('authenticate')) {
        return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok' }), text: async () => '' };
      }
      if (url.includes('onair/session')) {
        return { ok: true, status: 200, json: async () => null, text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => null, text: async () => '' };
    };

    const proclaim = freshProclaim();
    const state = require('../../src/state');
    const updates = [];
    state.on('change', ({ section, state: s }) => {
      if (section === 'proclaim') updates.push({ ...s.proclaim });
    });

    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 50));

    const lastUpdate = updates[updates.length - 1];
    assert.equal(lastUpdate.connected, true);
    assert.equal(lastUpdate.onAir, false);
  });

  test('sets connected=false on network error and schedules reconnect', async () => {
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount++;
      if (url.includes('authenticate')) {
        return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok' }), text: async () => '' };
      }
      throw new Error('Network error');
    };

    const proclaim = freshProclaim();
    const state = require('../../src/state');
    const updates = [];
    state.on('change', ({ section, state: s }) => {
      if (section === 'proclaim') updates.push({ ...s.proclaim });
    });

    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 50));

    const disconnectedUpdate = updates.find((u) => u.connected === false);
    assert.ok(disconnectedUpdate, 'Expected a disconnected state update');
  });

  test('clears token and schedules reconnect on 401', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('authenticate')) {
        return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok' }), text: async () => '' };
      }
      return { ok: false, status: 401, json: async () => null, text: async () => '' };
    };

    const proclaim = freshProclaim();
    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 50));

    // After 401, token should be cleared and getToken returns null
    assert.equal(proclaim.getToken(), null);
  });
});
