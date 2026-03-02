import config = require('../config');
import state = require('../state');
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
let presentationLocalRevision = 0;
let statusChangedAbortController: AbortController | null = null;

function baseUrl(): string {
  return `http://${config.proclaim.host}:${config.proclaim.port}`;
}

function getToken(): string | null {
  return appCommandToken;
}

function getThumbUrl(itemId: string | undefined, slideIndex: string | undefined, localRevision: string | undefined): string {
  return `${baseUrl()}/presentations/onair/items/${itemId}/slides/${slideIndex}/image?localrevision=${localRevision}&width=480`;
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

  // Step 2: authenticate with password to get connectionId
  const controlRes = await fetch(`${baseUrl()}/auth/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'OnAirSessionId': sessionId,
    },
    body: JSON.stringify({
      faithlifeUserId: 0,
      userName: 'service-remote',
      remoteDeviceName: '',
      password: config.proclaim.password,
    }),
  });
  if (!controlRes.ok) throw new Error(`Proclaim auth/control failed: ${controlRes.status}`);
  const data = await controlRes.json() as { connectionId?: string };
  if (!data.connectionId) throw new Error('Proclaim auth/control: no connectionId in response');

  return { onAirSessionId: sessionId, connectionId: data.connectionId };
}

async function sendAction(commandName: string, index?: number): Promise<boolean> {
  if (!appCommandToken) {
    console.log('[Proclaim] Not authenticated');
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
    console.log('[Proclaim] sendAction got 401, re-authenticating');
    appCommandToken = null;
    scheduleReconnect();
    return false;
  }

  if (!res.ok) {
    console.log(`[Proclaim] sendAction failed: ${res.status}`);
    return false;
  }

  console.log(`[Proclaim] Sent: ${commandName}${index !== undefined ? ` index=${index}` : ''}`);
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
      console.log(`[Proclaim] pollStatus error: ${res.status}`);
      return;
    }

    const text = await res.text();
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
      console.log('[Proclaim] Session changed, re-authenticating remote control');
      try {
        const auth = await authenticateRemote();
        onAirSessionId = auth.onAirSessionId;
        connectionId = auth.connectionId;
      } catch (err) {
        console.log('[Proclaim] Remote auth failed:', (err as Error).message);
        return;
      }
    }

    state.update('proclaim', { connected: true, onAir: true });
    fetchDetailedStatus();
  } catch (err) {
    console.log('[Proclaim] pollStatus network error:', (err as Error).message);
    state.update('proclaim', { connected: false });
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    scheduleReconnect();
  }
}

const EXCLUDED_KINDS = new Set(['Grouping', 'StageDirectionCue']);

async function fetchDetailedStatus(): Promise<void> {
  try {
    const presRes = await fetch(`${baseUrl()}/presentations/onair`, {
      headers: { 'OnAirSessionId': onAirSessionId! },
    });
    if (presRes.ok) {
      presentationCache = await presRes.json() as typeof presentationCache;
      console.log('[Proclaim] presentations/onair loaded, items:', (presentationCache as any)?.serviceItems?.length ?? 0);
    } else {
      console.log('[Proclaim] presentations/onair failed:', presRes.status);
    }
  } catch (err) {
    console.log('[Proclaim] presentations/onair error:', (err as Error).message);
  }

  // Start/restart the long-poll loop for statusChanged
  if (statusChangedAbortController) {
    statusChangedAbortController.abort();
  }
  statusChangedAbortController = new AbortController();
  pollStatusChanged(statusChangedAbortController.signal);
}

async function pollStatusChanged(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await fetch(
        `${baseUrl()}/onair/statusChanged?localrevision=${presentationLocalRevision}&step=250`,
        {
          headers: {
            'OnAirSessionId': onAirSessionId!,
            'ConnectionId': connectionId!,
          },
          signal,
        }
      );

      if (signal.aborted) break;

      if (!res.ok) {
        console.log('[Proclaim] statusChanged error:', res.status);
        break;
      }

      const data = await res.json() as {
        presentationId?: string;
        presentationLocalRevision?: number;
        status?: {
          itemId?: string;
          slideIndex?: number;
        };
      };

      if (data && data.presentationLocalRevision !== undefined) {
        presentationLocalRevision = data.presentationLocalRevision;
      }

      const status = data && data.status;
      if (!status) continue;

      // If presentation cache is missing or presentation changed, refresh it
      if (
        data.presentationId &&
        (!presentationCache || (presentationCache as any).id !== data.presentationId)
      ) {
        try {
          const presRes = await fetch(`${baseUrl()}/presentations/onair`, {
            headers: { 'OnAirSessionId': onAirSessionId! },
          });
          if (presRes.ok) {
            presentationCache = await presRes.json() as typeof presentationCache;
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
      if (signal.aborted) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
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
    console.log('[Proclaim] Authenticated');
    state.update('proclaim', { connected: true });
    startPolling();
  } catch (err) {
    console.log('[Proclaim] Connection failed:', (err as Error).message);
    state.update('proclaim', { connected: false });
    scheduleReconnect();
  }
}

function disconnect(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (statusChangedAbortController) { statusChangedAbortController.abort(); statusChangedAbortController = null; }
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
  _authenticateAppCommand: authenticateAppCommand,
  _authenticateRemote: authenticateRemote,
  _pollStatus: pollStatus,
};
