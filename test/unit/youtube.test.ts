import { test, expect, describe, mock, beforeEach, spyOn } from 'bun:test';
import youtube = require('../../src/connections/youtube');
const { parseApiResponse, parseIni, extractCredsFromIni, seedAccessToken, getAccessTokenForTesting, parseBroadcastsResponse } = youtube;

describe('parseApiResponse', () => {
  test('returns nulls when items array is empty', () => {
    const result = parseApiResponse({ items: [] });
    expect(result).toEqual({ viewerCount: null, broadcastTitle: null, broadcastStatus: null });
  });

  test('returns nulls when items is missing', () => {
    const result = parseApiResponse({});
    expect(result).toEqual({ viewerCount: null, broadcastTitle: null, broadcastStatus: null });
  });

  test('parses viewerCount and broadcastTitle from a valid response', () => {
    const data = {
      items: [{
        liveStreamingDetails: { concurrentViewers: '1234' },
        snippet: { title: 'Sunday Service' },
      }],
    };
    const result = parseApiResponse(data);
    expect(result.viewerCount).toBe(1234);
    expect(result.broadcastTitle).toBe('Sunday Service');
  });

  test('returns broadcastStatus live when actualStartTime set but no actualEndTime', () => {
    const data = {
      items: [{
        liveStreamingDetails: {
          concurrentViewers: '50',
          actualStartTime: '2026-01-01T10:00:00Z',
        },
        snippet: { title: 'Service' },
      }],
    };
    expect(parseApiResponse(data).broadcastStatus).toBe('live');
  });

  test('returns broadcastStatus complete when actualEndTime is set', () => {
    const data = {
      items: [{
        liveStreamingDetails: {
          actualStartTime: '2026-01-01T10:00:00Z',
          actualEndTime: '2026-01-01T11:00:00Z',
        },
        snippet: { title: 'Service' },
      }],
    };
    expect(parseApiResponse(data).broadcastStatus).toBe('complete');
  });

  test('returns broadcastStatus null when no liveStreamingDetails', () => {
    const data = {
      items: [{ snippet: { title: 'Not a live video' } }],
    };
    expect(parseApiResponse(data).broadcastStatus).toBeNull();
  });

  test('returns viewerCount null when concurrentViewers is missing', () => {
    const data = {
      items: [{
        liveStreamingDetails: {},
        snippet: { title: 'Evening Service' },
      }],
    };
    const result = parseApiResponse(data);
    expect(result.viewerCount).toBeNull();
    expect(result.broadcastTitle).toBe('Evening Service');
  });

  test('parses zero viewers', () => {
    const data = {
      items: [{
        liveStreamingDetails: { concurrentViewers: '0' },
        snippet: { title: 'Pre-Service' },
      }],
    };
    expect(parseApiResponse(data).viewerCount).toBe(0);
  });
});

describe('parseIni', () => {
  test('parses simple INI content into sections', () => {
    const ini = `[Section1]
key1=value1
key2=value2

[Section2]
foo=bar`;
    const result = parseIni(ini);
    expect(result['Section1']).toEqual({ key1: 'value1', key2: 'value2' });
    expect(result['Section2']).toEqual({ foo: 'bar' });
  });

  test('handles values with = in them', () => {
    const ini = `[Auth]
token=abc=def=ghi`;
    const result = parseIni(ini);
    expect(result['Auth']['token']).toBe('abc=def=ghi');
  });

  test('ignores lines before any section', () => {
    const ini = `orphan=value
[Section]
key=val`;
    const result = parseIni(ini);
    expect(result['Section']).toEqual({ key: 'val' });
    expect(result['orphan']).toBeUndefined();
  });
});

describe('extractCredsFromIni', () => {
  test('finds RefreshToken and AccessToken from OBS [YouTube] section in global.ini', () => {
    // OBS stores RefreshToken, Token (access token), and ExpireTime (Unix seconds)
    // client_id/secret are baked into the OBS binary and never written to disk
    const ini = {
      'YouTube': {
        RefreshToken: 'rtoken',
        Token: 'atoken',
        ExpireTime: '1234567890',
        ScopeVer: '1',
      },
    };
    const result = extractCredsFromIni(ini);
    expect(result).toEqual({
      clientId: '',
      clientSecret: '',
      refreshToken: 'rtoken',
      accessToken: 'atoken',
      tokenExpiry: 1234567890 * 1000,
    });
  });

  test('returns accessToken and tokenExpiry as undefined when Token is absent', () => {
    const ini = {
      'YouTube': {
        RefreshToken: 'rtoken',
      },
    };
    const result = extractCredsFromIni(ini);
    expect(result).toEqual({ clientId: '', clientSecret: '', refreshToken: 'rtoken', accessToken: undefined, tokenExpiry: undefined });
  });

  test('returns null if no YouTube section found', () => {
    const ini = { 'Twitch': { key: 'value' } };
    expect(extractCredsFromIni(ini)).toBeNull();
  });

  test('returns null if YouTube section has no RefreshToken', () => {
    const ini = { 'YouTube': { Token: 'atoken' } };
    expect(extractCredsFromIni(ini)).toBeNull();
  });
});

describe('seedAccessToken', () => {
  test('pre-seeds the in-memory access token cache', () => {
    const futureExpiry = Date.now() + 3600_000;
    seedAccessToken('seeded-token', futureExpiry);
    expect(getAccessTokenForTesting()).toEqual({ token: 'seeded-token', expiry: futureExpiry });
  });
});

describe('parseBroadcastsResponse', () => {
  test('returns empty array when items is missing', () => {
    expect(parseBroadcastsResponse({})).toEqual([]);
  });

  test('returns empty array when items is empty', () => {
    expect(parseBroadcastsResponse({ items: [] })).toEqual([]);
  });

  test('filters out completed and revoked broadcasts', () => {
    const data = {
      items: [
        { id: 'a', snippet: { title: 'Live Now' }, status: { lifeCycleStatus: 'live' } },
        { id: 'b', snippet: { title: 'Done' }, status: { lifeCycleStatus: 'complete' } },
        { id: 'c', snippet: { title: 'Revoked' }, status: { lifeCycleStatus: 'revoked' } },
        { id: 'd', snippet: { title: 'Upcoming', scheduledStartTime: '2026-03-22T10:00:00Z' }, status: { lifeCycleStatus: 'ready' } },
      ],
    };
    const result = parseBroadcastsResponse(data);
    expect(result).toHaveLength(2);
    expect(result.map(b => b.id)).toEqual(['a', 'd']);
  });

  test('maps fields correctly', () => {
    const data = {
      items: [{
        id: 'xyz',
        snippet: { title: 'Sunday Service', scheduledStartTime: '2026-03-22T09:00:00Z' },
        status: { lifeCycleStatus: 'ready' },
      }],
    };
    const result = parseBroadcastsResponse(data);
    expect(result[0]).toEqual({
      id: 'xyz',
      title: 'Sunday Service',
      status: 'ready',
      scheduledStartTime: '2026-03-22T09:00:00Z',
    });
  });

  test('includes testing and liveStarting statuses', () => {
    const data = {
      items: [
        { id: 't', snippet: { title: 'Testing' }, status: { lifeCycleStatus: 'testing' } },
        { id: 'ls', snippet: { title: 'Going Live' }, status: { lifeCycleStatus: 'liveStarting' } },
      ],
    };
    const result = parseBroadcastsResponse(data);
    expect(result).toHaveLength(2);
  });

  test('omits scheduledStartTime when absent', () => {
    const data = {
      items: [{ id: 'a', snippet: { title: 'No Time' }, status: { lifeCycleStatus: 'live' } }],
    };
    const result = parseBroadcastsResponse(data);
    expect(result[0].scheduledStartTime).toBeUndefined();
  });
});
