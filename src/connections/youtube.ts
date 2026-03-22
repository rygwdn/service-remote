import fs = require('fs');
import os = require('os');
import path = require('path');
import config = require('../config');
import state = require('../state');
import logger = require('../logger');

// ── Response parsing ─────────────────────────────────────────────────────────

interface ParsedVideoInfo {
  viewerCount: number | null;
  broadcastTitle: string | null;
  broadcastStatus: 'ready' | 'testing' | 'live' | 'complete' | null;
}

/** Parse a YouTube Data API v3 `videos.list` response. */
function parseApiResponse(data: unknown): ParsedVideoInfo {
  const items = (data as Record<string, unknown> | null)?.['items'];
  if (!Array.isArray(items) || items.length === 0) {
    return { viewerCount: null, broadcastTitle: null, broadcastStatus: null };
  }
  const first = items[0] as Record<string, unknown>;
  const lsd = first['liveStreamingDetails'] as Record<string, unknown> | undefined;
  const snippet = first['snippet'] as Record<string, unknown> | undefined;

  const raw = lsd?.['concurrentViewers'];
  const viewerCount = raw != null ? parseInt(String(raw), 10) : null;
  const broadcastTitle = typeof snippet?.['title'] === 'string' ? snippet['title'] : null;

  let broadcastStatus: ParsedVideoInfo['broadcastStatus'] = null;
  if (lsd) {
    if (lsd['actualEndTime']) {
      broadcastStatus = 'complete';
    } else if (lsd['actualStartTime']) {
      broadcastStatus = 'live';
    } else {
      broadcastStatus = 'ready';
    }
  }

  return { viewerCount, broadcastTitle, broadcastStatus };
}

// ── INI parsing (for OBS global.ini) ─────────────────────────────────────────

/** Parse a simple INI file into sections. */
function parseIni(content: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let section = '';
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const m = trimmed.match(/^\[(.+)\]$/);
    if (m) {
      section = m[1];
      result[section] ??= {};
      continue;
    }
    if (section && trimmed.includes('=')) {
      const eq = trimmed.indexOf('=');
      result[section][trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  return result;
}

interface OAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Access token read directly from OBS global.ini (may be expired). */
  accessToken?: string;
  /** Expiry timestamp in ms (converted from OBS's Unix-second ExpireTime). */
  tokenExpiry?: number;
}

/** Search a parsed INI object for a YouTube section with a RefreshToken. */
function extractCredsFromIni(ini: Record<string, Record<string, string>>): OAuthCreds | null {
  for (const [section, values] of Object.entries(ini)) {
    if (section.toLowerCase().includes('youtube') && values['RefreshToken']) {
      const rawExpire = values['ExpireTime'];
      const tokenExpiry = rawExpire ? Number(rawExpire) * 1000 : undefined;
      return {
        clientId: '',
        clientSecret: '',
        refreshToken: values['RefreshToken'],
        accessToken: values['Token'] || undefined,
        tokenExpiry,
      };
    }
  }
  return null;
}

/** Return the default OBS config directory for the current OS. */
function defaultObsConfigDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': return path.join(process.env['APPDATA'] ?? home, 'obs-studio');
    case 'darwin': return path.join(home, 'Library', 'Application Support', 'obs-studio');
    default: return path.join(home, '.config', 'obs-studio');
  }
}

/**
 * Try to read YouTube OAuth credentials from OBS's config files.
 * OBS stores the RefreshToken in the [YouTube] section of global.ini.
 * Note: OBS does not store client_id/client_secret on disk — those are
 * baked into the OBS binary at build time and must be entered manually.
 */
async function importObsCreds(obsConfigDir?: string): Promise<OAuthCreds | null> {
  const dir = obsConfigDir ?? defaultObsConfigDir();

  const iniPath = path.join(dir, 'global.ini');
  try {
    const raw = fs.readFileSync(iniPath, 'utf-8');
    const creds = extractCredsFromIni(parseIni(raw));
    if (creds) return creds;
  } catch {
    // Not found — fall through
  }

  return null;
}

// ── OAuth token management ────────────────────────────────────────────────────

let cachedAccessToken: string | null = null;
let tokenExpiry = 0;

/** Pre-seed the in-memory access token cache (e.g. from an imported OBS token). */
function seedAccessToken(token: string, expiryMs: number): void {
  cachedAccessToken = token;
  tokenExpiry = expiryMs;
}

/** Return the current cached token state — for testing only. */
function getAccessTokenForTesting(): { token: string | null; expiry: number } {
  return { token: cachedAccessToken, expiry: tokenExpiry };
}

/** Get a valid access token, refreshing via the configured refresh_token if needed. */
async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiry - 60_000) {
    return cachedAccessToken;
  }
  const { clientId, clientSecret, refreshToken } = config.youtube.oauth;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YouTube OAuth credentials not configured');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} - ${body}`);
  }
  const data = await res.json() as { access_token: string; expires_in?: number };
  cachedAccessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedAccessToken;
}

// ── Broadcast control ─────────────────────────────────────────────────────────

/** Transition the configured YouTube broadcast to 'live' (go live). */
async function startBroadcast(): Promise<void> {
  const broadcastId = config.youtube.broadcastId;
  if (!broadcastId) throw new Error('YouTube broadcastId not configured');
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=live&id=${encodeURIComponent(broadcastId)}&part=status`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error: ${res.status} - ${body}`);
  }
  state.update('youtube', { broadcastStatus: 'live' });
  logger.log('[YouTube] Broadcast started (live)');
}

/** Transition the configured YouTube broadcast to 'complete' (end stream). */
async function stopBroadcast(): Promise<void> {
  const broadcastId = config.youtube.broadcastId;
  if (!broadcastId) throw new Error('YouTube broadcastId not configured');
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=complete&id=${encodeURIComponent(broadcastId)}&part=status`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error: ${res.status} - ${body}`);
  }
  state.update('youtube', { broadcastStatus: 'complete' });
  logger.log('[YouTube] Broadcast stopped (complete)');
}

// ── Polling ───────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  const { apiKey, broadcastId } = config.youtube;
  if (!apiKey || !broadcastId) {
    state.update('youtube', { connected: false, viewerCount: null, broadcastTitle: null, broadcastId: null, broadcastStatus: null });
    return;
  }

  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=${encodeURIComponent(broadcastId)}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json() as unknown;
    const { viewerCount, broadcastTitle, broadcastStatus } = parseApiResponse(data);
    state.update('youtube', { connected: true, viewerCount, broadcastTitle, broadcastStatus, broadcastId });
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
  cachedAccessToken = null;
  tokenExpiry = 0;
  state.update('youtube', { connected: false });
  logger.log('[YouTube] Polling stopped');
}

export = { connect, disconnect, parseApiResponse, parseIni, extractCredsFromIni, importObsCreds, startBroadcast, stopBroadcast, seedAccessToken, getAccessTokenForTesting };
