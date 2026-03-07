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
let wantConnected = false;

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
let statusRevision = '0'; // the revision field from status, sent as `step` to statusChanged
let statusLoopGeneration = 0; // incremented on disconnect to stop any in-flight loop

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
  const controlRes = await fetch(`${baseUrl()}/auth/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'OnAirSessionId': sessionId,
    },
    body: controlBody,
  });
  const controlText = await controlRes.text();

  if (!controlRes.ok) {
    // Likely running on the same machine as Proclaim — proceed with sessionId only
    logger.log('[Proclaim] auth/control failed, proceeding with OnAirSessionId only (same-machine mode)');
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
    logger.log(`[Proclaim] sendAction got 401 for ${commandName}, re-authenticating`);
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
      logger.log(`[Proclaim] Session changed (${onAirSessionId} → ${sessionId}), re-authenticating remote control`);
      try {
        const auth = await authenticateRemote();
        onAirSessionId = auth.onAirSessionId;
        connectionId = auth.connectionId;
      } catch (err) {
        logger.log('[Proclaim] Remote auth failed:', (err as Error).message);
        return;
      }
      // New session: reset revision state and restart long-poll loop
      presentationLocalRevision = '0';
      statusRevision = '0';
      presentationCache = null;
      startStatusLoop();
    }

    state.update('proclaim', { connected: true, onAir: true });
  } catch (err) {
    logger.log('[Proclaim] pollStatus network error:', (err as Error).message);
    state.update('proclaim', { connected: false });
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    scheduleReconnect();
  }
}

// Minimum delay before re-firing statusChanged if it returned faster than expected.
// Grows exponentially on repeated fast responses, resets after a slow (long-poll) response.
const LONG_POLL_THRESHOLD_MS = 5000;
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 10000;

function startStatusLoop(): void {
  const generation = ++statusLoopGeneration;
  runStatusLoop(generation, MIN_RETRY_MS);
}

async function runStatusLoop(generation: number, retryDelay: number): Promise<void> {
  if (!wantConnected || generation !== statusLoopGeneration) return;

  const start = Date.now();
  try {
    await fetchDetailedStatus();
  } catch (err) {
    logger.log('[Proclaim] statusChanged loop error:', (err as Error).message);
  }

  if (!wantConnected || generation !== statusLoopGeneration) return;

  const elapsed = Date.now() - start;
  if (elapsed >= LONG_POLL_THRESHOLD_MS) {
    // Genuine long-poll response — fire again immediately, reset backoff
    runStatusLoop(generation, MIN_RETRY_MS);
  } else {
    // Quick response — back off to avoid hammering the server
    const nextDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    logger.debug(`[Proclaim] statusChanged returned in ${elapsed}ms, retrying in ${retryDelay}ms`);
    setTimeout(() => runStatusLoop(generation, nextDelay), retryDelay);
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

const EXCLUDED_KINDS = new Set(['StageDirectionCue']);

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

  // Long-poll: Proclaim blocks up to ~60s, returning immediately only on state change.
  try {
    const headers: Record<string, string> = { 'OnAirSessionId': onAirSessionId! };
    if (connectionId) headers['ConnectionId'] = connectionId;
    const res = await fetch(`${baseUrl()}/onair/statusChanged?localrevision=${presentationLocalRevision}&step=${statusRevision}`, { headers });

    if (!res.ok) {
      logger.log('[Proclaim] statusChanged error:', res.status);
      return;
    }

    const data = parseProclaimJson(await res.text()) as {
      presentationId?: string;
      presentationLocalRevision?: number | string;
      status?: { revision?: number | string; itemId?: string; slideIndex?: number };
    } | null;

    if (!data) {
      logger.log('[Proclaim] statusChanged returned null');
      return;
    }

    if (data.presentationLocalRevision !== undefined) {
      presentationLocalRevision = String(data.presentationLocalRevision);
    }

    const status = data.status;
    if (status?.revision !== undefined) {
      statusRevision = String(status.revision);
    }
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
      } catch (err) {
        logger.log('[Proclaim] onair error:', (err as Error).toString());
      }
    }

    const rawItems = (presentationCache as any)?.serviceItems ?? [];
    const cache = presentationCache as any;
    const warmupStartIndex: number | null = cache?.warmupStartIndex ?? null;
    const serviceStartIndex: number | null = cache?.serviceStartIndex ?? null;
    const postServiceStartIndex: number | null = cache?.postServiceStartIndex ?? null;

    type SectionName = 'Pre-Service' | 'Warmup' | 'Service' | 'Post-Service';
    const SECTION_COMMANDS: Record<SectionName, string> = {
      'Pre-Service': 'StartPreService',
      'Warmup': 'StartWarmUp',
      'Service': 'StartService',
      'Post-Service': 'StartPostService',
    };

    function getSectionInfo(zeroBasedIdx: number): { section: SectionName } {
      if (postServiceStartIndex != null && zeroBasedIdx >= postServiceStartIndex) return { section: 'Post-Service' };
      if (serviceStartIndex != null && zeroBasedIdx >= serviceStartIndex) return { section: 'Service' };
      if (warmupStartIndex != null && zeroBasedIdx >= warmupStartIndex) return { section: 'Warmup' };
      return { section: 'Pre-Service' };
    }

    // Count non-excluded, non-Grouping items per section to compute sectionIndex
    const sectionItemCounters: Partial<Record<SectionName, number>> = {};

    let currentGroup: string | null = null;
    const serviceItems: ServiceItem[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      if (EXCLUDED_KINDS.has(item.kind)) continue;
      if (item.kind === 'Grouping') {
        currentGroup = item.title === 'Slide Group' ? null : item.title;
        continue;
      }
      const { section } = getSectionInfo(i);
      sectionItemCounters[section] = (sectionItemCounters[section] ?? 0) + 1;
      serviceItems.push({
        id: item.id,
        title: item.title,
        kind: item.kind,
        slideCount: item.slides ? item.slides.length : 0,
        index: i + 1,
        sectionIndex: sectionItemCounters[section]!,
        sectionCommand: SECTION_COMMANDS[section],
        section,
        group: currentGroup,
      });
    }

    const currentItem = serviceItems.find((item) => item.id === status.itemId);

    state.update('proclaim', {
      currentItemId: status.itemId || null,
      currentItemTitle: currentItem ? currentItem.title : null,
      currentItemType: currentItem ? currentItem.kind : null,
      slideIndex: status.slideIndex !== undefined ? status.slideIndex : null,
      serviceItems,
    });
  } catch (err) {
    logger.log('[Proclaim] statusChanged error:', (err as Error).toString());
  }
}

function scheduleReconnect(): void {
  if (!wantConnected) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

async function connect(): Promise<void> {
  wantConnected = true;
  logger.log('[Proclaim] Attempting to connect to', baseUrl());
  try {
    appCommandToken = await authenticateAppCommand();
    logger.log('[Proclaim] Authenticated');
    state.update('proclaim', { connected: true });
    startPolling();
    startStatusLoop();
  } catch (err) {
    logger.log('[Proclaim] Connection failed:', (err as Error).message);
    state.update('proclaim', { connected: false });
    scheduleReconnect();
  }
}

function disconnect(): void {
  wantConnected = false;
  statusLoopGeneration++; // invalidates any in-flight runStatusLoop iteration
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  appCommandToken = null;
  onAirSessionId = null;
  connectionId = null;
  presentationLocalRevision = '0';
  statusRevision = '0';
  presentationCache = null;
}

async function goToItem(itemId: string): Promise<boolean> {
  const currentState = require('../state').get() as import('../types').AppState;
  const item = currentState.proclaim.serviceItems.find((i) => i.id === itemId);
  if (!item) {
    logger.log(`[Proclaim] goToItem: item ${itemId} not found in state`);
    return false;
  }
  const sectionOk = await sendAction(item.sectionCommand);
  if (!sectionOk) return false;
  return sendAction('GoToServiceItem', item.sectionIndex);
}

export = {
  connect,
  disconnect,
  sendAction,
  goToItem,
  getThumbUrl,
  getToken,
  getOnAirSessionId,
  _authenticateAppCommand: authenticateAppCommand,
  _authenticateRemote: authenticateRemote,
  _pollStatus: pollStatus,
  _fetchDetailedStatus: fetchDetailedStatus,
};
