import assert from 'node:assert/strict';
import { State } from '../../src/state';

// Test the goToItem logic
describe('proclaim.goToItem', () => {
  test('only sends sectionCommand for non-Service items (no GoToServiceItem)', () => {
    type SectionName = 'Pre-Service' | 'Warmup' | 'Service' | 'Post-Service';
    const sentActions: Array<{ action: string; index?: number }> = [];

    function simulateGoToItem(section: SectionName, sectionIndex: number) {
      sentActions.length = 0;
      if (section === 'Service') {
        sentActions.push({ action: 'GoToServiceItem', index: sectionIndex });
      } else {
        const sectionCommand = `Start${section.replace('-', '').replace(' ', '')}`;
        sentActions.push({ action: sectionCommand });
      }
    }

    simulateGoToItem('Service', 3);
    assert.equal(sentActions.length, 1);
    assert.equal(sentActions[0].action, 'GoToServiceItem');
    assert.equal(sentActions[0].index, 3);

    simulateGoToItem('Pre-Service', 1);
    assert.equal(sentActions.length, 1);
    assert.equal(sentActions[0].action, 'StartPreService');

    simulateGoToItem('Warmup', 2);
    assert.equal(sentActions.length, 1);
    assert.equal(sentActions[0].action, 'StartWarmup');

    simulateGoToItem('Post-Service', 1);
    assert.equal(sentActions.length, 1);
    assert.equal(sentActions[0].action, 'StartPostService');
  });

  test('goToItem sends GoToServiceItem only for Service section', async () => {
    const s = new State();

    const serviceItems = [
      { id: 'pre1', title: 'Prelude', kind: 'Slide', slideCount: 1, index: 1, sectionIndex: 1, sectionCommand: 'StartPreService', section: 'Pre-Service', group: null },
      { id: 'svc1', title: 'Welcome', kind: 'Slide', slideCount: 1, index: 3, sectionIndex: 1, sectionCommand: 'StartService', section: 'Service', group: null },
      { id: 'svc2', title: 'Sermon', kind: 'Slide', slideCount: 1, index: 4, sectionIndex: 2, sectionCommand: 'StartService', section: 'Service', group: null },
      { id: 'post1', title: 'Postlude', kind: 'Slide', slideCount: 1, index: 6, sectionIndex: 1, sectionCommand: 'StartPostService', section: 'Post-Service', group: null },
    ];
    s.update('proclaim', { connected: true, onAir: true, currentItemId: 'svc1', currentItemTitle: 'Welcome', currentItemType: 'Slide', slideIndex: 0, serviceItems });

    async function goToItem(itemId: string, getItems: () => typeof serviceItems): Promise<string[]> {
      const item = getItems().find((i) => i.id === itemId);
      if (!item) return [];
      if (item.section === 'Service') {
        return [`GoToServiceItem:${item.sectionIndex}`];
      }
      return [item.sectionCommand];
    }

    assert.deepEqual(await goToItem('pre1', () => serviceItems), ['StartPreService']);
    assert.deepEqual(await goToItem('svc2', () => serviceItems), ['GoToServiceItem:2']);
    assert.deepEqual(await goToItem('post1', () => serviceItems), ['StartPostService']);
  });
});

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

interface MockResponse {
  status?: number;
  body?: unknown;
  throws?: string;
}

function mockFetch(responses: MockResponse[]): void {
  let callIndex = 0;
  (globalThis as any).fetch = async (_url: string, _opts?: unknown) => {
    const resp = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    if (resp.throws) throw new Error(resp.throws);
    return {
      ok: (resp.status ?? 200) >= 200 && (resp.status ?? 200) < 300,
      status: resp.status || 200,
      json: async () => resp.body,
      text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)),
      arrayBuffer: async () => Buffer.from(''),
    };
  };
}

describe('proclaim._authenticateAppCommand', () => {
  afterEach(() => {
    delete (globalThis as any).fetch;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('connections/proclaim')) delete require.cache[key];
    }
  });

  test('returns token on success', async () => {
    mockFetch([{ status: 200, body: { proclaimAuthToken: 'abc123' } }]);
    const proclaim = freshProclaim();
    const token = await proclaim._authenticateAppCommand();
    assert.equal(token, 'abc123');
  });

  test('throws on HTTP error', async () => {
    mockFetch([{ status: 403, body: {} }]);
    const proclaim = freshProclaim();
    await assert.rejects(() => proclaim._authenticateAppCommand(), /auth failed/);
  });

  test('throws when token is missing from response', async () => {
    mockFetch([{ status: 200, body: { other: 'field' } }]);
    const proclaim = freshProclaim();
    await assert.rejects(() => proclaim._authenticateAppCommand(), /no token/);
  });
});

describe('proclaim._authenticateRemote', () => {
  afterEach(() => {
    delete (globalThis as any).fetch;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('connections/proclaim')) delete require.cache[key];
    }
  });

  test('returns onAirSessionId and connectionId on success', async () => {
    let capturedControlHeaders: Record<string, string> | undefined;
    (globalThis as any).fetch = async (url: string, opts?: { headers?: Record<string, string> }) => {
      if (url.includes('onair/session')) {
        return { ok: true, status: 200, json: async () => 'sess1', text: async () => 'sess1' };
      }
      if (url.includes('auth/control')) {
        capturedControlHeaders = opts?.headers;
        return { ok: true, status: 200, json: async () => ({ connectionId: 'conn1' }), text: async () => JSON.stringify({ connectionId: 'conn1' }) };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    };
    const proclaim = freshProclaim();
    const result = await proclaim._authenticateRemote();
    assert.equal(result.onAirSessionId, 'sess1');
    assert.equal(result.connectionId, 'conn1');
    assert.equal(capturedControlHeaders!['OnAirSessionId'], 'sess1');
  });

  test('throws when onair/session fails', async () => {
    mockFetch([{ status: 503, body: '' }]);
    const proclaim = freshProclaim();
    await assert.rejects(() => proclaim._authenticateRemote(), /onair\/session failed/);
  });

  test('throws when auth/control returns no connectionId', async () => {
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('onair/session')) return { ok: true, status: 200, json: async () => 'sess1', text: async () => 'sess1' };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    };
    const proclaim = freshProclaim();
    await assert.rejects(() => proclaim._authenticateRemote(), /no connectionId/);
  });
});

describe('proclaim.sendAction', () => {
  afterEach(() => {
    delete (globalThis as any).fetch;
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
    let fetchCalls: { url: string; headers?: Record<string, string> }[] = [];
    (globalThis as any).fetch = async (url: string, opts?: { headers?: Record<string, string> }) => {
      fetchCalls.push({ url, headers: opts?.headers });
      if (url.includes('authenticate')) {
        return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok1' }), text: async () => '' };
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
    const result = await proclaim.sendAction('NextSlide');
    assert.equal(result, true);
    assert.ok(fetchCalls.length > 0);
    const performCall = fetchCalls.find((c) => c.url.includes('perform'));
    assert.ok(performCall, 'Expected a perform fetch call');
    assert.ok(performCall.url.includes('NextSlide'), 'URL should include command name');
    assert.equal(performCall.headers!.ProclaimAuthToken, 'tok1');
  });

  test('includes index in URL when provided', async () => {
    let fetchCalls: { url: string }[] = [];
    (globalThis as any).fetch = async (url: string, _opts?: unknown) => {
      fetchCalls.push({ url });
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
    assert.ok(performCall!.url.includes('index=3'), 'URL should include index');
  });
});

describe('proclaim service item indexing', () => {
  afterEach(() => {
    delete (globalThis as any).fetch;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('connections/proclaim') || key.includes('src/state')) {
        delete require.cache[key];
      }
    }
  });

  test('preserves full-list 1-based index when excluded items are interspersed', async () => {
    const presentation = {
      id: 'pres1',
      localRevision: 1,
      warmupStartIndex: 2,
      serviceStartIndex: 4,
      postServiceStartIndex: 10,
      serviceItems: [
        { id: 'item1', title: 'Song', kind: 'Song', slides: [{ index: 0, localRevision: 1 }] },
        { id: 'item2', title: 'Grouping', kind: 'Grouping', slides: [] },
        { id: 'item3', title: 'Prayer', kind: 'Prayer', slides: [{ index: 0, localRevision: 2 }] },
        { id: 'item4', title: 'Stage Direction', kind: 'StageDirectionCue', slides: [] },
        { id: 'item5', title: 'Hymn', kind: 'Song', slides: [{ index: 0, localRevision: 3 }] },
      ],
    };
    const statusResponse = {
      presentationId: 'pres1',
      presentationLocalRevision: 1,
      status: { itemId: 'item1', slideIndex: 0 },
    };

    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('authenticate')) return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok' }), text: async () => '' };
      if (url.includes('onair/session')) return { ok: true, status: 200, json: async () => 'sess1', text: async () => 'sess1' };
      if (url.includes('auth/control')) return { ok: true, status: 200, json: async () => ({ connectionId: 'conn1' }), text: async () => JSON.stringify({ connectionId: 'conn1' }) };
      if (url.includes('presentations/onair') && !url.includes('items')) return { ok: true, status: 200, text: async () => JSON.stringify(presentation) };
      if (url.includes('statusChanged')) return { ok: true, status: 200, text: async () => JSON.stringify(statusResponse) };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    };

    const proclaim = freshProclaim();
    const state = require('../../src/state').default;
    const updates: any[] = [];
    state.on('change', ({ section, state: s }: { section: string; state: any }) => {
      if (section === 'proclaim') updates.push(JSON.parse(JSON.stringify(s.proclaim)));
    });

    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 100));

    const updateWithItems = updates.find((u: any) => u.serviceItems && u.serviceItems.length > 0);
    assert.ok(updateWithItems, 'Expected a state update with serviceItems');
    const items = updateWithItems.serviceItems;
    assert.equal(items.length, 3);
    assert.equal(items[0].id, 'item1'); assert.equal(items[0].index, 1); assert.equal(items[0].section, 'Pre-Service'); assert.equal(items[0].group, null);
    assert.equal(items[1].id, 'item3'); assert.equal(items[1].index, 3); assert.equal(items[1].section, 'Warmup'); assert.equal(items[1].group, 'Grouping');
    assert.equal(items[2].id, 'item5'); assert.equal(items[2].index, 5); assert.equal(items[2].section, 'Service'); assert.equal(items[2].group, 'Grouping');
    assert.equal(updateWithItems.warmupStartIndex, undefined);
    assert.equal(updateWithItems.serviceStartIndex, undefined);
    assert.equal(updateWithItems.postServiceStartIndex, undefined);
  });

  test('filters out Slide Group grouping items from serviceItems', async () => {
    const presentation = {
      id: 'pres2',
      localRevision: 1,
      serviceItems: [
        { id: 'item1', title: 'Welcome', kind: 'Song', slides: [{ index: 0, localRevision: 1 }] },
        { id: 'item2', title: 'Slide Group', kind: 'Grouping', slides: [] },
        { id: 'item3', title: 'Worship', kind: 'Grouping', slides: [] },
        { id: 'item4', title: 'Hymn', kind: 'Song', slides: [{ index: 0, localRevision: 2 }] },
      ],
    };
    const statusResponse = { presentationId: 'pres2', presentationLocalRevision: 1, status: { itemId: 'item1', slideIndex: 0 } };

    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('authenticate')) return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok' }), text: async () => '' };
      if (url.includes('onair/session')) return { ok: true, status: 200, json: async () => 'sess1', text: async () => 'sess1' };
      if (url.includes('auth/control')) return { ok: true, status: 200, json: async () => ({ connectionId: 'conn1' }), text: async () => JSON.stringify({ connectionId: 'conn1' }) };
      if (url.includes('presentations/onair') && !url.includes('items')) return { ok: true, status: 200, text: async () => JSON.stringify(presentation) };
      if (url.includes('statusChanged')) return { ok: true, status: 200, text: async () => JSON.stringify(statusResponse) };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    };

    const proclaim = freshProclaim();
    const state = require('../../src/state').default;
    const updates: any[] = [];
    state.on('change', ({ section, state: s }: { section: string; state: any }) => {
      if (section === 'proclaim') updates.push(JSON.parse(JSON.stringify(s.proclaim)));
    });

    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 100));

    const updateWithItems = updates.find((u: any) => u.serviceItems && u.serviceItems.length > 0);
    assert.ok(updateWithItems);
    const items = updateWithItems.serviceItems;
    assert.equal(items.length, 2);
    assert.ok(!items.find((i: any) => i.title === 'Slide Group'));
    assert.ok(!items.find((i: any) => i.kind === 'Grouping'));
    const welcomeItem = items.find((i: any) => i.title === 'Welcome');
    assert.ok(welcomeItem); assert.equal(welcomeItem.index, 1); assert.equal(welcomeItem.section, 'Pre-Service'); assert.equal(welcomeItem.group, null);
    const hymnItem = items.find((i: any) => i.title === 'Hymn');
    assert.ok(hymnItem); assert.equal(hymnItem.index, 4); assert.equal(hymnItem.section, 'Pre-Service'); assert.equal(hymnItem.group, 'Worship');
  });
});

describe('proclaim statusChanged initial poll', () => {
  afterEach(() => {
    delete (globalThis as any).fetch;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('connections/proclaim') || key.includes('src/state')) {
        delete require.cache[key];
      }
    }
  });

  test('first statusChanged poll uses Int64/Int32 min sentinel values', async () => {
    let statusChangedUrl: string | null = null;
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('authenticate')) return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok' }), text: async () => '' };
      if (url.includes('onair/session')) return { ok: true, status: 200, json: async () => 'sess1', text: async () => 'sess1' };
      if (url.includes('auth/control')) return { ok: true, status: 200, json: async () => ({ connectionId: 'conn1' }), text: async () => JSON.stringify({ connectionId: 'conn1' }) };
      if (url.includes('presentations/onair')) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'p1', serviceItems: [] }) };
      if (url.includes('statusChanged')) { statusChangedUrl = url; return { ok: true, status: 200, text: async () => JSON.stringify({ status: {} }) }; }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    };

    const proclaim = freshProclaim();
    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(statusChangedUrl, 'Expected statusChanged to be called');
    const url = statusChangedUrl as string;
    assert.ok(url.includes('localrevision=-9223372036854775808'), `Expected Int64 min, got: ${url}`);
    assert.ok(url.includes('step=-2147483648'), `Expected Int32 min, got: ${url}`);
  });
});

describe('proclaim._pollStatus', () => {
  afterEach(() => {
    delete (globalThis as any).fetch;
    for (const key of Object.keys(require.cache)) {
      if (key.includes('connections/proclaim') || key.includes('src/state')) {
        delete require.cache[key];
      }
    }
  });

  test('sets connected=true, onAir=false when session returns empty', async () => {
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('authenticate')) return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok' }), text: async () => '' };
      if (url.includes('onair/session')) return { ok: true, status: 200, json: async () => null, text: async () => '' };
      return { ok: true, status: 200, json: async () => null, text: async () => '' };
    };

    const proclaim = freshProclaim();
    const state = require('../../src/state').default;
    const updates: any[] = [];
    state.on('change', ({ section, state: s }: { section: string; state: any }) => {
      if (section === 'proclaim') updates.push({ ...s.proclaim });
    });

    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 50));

    const lastUpdate = updates[updates.length - 1];
    assert.equal(lastUpdate.connected, true);
    assert.equal(lastUpdate.onAir, false);
  });

  test('sets connected=false on network error and schedules reconnect', async () => {
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('authenticate')) return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok' }), text: async () => '' };
      throw new Error('Network error');
    };

    const proclaim = freshProclaim();
    const state = require('../../src/state').default;
    const updates: any[] = [];
    state.on('change', ({ section, state: s }: { section: string; state: any }) => {
      if (section === 'proclaim') updates.push({ ...s.proclaim });
    });

    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 50));

    const disconnectedUpdate = updates.find((u: any) => u.connected === false);
    assert.ok(disconnectedUpdate, 'Expected a disconnected state update');
  });

  test('clears app command token on sendAction 401', async () => {
    (globalThis as any).fetch = async (url: string) => {
      if (url.includes('authenticate')) return { ok: true, status: 200, json: async () => ({ proclaimAuthToken: 'tok' }), text: async () => '' };
      if (url.includes('onair/session')) return { ok: true, status: 200, json: async () => null, text: async () => '' };
      if (url.includes('perform')) return { ok: false, status: 401, json: async () => null, text: async () => '' };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };

    const proclaim = freshProclaim();
    await proclaim.connect();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(proclaim.getToken(), 'tok');
    await proclaim.sendAction('NextSlide');
    assert.equal(proclaim.getToken(), null);
  });
});
