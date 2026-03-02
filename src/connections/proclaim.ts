import config = require('../config');
import state = require('../state');
import logger = require('../logger');
import type { ServiceItem } from '../types';

// --- App Command API (official) ---
// Auth: POST /appCommand/authenticate → ProclaimAuthToken header
// Used for: sendAction (slide control commands)

// --- Remote Control API (HAR-captured) ---
// Auth: GET /onair/session → OnAirSessionId; POST /auth/control → connectionId
// Used for: live status polling, presentation data, slide images

let appCommandToken: string | null = null;
let onAirSessionId: string | null = null;
let connectionId: string | null = null;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let presentationCache: {
  id?: string;
  localRevision?: number;
  serviceItems?: Array<{
    id: string;
    title: string;
    kind: string;
    slides?: Array<{ localRevision: number; index: number }>;
  }>;
} | null = null;
let presentationLocalRevision = '0'; // kept as string — value exceeds JS safe integer range

function baseUrl(): string {
  return `http://${config.proclaim.host}:${config.proclaim.port}`;
}

function getToken(): string | null {
  return appCommandToken;
}

function getOnAirSessionId(): string | null {
  return onAirSessionId;
}

function getThumbUrl(itemId: string | undefined, slideIndex: string | undefined, _localRevision: string | undefined): string {
  // Look up the per-slide localRevision from the presentation cache
  const item = (presentationCache as any)?.serviceItems?.find((i: any) => i.id === itemId);
  const slide = item?.slides?.find((s: any) => String(s.index) === String(slideIndex));
  const localRevision = slide?.localRevision !== undefined ? String(slide.localRevision) : '';
  const params = new URLSearchParams({ width: '480' });
  if (localRevision) params.set('localrevision', localRevision);
  return `${baseUrl()}/presentations/onair/items/${itemId}/slides/${slideIndex}/image?${params}`;
}

// --- App Command API auth ---
async function authenticateAppCommand(): Promise<string> {
  const res = await fetch(`${baseUrl()}/appCommand/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Password: config.proclaim.password }),
  });
  if (!res.ok) throw new Error(`Proclaim auth failed: ${res.status}`);
  const data = await res.json() as { proclaimAuthToken?: string };
  if (!data.proclaimAuthToken) throw new Error('Proclaim auth: no token in response');
  return data.proclaimAuthToken;
}

// --- Remote Control API auth ---
async function authenticateRemote(): Promise<{ onAirSessionId: string; connectionId: string }> {
  // Step 1: get the session id (no auth needed)
  const sessionRes = await fetch(`${baseUrl()}/onair/session`);
  if (!sessionRes.ok) throw new Error(`Proclaim onair/session failed: ${sessionRes.status}`);
  const sessionId = (await sessionRes.text()).trim();
  if (!sessionId) throw new Error('Proclaim onair/session: empty response');

  // Step 2: try to authenticate with password to get connectionId.
  // NOTE: Proclaim may reject /auth/control from localhost (same-machine requests
  // use the App Command API instead). If it fails, fall back to using sessionId alone.
  const controlBody = JSON.stringify({
    faithlifeUserId: 0,
    userName: 'service-remote',
    remoteDeviceName: '',
    password: config.proclaim.password,
  });
  console.log('[Proclaim] auth/control OnAirSessionId:', sessionId);
  const controlRes = await fetch(`${baseUrl()}/auth/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'OnAirSessionId': sessionId,
    },
    body: controlBody,
  });
  const controlText = await controlRes.text();
  console.log('[Proclaim] auth/control response:', controlRes.status, controlText.slice(0, 300));

  if (!controlRes.ok) {
    // Likely running on the same machine as Proclaim — proceed with sessionId only
    console.log('[Proclaim] auth/control failed, proceeding with OnAirSessionId only (same-machine mode)');
    return { onAirSessionId: sessionId, connectionId: '' };
  }

  let data: { connectionId?: string };
  try {
    data = JSON.parse(controlText);
  } catch {
    throw new Error('Proclaim auth/control: invalid JSON response');
  }
  if (!data.connectionId) throw new Error('Proclaim auth/control: no connectionId in response');

  return { onAirSessionId: sessionId, connectionId: data.connectionId };
}

async function sendAction(commandName: string, index?: number): Promise<boolean> {
  if (!appCommandToken) {
    logger.log('[Proclaim] Not authenticated');
    return false;
  }

  let url = `${baseUrl()}/appCommand/perform?appCommandName=${encodeURIComponent(commandName)}`;
  if (index !== undefined && index !== null) {
    url += `&index=${encodeURIComponent(index)}`;
  }

  const res = await fetch(url, {
    headers: { ProclaimAuthToken: appCommandToken },
  });

  if (res.status === 401) {
    logger.log('[Proclaim] sendAction got 401, re-authenticating');
    appCommandToken = null;
    scheduleReconnect();
    return false;
  }

  if (!res.ok) {
    logger.log(`[Proclaim] sendAction failed: ${res.status}`);
    return false;
  }

  logger.log(`[Proclaim] Sent: ${commandName}${index !== undefined ? ` index=${index}` : ''}`);
  return true;
}

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollStatus, config.proclaim.pollInterval);
  pollStatus();
}

async function pollStatus(): Promise<void> {
  try {
    const res = await fetch(`${baseUrl()}/onair/session`);

    if (!res.ok) {
      logger.log(`[Proclaim] pollStatus error: ${res.status}`);
      return;
    }

    const text = await res.text();
    logger.log('[Proclaim] onair/session response:', JSON.stringify(text.trim().slice(0, 200)));
    const sessionId = text.trim();
    if (!sessionId || sessionId === 'null') {
      state.update('proclaim', {
        connected: true,
        onAir: false,
        currentItemId: null,
        currentItemTitle: null,
        currentItemType: null,
        slideIndex: null,
        serviceItems: [],
      });
      return;
    }

    // Session active — ensure remote auth is valid for this session
    if (sessionId !== onAirSessionId) {
      logger.log('[Proclaim] Session changed, re-authenticating remote control');
      try {
        const auth = await authenticateRemote();
        onAirSessionId = auth.onAirSessionId;
        connectionId = auth.connectionId;
      } catch (err) {
        logger.log('[Proclaim] Remote auth failed:', (err as Error).message);
        return;
      }
    }

    state.update('proclaim', { connected: true, onAir: true });
    fetchDetailedStatus();
  } catch (err) {
    logger.log('[Proclaim] pollStatus network error:', (err as Error).message);
    state.update('proclaim', { connected: false });
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    scheduleReconnect();
  }
}

// JSON.parse loses precision on Proclaim's large localRevision integers (> MAX_SAFE_INTEGER).
// Quote them in the raw text before parsing so they survive as strings.
function parseProclaimJson(text: string): any {
  const safe = text.replace(
    /"(localRevision|localrevision|presentationLocalRevision)"\s*:\s*(-?\d+)/g,
    '"$1":"$2"'
  );
  return JSON.parse(safe);
}

const EXCLUDED_KINDS = new Set(['Grouping', 'StageDirectionCue']);

async function fetchDetailedStatus(): Promise<void> {
  // Fetch presentation cache if missing
  if (!presentationCache) {
    try {
      const presRes = await fetch(`${baseUrl()}/presentations/onair`, {
        headers: { 'OnAirSessionId': onAirSessionId! },
      });
      if (presRes.ok) {
        presentationCache = parseProclaimJson(await presRes.text());
        logger.log('[Proclaim] presentations/onair loaded, items:', (presentationCache as any)?.serviceItems?.length ?? 0);
      } else {
        logger.log('[Proclaim] presentations/onair failed:', presRes.status);
      }
    } catch (err) {
      logger.log('[Proclaim] presentations/onair error:', (err as Error).message);
    }
  }

  // Fetch current status (not a long-poll — Proclaim returns immediately)
  try {
    const headers: Record<string, string> = { 'OnAirSessionId': onAirSessionId! };
    if (connectionId) headers['ConnectionId'] = connectionId;
    const res = await fetch(`${baseUrl()}/onair/statusChanged?localrevision=${presentationLocalRevision}&step=250`, { headers });

    if (!res.ok) {
      logger.log('[Proclaim] statusChanged error:', res.status);
      return;
    }

    const data = parseProclaimJson(await res.text()) as {
      presentationId?: string;
      presentationLocalRevision?: number | string;
      status?: { itemId?: string; slideIndex?: number };
    };

    if (data.presentationLocalRevision !== undefined) {
      presentationLocalRevision = String(data.presentationLocalRevision);
    }

    const status = data.status;
    if (!status) return;

    // If presentation changed, refresh the cache
    if (data.presentationId && (presentationCache as any)?.id !== data.presentationId) {
      try {
        const presRes = await fetch(`${baseUrl()}/presentations/onair`, {
          headers: { 'OnAirSessionId': onAirSessionId! },
        });
        if (presRes.ok) {
          presentationCache = parseProclaimJson(await presRes.text());
        }
      } catch (_) {
        // best-effort
      }
    }

    const rawItems = (presentationCache as any)?.serviceItems ?? [];
    const serviceItems: ServiceItem[] = rawItems
      .filter((item: any) => !EXCLUDED_KINDS.has(item.kind))
      .map((item: any) => ({
        id: item.id,
        title: item.title,
        kind: item.kind,
        slideCount: item.slides ? item.slides.length : 0,
      }));

    const currentItem = serviceItems.find((item) => item.id === status.itemId);

    state.update('proclaim', {
      currentItemId: status.itemId || null,
      currentItemTitle: currentItem ? currentItem.title : null,
      currentItemType: currentItem ? currentItem.kind : null,
      slideIndex: status.slideIndex !== undefined ? status.slideIndex : null,
      serviceItems,
    });
  } catch (err) {
    logger.log('[Proclaim] statusChanged error:', (err as Error).message);
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

async function connect(): Promise<void> {
  try {
    appCommandToken = await authenticateAppCommand();
    logger.log('[Proclaim] Authenticated');
    state.update('proclaim', { connected: true });
    startPolling();
  } catch (err) {
    logger.log('[Proclaim] Connection failed:', (err as Error).message);
    state.update('proclaim', { connected: false });
    scheduleReconnect();
  }
}

function disconnect(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  appCommandToken = null;
  onAirSessionId = null;
  connectionId = null;
}

export = {
  connect,
  disconnect,
  sendAction,
  getThumbUrl,
  getToken,
  getOnAirSessionId,
  _authenticateAppCommand: authenticateAppCommand,
  _authenticateRemote: authenticateRemote,
  _pollStatus: pollStatus,
};
