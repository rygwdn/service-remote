import config = require('../config');
import state = require('../state');
import type { ServiceItem } from '../types';

let authToken: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let presentationCache: {
  presentationId?: string;
  serviceItems?: Array<{
    id: string;
    title: string;
    kind: string;
    slides?: unknown[];
  }>;
} | null = null;
let presentationLocalRevision = 0;
let statusChangedAbortController: AbortController | null = null;

function baseUrl(): string {
  return `http://${config.proclaim.host}:${config.proclaim.port}`;
}

function getToken(): string | null {
  return authToken;
}

function getThumbUrl(itemId: string | undefined, slideIndex: string | undefined, localRevision: string | undefined): string {
  return `${baseUrl()}/presentations/slide/thumbnail?itemId=${itemId}&slideIndex=${slideIndex}&localRevision=${localRevision}`;
}

async function authenticate(): Promise<string> {
  const res = await fetch(`${baseUrl()}/appCommand/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Password: config.proclaim.password }),
  });
  if (!res.ok) {
    throw new Error(`Proclaim auth failed: ${res.status}`);
  }
  const data = await res.json() as { token?: string };
  if (!data.token) {
    throw new Error('Proclaim auth: no token in response');
  }
  return data.token;
}

async function sendAction(commandName: string, index?: number): Promise<boolean> {
  if (!authToken) {
    console.log('[Proclaim] Not authenticated');
    return false;
  }

  let url = `${baseUrl()}/appCommand/perform?appCommandName=${encodeURIComponent(commandName)}`;
  if (index !== undefined && index !== null) {
    url += `&index=${encodeURIComponent(index)}`;
  }

  const res = await fetch(url, {
    headers: { ProclaimAuthToken: authToken },
  });

  if (res.status === 401) {
    console.log('[Proclaim] sendAction got 401, re-authenticating');
    authToken = null;
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
    const res = await fetch(`${baseUrl()}/onair/session`, {
      headers: { ProclaimAuthToken: authToken! },
    });

    if (res.status === 401) {
      console.log('[Proclaim] pollStatus got 401, re-authenticating');
      authToken = null;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      scheduleReconnect();
      return;
    }

    if (!res.ok) {
      console.log(`[Proclaim] pollStatus error: ${res.status}`);
      return;
    }

    const text = await res.text();
    if (!text || text.trim() === '' || text.trim() === 'null') {
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
      headers: { ProclaimAuthToken: authToken! },
    });
    if (presRes.ok) {
      presentationCache = await presRes.json() as typeof presentationCache;
    }
  } catch (_) {
    // best-effort
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
          headers: { ProclaimAuthToken: authToken! },
          signal,
        }
      );

      if (signal.aborted) break;

      if (!res.ok) {
        // Stop on auth failure; outer pollStatus handles reconnect
        break;
      }

      const data = await res.json() as {
        localRevision?: number;
        status?: {
          presentationId?: string;
          itemId?: string;
          slideIndex?: number;
        };
      };
      if (data && data.localRevision !== undefined) {
        presentationLocalRevision = data.localRevision;
      }

      const status = data && data.status;
      if (!status) continue;

      // If presentation changed, refresh the presentation cache
      if (
        status.presentationId &&
        presentationCache &&
        presentationCache.presentationId !== status.presentationId
      ) {
        try {
          const presRes = await fetch(`${baseUrl()}/presentations/onair`, {
            headers: { ProclaimAuthToken: authToken! },
          });
          if (presRes.ok) {
            presentationCache = await presRes.json() as typeof presentationCache;
          }
        } catch (_) {
          // best-effort
        }
      }

      const serviceItems: ServiceItem[] = presentationCache && presentationCache.serviceItems
        ? presentationCache.serviceItems
            .filter((item) => !EXCLUDED_KINDS.has(item.kind))
            .map((item) => ({
              id: item.id,
              title: item.title,
              kind: item.kind,
              slideCount: item.slides ? item.slides.length : 0,
            }))
        : [];

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
      // best-effort: silently ignore errors in status long-poll
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
    authToken = await authenticate();
    console.log('[Proclaim] Authenticated');
    state.update('proclaim', { connected: true });
    startPolling();
  } catch (err) {
    console.log('[Proclaim] Connection failed:', (err as Error).message);
    state.update('proclaim', { connected: false });
    scheduleReconnect();
  }
}

export = {
  connect,
  sendAction,
  getThumbUrl,
  getToken,
  _authenticate: authenticate,
  _pollStatus: pollStatus,
};
