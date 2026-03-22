import config = require('../config');
import state = require('../state');
import logger = require('../logger');

/** Parse a YouTube Data API v3 `videos.list` response into viewer count and title. */
function parseApiResponse(data: unknown): { viewerCount: number | null; broadcastTitle: string | null } {
  const item = (data as Record<string, unknown> | null)?.['items'];
  if (!Array.isArray(item) || item.length === 0) {
    return { viewerCount: null, broadcastTitle: null };
  }
  const first = item[0] as Record<string, unknown>;
  const lsd = first['liveStreamingDetails'] as Record<string, unknown> | undefined;
  const snippet = first['snippet'] as Record<string, unknown> | undefined;

  const raw = lsd?.['concurrentViewers'];
  const viewerCount = raw != null ? parseInt(String(raw), 10) : null;
  const broadcastTitle = typeof snippet?.['title'] === 'string' ? snippet['title'] : null;

  return { viewerCount, broadcastTitle };
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  const { apiKey, broadcastId } = config.youtube;
  if (!apiKey || !broadcastId) {
    state.update('youtube', { connected: false, viewerCount: null, broadcastTitle: null, broadcastId: null });
    return;
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=${encodeURIComponent(broadcastId)}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json() as unknown;
    const { viewerCount, broadcastTitle } = parseApiResponse(data);
    state.update('youtube', { connected: true, viewerCount, broadcastTitle, broadcastId });
  } catch (err) {
    logger.error('[YouTube] Poll failed:', (err as Error).message);
    state.update('youtube', { connected: false });
  }
}

function connect(): void {
  if (pollTimer) clearInterval(pollTimer);
  void poll();
  pollTimer = setInterval(() => { void poll(); }, config.youtube.pollInterval ?? 30000);
  logger.log('[YouTube] Polling started');
}

function disconnect(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  state.update('youtube', { connected: false });
  logger.log('[YouTube] Polling stopped');
}

export = { connect, disconnect, parseApiResponse };
