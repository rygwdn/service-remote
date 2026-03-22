import { test, expect, describe } from 'bun:test';
import { parseApiResponse } from '../../src/connections/youtube';

describe('parseApiResponse', () => {
  test('returns nulls when items array is empty', () => {
    const result = parseApiResponse({ items: [] });
    expect(result).toEqual({ viewerCount: null, broadcastTitle: null });
  });

  test('returns nulls when items is missing', () => {
    const result = parseApiResponse({});
    expect(result).toEqual({ viewerCount: null, broadcastTitle: null });
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

  test('returns broadcastTitle null when snippet.title is missing', () => {
    const data = {
      items: [{
        liveStreamingDetails: { concurrentViewers: '42' },
        snippet: {},
      }],
    };
    const result = parseApiResponse(data);
    expect(result.viewerCount).toBe(42);
    expect(result.broadcastTitle).toBeNull();
  });

  test('parses zero viewers', () => {
    const data = {
      items: [{
        liveStreamingDetails: { concurrentViewers: '0' },
        snippet: { title: 'Pre-Service' },
      }],
    };
    const result = parseApiResponse(data);
    expect(result.viewerCount).toBe(0);
  });
});
