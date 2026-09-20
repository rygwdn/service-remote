import config from '../config';
import state from '../state';
import * as logger from '../logger';
import { getSongSlides } from './proclaimDb';
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

interface PresentationSlide {
  localRevision: number;
  index: number;
}

interface PresentationItem {
  id: string;
  title: string;
  kind: string;
  slides?: PresentationSlide[];
}

interface PresentationCache {
  id?: string;
  localRevision?: number;
  serviceItems?: PresentationItem[];
  warmupStartIndex?: number | null;
  serviceStartIndex?: number | null;
  postServiceStartIndex?: number | null;
}

let pollTimer: Timer | undefined;
let statusRetryTimer: Timer | undefined;
let reconnectTimer: Timer | undefined;
let pollInFlightGeneration: number | null = null;
let statusLoopActive = false;
let statusLoopRestartPending = false;
let statusLoopGeneration = 0;
let connectionGeneration = 0;
let generationController: AbortController | null = null;
let connectInFlight: Promise<void> | null = null;
// itemId → per-slide lyric lines from PresentationManager.db; invalidated on
// presentation change. Entries are only created for SongLyrics items.
let lyricsCache: Record<string, string[][]> = {};
let presentationCache: PresentationCache | null = null;
// Sentinel values for the first poll: Proclaim returns current state immediately
// instead of long-polling when these minimum integer values are sent.
let presentationLocalRevision = '-9223372036854775808'; // Int64 min — kept as string (exceeds JS safe integer range)
let statusRevision = '-2147483648'; // Int32 min, sent as `step`

const HTTP_DEADLINE_MS = 10_000;
const LONG_POLL_DEADLINE_MS = 70_000;

function isCurrentGeneration(generation: number): boolean {
  return wantConnected
    && generation === connectionGeneration
    && generationController !== null
    && !generationController.signal.aborted;
}

function isGenerationAbort(error: unknown, signal?: AbortSignal): boolean {
  // Generation teardown aborts the parent signal; deadline-driven aborts on
  // request-scoped signals are NOT generation aborts.
  return signal?.aborted === true;
}

async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit = {},
  parentSignal?: AbortSignal,
  timeoutMs = HTTP_DEADLINE_MS,
): Promise<Response> {
  const requestController = new AbortController();
  const abortFromParent = () => requestController.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => requestController.abort(new Error('Proclaim request deadline exceeded')), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: requestController.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

function baseUrl(): string {
  return `http://${config.proclaim.host}:${config.proclaim.port}`;
}

function getToken(): string | null {
  return appCommandToken;
}

function getOnAirSessionId(): string | null {
  return onAirSessionId;
}

function getSlideLocalRevision(itemId: string | undefined, slideIndex: string | undefined): string | null {
  const item = presentationCache?.serviceItems?.find((i) => i.id === itemId);
  const slide = item?.slides?.find((s) => String(s.index) === String(slideIndex));
  return slide?.localRevision !== undefined ? String(slide.localRevision) : null;
}

function getThumbUrl(itemId: string | undefined, slideIndex: string | undefined, _localRevision: string | undefined): string {
  const localRevision = getSlideLocalRevision(itemId, slideIndex) ?? '';
  const params = new URLSearchParams({ width: '480' });
  if (localRevision) params.set('localrevision', localRevision);
  const encodedItemId = encodeURIComponent(itemId ?? '');
  const encodedSlideIndex = encodeURIComponent(slideIndex ?? '');
  return `${baseUrl()}/presentations/onair/items/${encodedItemId}/slides/${encodedSlideIndex}/image?${params}`;
}

// --- App Command API auth ---
async function authenticateAppCommand(signal?: AbortSignal): Promise<string> {
  const res = await fetchWithDeadline(`${baseUrl()}/appCommand/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Password: config.proclaim.password }),
  }, signal);
  if (!res.ok) throw new Error(`Proclaim auth failed: ${res.status}`);
  const data = await res.json() as { proclaimAuthToken?: string };
  if (!data.proclaimAuthToken) throw new Error('Proclaim auth: no token in response');
  return data.proclaimAuthToken;
}

// --- Remote Control API auth ---
async function authenticateRemote(signal?: AbortSignal): Promise<{ onAirSessionId: string; connectionId: string }> {
  // Step 1: get the session id (no auth needed)
  const sessionRes = await fetchWithDeadline(`${baseUrl()}/onair/session`, {}, signal);
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
  const controlRes = await fetchWithDeadline(`${baseUrl()}/auth/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'OnAirSessionId': sessionId,
    },
    body: controlBody,
  }, signal);
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

  const actionGeneration = connectionGeneration;
  const actionSignal = generationController?.signal;
  let url = `${baseUrl()}/appCommand/perform?appCommandName=${encodeURIComponent(commandName)}`;
  if (index !== undefined && index !== null) {
    url += `&index=${encodeURIComponent(index)}`;
  }

  try {
    const res = await fetchWithDeadline(url, {
      headers: { ProclaimAuthToken: appCommandToken },
    }, actionSignal);

    if (res.status === 401) {
      if (wantConnected && actionGeneration === connectionGeneration) {
        logger.log(`[Proclaim] sendAction got 401 for ${commandName}, re-authenticating`);
        appCommandToken = null;
        scheduleReconnect();
      }
      return false;
    }

    if (!res.ok) {
      logger.log(`[Proclaim] sendAction failed: ${res.status}`);
      return false;
    }

    logger.log(`[Proclaim] Sent: ${commandName}${index !== undefined ? ` index=${index}` : ''}`);
    return true;
  } catch (err) {
    if (!isGenerationAbort(err, actionSignal)) logger.log('[Proclaim] sendAction error:', (err as Error).message);
    return false;
  }
}

function schedulePoll(generation: number, delay: number): void {
  if (!isCurrentGeneration(generation)) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    void pollStatus(generation);
  }, delay);
}

function startPolling(generation: number): void {
  schedulePoll(generation, 0);
}

async function pollStatus(generation?: number): Promise<void> {
  const guarded = generation !== undefined;
  const ownedGeneration = generation ?? connectionGeneration;
  const signal = guarded ? generationController?.signal : undefined;
  if (guarded && !isCurrentGeneration(ownedGeneration)) return;
  if (guarded && pollInFlightGeneration === ownedGeneration) return;
  if (guarded) pollInFlightGeneration = ownedGeneration;

  try {
    const res = await fetchWithDeadline(`${baseUrl()}/onair/session`, {}, signal);
    if (guarded && !isCurrentGeneration(ownedGeneration)) return;
    if (!res.ok) {
      logger.log(`[Proclaim] pollStatus error: ${res.status}`);
      return;
    }

    const text = await res.text();
    if (guarded && !isCurrentGeneration(ownedGeneration)) return;
    const sessionId = text.trim();
    if (!sessionId || sessionId === 'null') {
      onAirSessionId = null;
      connectionId = null;
      statusLoopGeneration++;
      const hadStatusRetry = statusRetryTimer !== undefined;
      clearTimeout(statusRetryTimer);
      statusRetryTimer = undefined;
      statusLoopRestartPending = true;
      if (hadStatusRetry) statusLoopActive = false;
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

    if (sessionId !== onAirSessionId) {
      logger.log(`[Proclaim] Session changed (${onAirSessionId} → ${sessionId}), re-authenticating remote control`);
      try {
        const auth = await authenticateRemote(signal);
        if (guarded && !isCurrentGeneration(ownedGeneration)) return;
        onAirSessionId = auth.onAirSessionId;
        connectionId = auth.connectionId;
      } catch (err) {
        if (!isGenerationAbort(err, signal)) logger.log('[Proclaim] Remote auth failed:', (err as Error).message);
        return;
      }
      presentationLocalRevision = '-9223372036854775808';
      statusRevision = '-2147483648';
      presentationCache = null;
      if (guarded) startStatusLoop(ownedGeneration);
    }

    if (!guarded || isCurrentGeneration(ownedGeneration)) state.update('proclaim', { connected: true, onAir: true });
  } catch (err) {
    if (isGenerationAbort(err, signal)) return;
    if (!guarded) {
      logger.log('[Proclaim] pollStatus network error:', (err as Error).message);
    } else if (isCurrentGeneration(ownedGeneration)) {
      logger.log('[Proclaim] pollStatus network error:', (err as Error).message);
      state.update('proclaim', { connected: false });
      generationController?.abort();
      connectionGeneration++;
      statusLoopGeneration++;
      appCommandToken = null;
      onAirSessionId = null;
      connectionId = null;
      presentationCache = null;
      clearTimeout(pollTimer);
      pollTimer = undefined;
      statusLoopRestartPending = false;
      clearTimeout(statusRetryTimer);
      statusRetryTimer = undefined;
      statusLoopActive = false;
      scheduleReconnect();
    }
  } finally {
    if (guarded && pollInFlightGeneration === ownedGeneration) pollInFlightGeneration = null;
    if (guarded && isCurrentGeneration(ownedGeneration)) schedulePoll(ownedGeneration, config.proclaim.pollInterval);
  }
}

// Minimum delay before re-firing statusChanged if it returned faster than expected.
// Grows exponentially on repeated fast responses, resets after a slow (long-poll) response.
const LONG_POLL_THRESHOLD_MS = 5000;
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 10000;

function startStatusLoop(generation: number): void {
  if (!isCurrentGeneration(generation) || statusLoopActive || statusRetryTimer) return;
  statusLoopRestartPending = false;
  const loopGeneration = ++statusLoopGeneration;
  statusLoopActive = true;
  void runStatusLoop(generation, loopGeneration, MIN_RETRY_MS);
}

async function runStatusLoop(generation: number, loopGeneration: number, retryDelay: number): Promise<void> {
  if (!isCurrentGeneration(generation)) {
    statusLoopActive = false;
    return;
  }
  if (loopGeneration !== statusLoopGeneration) {
    statusLoopActive = false;
    if (statusLoopRestartPending && onAirSessionId) {
      statusLoopRestartPending = false;
      startStatusLoop(generation);
    }
    return;
  }

  const start = Date.now();
  try {
    await fetchDetailedStatus(generation);
  } catch (err) {
    if (!isGenerationAbort(err, generationController?.signal)) logger.log('[Proclaim] statusChanged loop error:', (err as Error).message);
  }

  if (!isCurrentGeneration(generation)) {
    statusLoopActive = false;
    return;
  }
  if (loopGeneration !== statusLoopGeneration) {
    statusLoopActive = false;
    if (statusLoopRestartPending && onAirSessionId) {
      statusLoopRestartPending = false;
      startStatusLoop(generation);
    }
    return;
  }

  const elapsed = Date.now() - start;
  const nextDelay = elapsed >= LONG_POLL_THRESHOLD_MS ? MIN_RETRY_MS : Math.min(retryDelay * 2, MAX_RETRY_MS);
  if (elapsed < LONG_POLL_THRESHOLD_MS) {
    logger.debug(`[Proclaim] statusChanged returned in ${elapsed}ms, retrying in ${retryDelay}ms`);
  }
  statusRetryTimer = setTimeout(() => {
    statusRetryTimer = undefined;
    void runStatusLoop(generation, loopGeneration, nextDelay);
  }, elapsed >= LONG_POLL_THRESHOLD_MS ? 0 : retryDelay);
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

async function fetchDetailedStatus(generation?: number): Promise<void> {
  const guarded = generation !== undefined;
  const signal = guarded ? generationController?.signal : undefined;
  const sessionId = onAirSessionId;
  const current = () => !guarded || (isCurrentGeneration(generation!) && onAirSessionId === sessionId);
  if (!sessionId || !current()) return;

  // Fetch presentation cache if missing
  if (!presentationCache) {
    try {
      const presRes = await fetchWithDeadline(`${baseUrl()}/presentations/onair`, {
        headers: { 'OnAirSessionId': sessionId },
      }, signal);
      if (!current()) return;
      if (presRes.ok) {
        presentationCache = parseProclaimJson(await presRes.text());
        if (!current()) return;
        logger.log('[Proclaim] presentations/onair loaded, items:', presentationCache?.serviceItems?.length ?? 0);
      } else {
        logger.debug('[Proclaim] presentations/onair failed:', presRes.status);
      }
    } catch (err) {
      if (!isGenerationAbort(err, signal)) logger.log('[Proclaim] presentations/onair error:', (err as Error).message);
      return;
    }
  }

  // Long-poll: Proclaim blocks up to ~60s, returning immediately only on state change.
  try {
    const headers: Record<string, string> = { 'OnAirSessionId': sessionId };
    if (connectionId) headers['ConnectionId'] = connectionId;
    const res = await fetchWithDeadline(`${baseUrl()}/onair/statusChanged?localrevision=${presentationLocalRevision}&step=${statusRevision}`, { headers }, signal, LONG_POLL_DEADLINE_MS);
    if (!current()) return;

    if (!res.ok) {
      logger.debug('[Proclaim] statusChanged error:', res.status);
      return;
    }

    const data = parseProclaimJson(await res.text()) as {
      presentationId?: string;
      presentationLocalRevision?: number | string;
      status?: { revision?: number | string; itemId?: string; slideIndex?: number };
    } | null;
    if (!current()) return;

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
    // If presentation changed, refresh the cache and drop stale lyric entries
    if (data.presentationId && presentationCache?.id !== data.presentationId) {
      lyricsCache = {};
      try {
        const presRes = await fetchWithDeadline(`${baseUrl()}/presentations/onair`, {
          headers: { 'OnAirSessionId': sessionId },
        }, signal);
        if (!current()) return;
        if (presRes.ok) {
          presentationCache = parseProclaimJson(await presRes.text());
          if (!current()) return;
        }
      } catch (err) {
        if (!isGenerationAbort(err, signal)) logger.log('[Proclaim] onair error:', (err as Error).toString());
      }
    }
    if (!current()) return;
    if (!status) return;

    const rawItems = presentationCache?.serviceItems ?? [];
    const warmupStartIndex: number | null = presentationCache?.warmupStartIndex ?? null;
    const serviceStartIndex: number | null = presentationCache?.serviceStartIndex ?? null;
    const postServiceStartIndex: number | null = presentationCache?.postServiceStartIndex ?? null;

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
    const slideRevisions: Record<string, Record<string, string>> = {};
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
      if (item.slides && item.slides.length > 0) {
        const revMap: Record<string, string> = {};
        for (const slide of item.slides) {
          if (slide.localRevision !== undefined) {
            revMap[String(slide.index)] = String(slide.localRevision);
          }
        }
        if (Object.keys(revMap).length > 0) {
          slideRevisions[item.id] = revMap;
        }
      }
    }

    const currentItem = serviceItems.find((item) => item.id === status.itemId);

    // Pull lyric text from the local Proclaim DB for SongLyrics items (cached
    // per presentation). DB failures are non-fatal; the UI falls back to
    // thumbnail-only display.
    for (const item of rawItems) {
      if (item.kind !== 'SongLyrics' || item.id in lyricsCache) continue;
      const slides = getSongSlides(item.id);
      if (slides !== null) lyricsCache[item.id] = slides;
    }
    if (!current()) return;

    state.update('proclaim', {
      currentItemId: status.itemId || null,
      currentItemTitle: currentItem ? currentItem.title : null,
      currentItemType: currentItem ? currentItem.kind : null,
      slideIndex: status.slideIndex !== undefined ? status.slideIndex : null,
      serviceItems,
      slideRevisions,
      songLyrics: lyricsCache,
    });
  } catch (err) {
    if (!isGenerationAbort(err, signal)) logger.debug('[Proclaim] statusChanged error:', (err as Error).toString());
  }
}

function scheduleReconnect(): void {
  if (!wantConnected || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, 5000);
}

async function connect(): Promise<void> {
  wantConnected = true;
  if (connectInFlight) return connectInFlight;
  if (generationController && !generationController.signal.aborted && appCommandToken) return;

  generationController?.abort();
  const generation = ++connectionGeneration;
  const controller = new AbortController();
  generationController = controller;
  logger.log('[Proclaim] Attempting to connect to', baseUrl());

  const run = (async () => {
    try {
      const token = await authenticateAppCommand(controller.signal);
      if (!isCurrentGeneration(generation)) return;
      appCommandToken = token;
      logger.log('[Proclaim] Authenticated');
      state.update('proclaim', { connected: true });
      startPolling(generation);
    } catch (err) {
      if (isGenerationAbort(err, controller.signal) || !isCurrentGeneration(generation)) return;
      logger.log('[Proclaim] Connection failed:', (err as Error).message);
      state.update('proclaim', { connected: false });
      controller.abort();
      connectionGeneration++;
      scheduleReconnect();
    }
  })();
  connectInFlight = run;
  try {
    await run;
  } finally {
    if (connectInFlight === run) connectInFlight = null;
  }
}

function disconnect(): void {
  wantConnected = false;
  connectionGeneration++;
  statusLoopGeneration++;
  generationController?.abort();
  generationController = null;
  connectInFlight = null;
  clearTimeout(pollTimer);
  pollTimer = undefined;
  clearTimeout(statusRetryTimer);
  statusRetryTimer = undefined;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  pollInFlightGeneration = null;
  statusLoopActive = false;
  statusLoopRestartPending = false;
  appCommandToken = null;
  onAirSessionId = null;
  connectionId = null;
  presentationLocalRevision = '0';
  statusRevision = '0';
  presentationCache = null;
}

async function goToItem(itemId: string): Promise<boolean> {
  const item = state.get().proclaim.serviceItems.find((i) => i.id === itemId);
  if (!item) {
    logger.log(`[Proclaim] goToItem: item ${itemId} not found in state`);
    return false;
  }
  // For the Service section, GoToServiceItem navigates directly to the item
  // without needing StartService first.
  // For Pre-Service, Warmup, and Post-Service, the section command navigates
  // to the start of that section (GoToServiceItem is not applicable there).
  if (item.section === 'Service') {
    return sendAction('GoToServiceItem', item.sectionIndex);
  }
  return sendAction(item.sectionCommand);
}

export {
  connect,
  disconnect,
  sendAction,
  goToItem,
  getThumbUrl,
  getSlideLocalRevision,
  getToken,
  getOnAirSessionId,
  authenticateAppCommand as _authenticateAppCommand,
  authenticateRemote as _authenticateRemote,
  pollStatus as _pollStatus,
  fetchDetailedStatus as _fetchDetailedStatus,
};
