import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import qrcode = require('qrcode');
import type { Connections } from './types';
import * as discovery from './discovery';
import config from './config';
import * as logger from './logger';
import state from './state';
import * as youtube from './connections/youtube';

const userConfigPath = config.userConfigPath;

const THUMB_POLL_TIMEOUT_MS = 5000;

// Concurrency limiter for Proclaim thumbnail fetches
let activeThumbFetches = 0;
const MAX_CONCURRENT_THUMBS = 3;
const thumbQueue: Array<() => void> = [];

// Server-side image cache keyed by (itemId, slideIndex, localRevision)
const thumbCache = new Map<string, Buffer>();

function acquireThumbSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeThumbFetches < MAX_CONCURRENT_THUMBS) {
      activeThumbFetches++;
      resolve();
    } else {
      thumbQueue.push(() => { activeThumbFetches++; resolve(); });
    }
  });
}

function releaseThumbSlot(): void {
  activeThumbFetches--;
  if (thumbQueue.length > 0) thumbQueue.shift()!();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message: string, status = 500): Response {
  return json({ error: message }, status);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown, minLength = 1, maxLength = 4096): value is string {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min && value <= max;
}

function isRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function hasJsonContentType(req: Request): boolean {
  return /^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '');
}

async function readJsonObject(req: Request): Promise<JsonObject | Response> {
  if (!hasJsonContentType(req)) return jsonError('Content-Type must be application/json', 400);
  try {
    const value: unknown = await req.json();
    return isObject(value) ? value : jsonError('JSON body must be an object', 400);
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
}

function unknownKeys(value: JsonObject, allowed: readonly string[]): string[] {
  const keys = new Set(allowed);
  return Object.keys(value).filter((key) => !keys.has(key));
}

function validHost(value: unknown): value is string {
  if (!isString(value, 1, 253)) return false;
  if (net.isIP(value)) return true;
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) && !value.includes('..');
}

function validObsAddress(value: unknown): value is string {
  if (!isString(value, 1, 2048)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && !!parsed.hostname && !parsed.username && !parsed.password && !parsed.pathname.match(/\.\./);
  } catch {
    return false;
  }
}

function validPort(value: unknown): value is number {
  return isInteger(value, 1, 65535);
}

function validPollInterval(value: unknown): value is number {
  return isInteger(value, 100, 86_400_000);
}

function secretValue(value: unknown, current: string): string {
  // Empty values and the configured placeholders used by clients mean “keep”.
  if (!isString(value, 0, 4096) || value === '' || value === '••••••' || value === '[configured]') return current;
  return value;
}

function configured(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function validX32Channel(channel: unknown, type: string): channel is number {
  const max = type === 'ch' ? 32 : type === 'bus' ? 16 : type === 'mtx' ? 6 : 2;
  return isInteger(channel, 1, max);
}
function isDirection(value: unknown): value is -1 | 0 | 1 {
  return value === -1 || value === 0 || value === 1;
}
function isRangePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]) && value[0] < value[1];
}

function validCameraIndex(value: unknown): value is number {
  return isInteger(value, 0);
}

function validCameraConfig(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = ['name', 'enabled', 'address', 'port', 'cameraId', 'numPresets', 'panStep', 'tiltStep', 'zoomStep', 'panRange', 'tiltRange', 'zoomRange'];
  if (unknownKeys(value, keys).length > 0) return false;
  if (!isString(value.name, 1, 200) || typeof value.enabled !== 'boolean' || !validHost(value.address) || !validPort(value.port)) return false;
  if (!isInteger(value.cameraId, 1, 7) || !isInteger(value.numPresets, 0, 99)) return false;
  if (!isRange(value.panStep, 0.0001, 32767) || !isRange(value.tiltStep, 0.0001, 32767) || !isRange(value.zoomStep, 0.0001, 16384)) return false;
  if (!isRangePair(value.panRange) || !isRangePair(value.tiltRange) || !isRangePair(value.zoomRange)) return false;
  const panRange = value.panRange;
  const tiltRange = value.tiltRange;
  const zoomRange = value.zoomRange;
  return panRange[0] >= -32768 && panRange[1] <= 32767 && tiltRange[0] >= -32768 && tiltRange[1] <= 32767 && zoomRange[0] >= 0 && zoomRange[1] <= 16384;
}

function buildSafeConfig(body: JsonObject, current: typeof config): { value?: Record<string, unknown>; error?: string } {
  const allowedTop = ['server', 'obs', 'x32', 'proclaim', 'ptz', 'youtube', 'ui'];
  if (unknownKeys(body, allowedTop).length > 0) return { error: 'Unknown configuration field' };
  const obsValue = body.obs;
  const x32Value = body.x32;
  const proclaimValue = body.proclaim;
  if (!isObject(obsValue) || !isObject(x32Value) || !isObject(proclaimValue)) return { error: 'obs, x32, and proclaim must be objects' };
  const obsIn = obsValue;
  const x32In = x32Value;
  const proclaimIn = proclaimValue;
  if (unknownKeys(obsIn, ['address', 'password', 'passwordConfigured', 'screenshotInterval']).length > 0 || !validObsAddress(obsIn.address) || (obsIn.password !== undefined && !isString(obsIn.password, 0)) || (obsIn.passwordConfigured !== undefined && typeof obsIn.passwordConfigured !== 'boolean') || (obsIn.screenshotInterval !== undefined && !validPollInterval(obsIn.screenshotInterval))) return { error: 'Invalid OBS configuration' };
  if (unknownKeys(x32In, ['address', 'port']).length > 0 || !validHost(x32In.address) || (x32In.port !== undefined && !validPort(x32In.port))) return { error: 'Invalid X32 configuration' };
  if (unknownKeys(proclaimIn, ['host', 'port', 'password', 'passwordConfigured', 'pollInterval', 'presentationDbPath']).length > 0 || !validHost(proclaimIn.host) || (proclaimIn.port !== undefined && !validPort(proclaimIn.port)) || (proclaimIn.password !== undefined && !isString(proclaimIn.password, 0)) || (proclaimIn.passwordConfigured !== undefined && typeof proclaimIn.passwordConfigured !== 'boolean') || (proclaimIn.pollInterval !== undefined && !validPollInterval(proclaimIn.pollInterval)) || (proclaimIn.presentationDbPath !== undefined && !isString(proclaimIn.presentationDbPath, 0, 4096))) return { error: 'Invalid Proclaim configuration' };

  const ptzRaw = body.ptz === undefined ? current.ptz : body.ptz;
  if (!isObject(ptzRaw) || unknownKeys(ptzRaw, ['cameras']).length > 0 || !Array.isArray(ptzRaw.cameras) || ptzRaw.cameras.length > 64) return { error: 'Invalid PTZ configuration' };
  const cameras = ptzRaw.cameras.map((camera, index) => {
    if (!isObject(camera)) return camera;
    return { ...(current.ptz.cameras[index] ?? {}), ...camera };
  });
  const ptz = { cameras };
  if (!cameras.every(validCameraConfig)) return { error: 'Invalid PTZ configuration' };

  const youtubeIn = body.youtube === undefined ? {} : body.youtube;
  if (!isObject(youtubeIn) || unknownKeys(youtubeIn, ['apiKey', 'apiKeyConfigured', 'broadcastId', 'pollInterval', 'oauth']).length > 0) return { error: 'Invalid YouTube configuration' };
  if ((youtubeIn.apiKey !== undefined && !isString(youtubeIn.apiKey, 0)) || (youtubeIn.apiKeyConfigured !== undefined && typeof youtubeIn.apiKeyConfigured !== 'boolean') || (youtubeIn.broadcastId !== undefined && !isString(youtubeIn.broadcastId, 0, 256)) || (youtubeIn.pollInterval !== undefined && !validPollInterval(youtubeIn.pollInterval))) return { error: 'Invalid YouTube configuration' };
  let oauth: Record<string, unknown> = { ...(current.youtube.oauth ?? {}) };
  if (youtubeIn.oauth !== undefined) {
    if (!isObject(youtubeIn.oauth) || unknownKeys(youtubeIn.oauth, ['clientId', 'clientSecret', 'refreshToken', 'clientIdConfigured', 'clientSecretConfigured', 'refreshTokenConfigured']).length > 0) return { error: 'Invalid YouTube OAuth configuration' };
    for (const key of ['clientId', 'clientSecret', 'refreshToken']) if (youtubeIn.oauth[key] !== undefined && !isString(youtubeIn.oauth[key], 0)) return { error: 'Invalid YouTube OAuth configuration' };
    for (const key of ['clientIdConfigured', 'clientSecretConfigured', 'refreshTokenConfigured']) if (youtubeIn.oauth[key] !== undefined && typeof youtubeIn.oauth[key] !== 'boolean') return { error: 'Invalid YouTube OAuth configuration' };
    oauth = { ...oauth, clientId: secretValue(youtubeIn.oauth.clientId, String(current.youtube.oauth?.clientId ?? '')), clientSecret: secretValue(youtubeIn.oauth.clientSecret, String(current.youtube.oauth?.clientSecret ?? '')), refreshToken: secretValue(youtubeIn.oauth.refreshToken, String(current.youtube.oauth?.refreshToken ?? '')) };
  }

  const server = body.server === undefined ? current.server : body.server;
  if (!isObject(server) || unknownKeys(server, ['port', 'openBrowser', 'allowedHosts', 'basePath']).length > 0 || !validPort(server.port) || typeof server.openBrowser !== 'boolean') return { error: 'Invalid server configuration' };
  if (server.allowedHosts !== undefined && (!Array.isArray(server.allowedHosts) || !server.allowedHosts.every((v) => isString(v, 0, 253)))) return { error: 'Invalid server configuration' };
  if (server.basePath !== undefined && (!isString(server.basePath, 0, 128) || (server.basePath !== '' && !/^\/[A-Za-z0-9._~-]*$/.test(server.basePath)))) return { error: 'Invalid server configuration' };
  const ui = body.ui === undefined ? current.ui : body.ui;
  if (!isObject(ui) || unknownKeys(ui, ['hiddenObs', 'hiddenX32']).length > 0 || !Array.isArray(ui.hiddenObs) || !Array.isArray(ui.hiddenX32) || !ui.hiddenObs.every((v) => isString(v, 0, 256)) || !ui.hiddenX32.every((v) => isString(v, 0, 256))) return { error: 'Invalid UI configuration' };

  return { value: {
    server: {
      port: server.port,
      openBrowser: server.openBrowser,
      allowedHosts: Array.isArray(server.allowedHosts) ? server.allowedHosts : current.server.allowedHosts,
      basePath: server.basePath ?? current.server.basePath,
    },
    obs: { address: obsIn.address, password: secretValue(obsIn.password, current.obs.password), screenshotInterval: obsIn.screenshotInterval ?? current.obs.screenshotInterval },
    x32: { address: x32In.address, port: x32In.port ?? current.x32.port },
    proclaim: { host: proclaimIn.host, port: proclaimIn.port ?? current.proclaim.port, password: secretValue(proclaimIn.password, current.proclaim.password), pollInterval: proclaimIn.pollInterval ?? current.proclaim.pollInterval, presentationDbPath: proclaimIn.presentationDbPath ?? current.proclaim.presentationDbPath },
    ptz,
    youtube: { apiKey: secretValue(youtubeIn.apiKey, current.youtube.apiKey ?? ''), broadcastId: youtubeIn.broadcastId ?? current.youtube.broadcastId, pollInterval: youtubeIn.pollInterval ?? current.youtube.pollInterval, oauth },
    ui,
  } };
}

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
}

function setupRoutes(
  connections: Connections,
  stateOverride?: typeof state,
  configPathOverride?: string,
): (req: Request) => Promise<Response> | Response | null {
  const { obs, x32, proclaim, ptz } = connections;
  const activeState = stateOverride ?? state;
  const cfgPath = configPathOverride ?? userConfigPath;

  const routes: Route[] = [];
  function route(method: string, pathname: string, handler: Handler): void {
    routes.push({ method, pattern: new URLPattern({ pathname }), handler });
  }

  // --- OBS ---
  route('POST', '/api/obs/scene', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, ['scene']).length > 0 || !isString(body.scene)) return jsonError('scene must be a string', 400);
    try { await obs.setScene(body.scene); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/obs/mute', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, ['input']).length > 0 || !isString(body.input)) return jsonError('input must be a string', 400);
    try { await obs.toggleMute(body.input); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/obs/volume', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, ['input', 'volumeDb']).length > 0 || !isString(body.input) || !isRange(body.volumeDb, -60, 6)) return jsonError('input and volumeDb are invalid', 400);
    try { await obs.setInputVolume(body.input, body.volumeDb); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/obs/stream', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response || unknownKeys(body, []).length > 0) return body instanceof Response ? body : jsonError('Unexpected fields', 400);
    try { await obs.toggleStream(); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/obs/record', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response || unknownKeys(body, []).length > 0) return body instanceof Response ? body : jsonError('Unexpected fields', 400);
    try { await obs.toggleRecord(); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('GET', '/api/obs/screenshot', async () => {
    try {
      const sceneName = activeState.get().obs.currentScene;
      if (!sceneName) return new Response(null, { status: 503 });
      const buf = await obs.getSceneScreenshot(sceneName);
      return new Response(new Uint8Array(buf), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
    } catch (err) {
      logger.error('[OBS] Screenshot failed:', (err as Error).message);
      return jsonError((err as Error).message);
    }
  });

  // --- X32 ---
  route('POST', '/api/x32/fader', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const type = body.type === undefined ? 'ch' : body.type;
    if (unknownKeys(body, ['channel', 'value', 'type']).length > 0) return jsonError('Invalid X32 fader', 400);
    if (!isEnum(type, ['ch', 'bus', 'main', 'mtx'] as const)) return jsonError('Invalid X32 fader', 400);
    if (!validX32Channel(body.channel, type)) return jsonError('Invalid X32 fader', 400);
    if (!isRange(body.value, 0, 1)) return jsonError('Invalid X32 fader', 400);
    try { await x32.setFader(body.channel, body.value, type); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/x32/mute', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const type = body.type === undefined ? 'ch' : body.type;
    if (unknownKeys(body, ['channel', 'type']).length > 0) return jsonError('Invalid X32 channel', 400);
    if (!isEnum(type, ['ch', 'bus', 'main', 'mtx'] as const)) return jsonError('Invalid X32 channel', 400);
    if (!validX32Channel(body.channel, type)) return jsonError('Invalid X32 channel', 400);
    try { x32.toggleMute(body.channel, type); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/x32/spill', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const type = body.type === undefined ? 'ch' : body.type;
    if (unknownKeys(body, ['channel', 'type', 'assigned']).length > 0) return jsonError('Invalid X32 spill', 400);
    if (!isEnum(type, ['ch', 'bus'] as const)) return jsonError('Invalid X32 spill', 400);
    if (!validX32Channel(body.channel, type)) return jsonError('Invalid X32 spill', 400);
    if (typeof body.assigned !== 'boolean') return jsonError('Invalid X32 spill', 400);
    try { x32.setSpill(body.channel, type, body.assigned); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/x32/bus-send', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, ['channel', 'busIndex', 'value']).length > 0) return jsonError('Invalid X32 bus send', 400);
    if (!isInteger(body.channel, 1, 32)) return jsonError('Invalid X32 bus send', 400);
    if (!isInteger(body.busIndex, 1, 16)) return jsonError('Invalid X32 bus send', 400);
    if (!isRange(body.value, 0, 1)) return jsonError('Invalid X32 bus send', 400);
    try { await x32.setBusSend(body.channel, body.busIndex, body.value); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  // --- Proclaim ---
  route('POST', '/api/proclaim/action', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const actions = ['PreviousSlide', 'NextSlide', 'GoOffAir', 'GoOnAir', 'VideoPause', 'VideoPlay', 'VideoRewind', 'VideoFastForward', 'VideoRestart', 'NextAudioItem', 'GoToSlide', 'GoToServiceItem', 'StartPreService', 'StartWarmUp', 'StartService', 'StartPostService'] as const;
    if (unknownKeys(body, ['action', 'index']).length > 0 || !isEnum(body.action, actions)) return jsonError('Invalid Proclaim action', 400);
    if (body.index !== undefined && !isInteger(body.index, 1, 10000)) return jsonError('Invalid Proclaim action', 400);
    if ((body.action === 'GoToSlide' || body.action === 'GoToServiceItem') && body.index === undefined) return jsonError('Invalid Proclaim action', 400);
    try { const ok = await proclaim.sendAction(body.action, body.index); return json({ ok }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/proclaim/goto-item', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, ['itemId']).length > 0 || !isString(body.itemId, 1, 512)) return jsonError('itemId must be a string', 400);
    try { const ok = await proclaim.goToItem(body.itemId); return json({ ok }); }
    catch (err) { return jsonError((err as Error).message); }
  });


  route('GET', '/api/proclaim/thumb', async (req) => {
    const url = new URL(req.url);
    const itemId = url.searchParams.get('itemId');
    const slideIndexRaw = url.searchParams.get('slideIndex');
    const slideIndexNumber = slideIndexRaw === null ? NaN : Number(slideIndexRaw);
    if (!isString(itemId, 1, 512) || !isInteger(slideIndexNumber, 0, 100000)) return jsonError('itemId and integer slideIndex are required', 400);
    const slideIndex = String(slideIndexNumber);

    const localRevision = proclaim.getSlideLocalRevision(itemId, slideIndex);
    const cacheKey = localRevision ? `${itemId}:${slideIndex}:${localRevision}` : null;
    if (cacheKey && thumbCache.has(cacheKey)) {
      return new Response(new Uint8Array(thumbCache.get(cacheKey)!), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
    }

    await acquireThumbSlot();
    try {
      const thumbUrl = proclaim.getThumbUrl(itemId, slideIndex, url.searchParams.get('localRevision') ?? undefined);
      const sessionId = proclaim.getOnAirSessionId();
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
      if (sessionId) headers['OnAirSessionId'] = sessionId;

      const deadline = Date.now() + THUMB_POLL_TIMEOUT_MS;
      let imageBuffer: Buffer | null = null;

      while (Date.now() < deadline) {
        const r = await fetch(thumbUrl, { headers });
        if (!r.ok) {
          logger.error(`[Proclaim] Thumb ${r.status} for: ${thumbUrl} (sessionId=${sessionId})`);
          return new Response(null, { status: r.status });
        }
        const contentType = r.headers.get('content-type') || '';
        if (contentType.startsWith('image/')) {
          imageBuffer = Buffer.from(await r.arrayBuffer());
          break;
        }
        let estimateMs = 0;
        try {
          const jsonBody = JSON.parse(await r.text());
          if (typeof jsonBody.completionEstimateMs === 'number') estimateMs = jsonBody.completionEstimateMs;
        } catch { /* not JSON */ }
        if (estimateMs <= 0) {
          logger.warn(`[Proclaim] Thumb returned non-image content-type: ${contentType} for: ${thumbUrl}`);
          return new Response(null, { status: 204 });
        }
        const wait = Math.min(estimateMs, deadline - Date.now());
        if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }

      if (!imageBuffer) {
        logger.warn(`[Proclaim] Thumb poll timed out after ${THUMB_POLL_TIMEOUT_MS}ms for: ${thumbUrl}`);
        return new Response(null, { status: 204 });
      }

      const cacheHeaders: Record<string, string> = { 'Content-Type': 'image/png' };
      if (cacheKey) {
        thumbCache.set(cacheKey, imageBuffer);
        cacheHeaders['Cache-Control'] = 'public, max-age=31536000, immutable';
      } else {
        cacheHeaders['Cache-Control'] = 'no-store';
      }
      return new Response(new Uint8Array(imageBuffer), { headers: cacheHeaders });
    } catch (err) {
      logger.error('[Proclaim] Thumb fetch failed:', (err as Error).message);
      return new Response(null, { status: 500 });
    } finally {
      releaseThumbSlot();
    }
  });

  // --- PTZ ---
  route('POST', '/api/ptz/pan-tilt', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const camera = body.camera === undefined ? 0 : body.camera;
    if (unknownKeys(body, ['camera', 'panDir', 'tiltDir', 'panSpeed', 'tiltSpeed']).length > 0 || !validCameraIndex(camera)) return jsonError('Invalid PTZ pan/tilt', 400);
    const panDir = body.panDir;
    const tiltDir = body.tiltDir;
    const panSpeed = body.panSpeed;
    const tiltSpeed = body.tiltSpeed;
    if (!isDirection(panDir) || !isDirection(tiltDir)) return jsonError('Invalid PTZ pan/tilt', 400);
    if (panSpeed !== undefined && !isInteger(panSpeed, 1, 24)) return jsonError('Invalid PTZ pan/tilt', 400);
    if (tiltSpeed !== undefined && !isInteger(tiltSpeed, 1, 20)) return jsonError('Invalid PTZ pan/tilt', 400);
    try { ptz.panTilt(camera, panDir, tiltDir, panSpeed, tiltSpeed); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/ptz/zoom', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const camera = body.camera === undefined ? 0 : body.camera;
    if (unknownKeys(body, ['camera', 'direction']).length > 0 || !validCameraIndex(camera)) return jsonError('Invalid PTZ zoom', 400);
    if (!isEnum(body.direction, ['in', 'out'] as const)) return jsonError('Invalid PTZ zoom', 400);
    try { ptz.zoom(camera, body.direction); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/ptz/focus', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const camera = body.camera === undefined ? 0 : body.camera;
    if (unknownKeys(body, ['camera', 'mode']).length > 0 || !validCameraIndex(camera)) return jsonError('Invalid PTZ focus', 400);
    if (!isEnum(body.mode, ['auto', 'manual', 'near', 'far'] as const)) return jsonError('Invalid PTZ focus', 400);
    try { ptz.focus(camera, body.mode); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/ptz/preset', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const camera = body.camera === undefined ? 0 : body.camera;
    if (unknownKeys(body, ['camera', 'action', 'preset']).length > 0 || !validCameraIndex(camera)) return jsonError('Invalid PTZ preset', 400);
    if (!isEnum(body.action, ['recall', 'save'] as const)) return jsonError('Invalid PTZ preset', 400);
    if (!isInteger(body.preset, 0, 99)) return jsonError('Invalid PTZ preset', 400);
    try { ptz.preset(camera, body.action, body.preset); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/ptz/home', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const camera = body.camera === undefined ? 0 : body.camera;
    if (unknownKeys(body, ['camera']).length > 0 || !validCameraIndex(camera)) return jsonError('Invalid PTZ camera', 400);
    try { ptz.home(camera); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  // --- YouTube ---
  route('POST', '/api/youtube/start', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, []).length > 0) return jsonError('Unexpected fields', 400);
    try { await youtube.startBroadcast(); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/youtube/stop', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, []).length > 0) return jsonError('Unexpected fields', 400);
    try { await youtube.stopBroadcast(); return json({ ok: true }); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/youtube/import-obs-creds', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, []).length > 0) return jsonError('Unexpected fields', 400);
    try {
      const creds = await youtube.importObsCreds();
      if (!creds) return json({ found: false });
      if (creds.accessToken && creds.tokenExpiry && creds.tokenExpiry > Date.now() + 60_000) youtube.seedAccessToken(creds.accessToken, creds.tokenExpiry);
      return json({ found: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('GET', '/api/youtube/broadcasts', async () => {
    try {
      const broadcasts = await youtube.listBroadcasts();
      return json({ broadcasts });
    } catch (err) { return jsonError((err as Error).message); }
  });

  // --- State ---
  route('GET', '/api/state', () => json(activeState.get()));

  // --- Logs ---
  route('GET', '/api/logs', () => json({ logs: logger.getLogs() }));

  // --- Config ---
  route('GET', '/api/config', () => json({
    obs: { address: config.obs.address, screenshotInterval: config.obs.screenshotInterval, passwordConfigured: configured(config.obs.password) },
    x32: { address: config.x32.address, port: config.x32.port },
    proclaim: { host: config.proclaim.host, port: config.proclaim.port, pollInterval: config.proclaim.pollInterval, presentationDbPath: config.proclaim.presentationDbPath, passwordConfigured: configured(config.proclaim.password) },
    ptz: config.ptz,
    youtube: { broadcastId: config.youtube.broadcastId, pollInterval: config.youtube.pollInterval, apiKeyConfigured: configured(config.youtube.apiKey), oauth: { clientIdConfigured: configured(config.youtube.oauth?.clientId), clientSecretConfigured: configured(config.youtube.oauth?.clientSecret), refreshTokenConfigured: configured(config.youtube.oauth?.refreshToken) } },
  }));

  route('POST', '/api/config', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    const checked = buildSafeConfig(body, config);
    if (!checked.value) return jsonError(checked.error ?? 'Invalid configuration', 400);
    const next = checked.value;
    const obsChanged = JSON.stringify(next.obs) !== JSON.stringify(config.obs);
    const x32Changed = JSON.stringify(next.x32) !== JSON.stringify(config.x32);
    const proclaimChanged = JSON.stringify(next.proclaim) !== JSON.stringify(config.proclaim);
    const ptzChanged = JSON.stringify(next.ptz) !== JSON.stringify(config.ptz);
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2), 'utf-8');
      config.reload();
      if (obsChanged) { obs.disconnect(); await obs.connect(); }
      if (x32Changed) { x32.disconnect(); x32.connect(); }
      if (proclaimChanged) { proclaim.disconnect(); await proclaim.connect(); }
      if (ptzChanged) { ptz.disconnect(); ptz.connect(); }
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  // --- UI preferences ---
  route('GET', '/api/ui/hidden', () => json({ hiddenObs: config.ui.hiddenObs, hiddenX32: config.ui.hiddenX32 }));
  route('POST', '/api/ui/hidden', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, ['hiddenObs', 'hiddenX32']).length > 0 || !Array.isArray(body.hiddenObs) || !Array.isArray(body.hiddenX32) || !body.hiddenObs.every((v) => isString(v, 0, 256)) || !body.hiddenX32.every((v) => isString(v, 0, 256))) return jsonError('hiddenObs and hiddenX32 must be arrays of strings', 400);
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(cfgPath)) existing = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      existing.ui = { hiddenObs: body.hiddenObs, hiddenX32: body.hiddenX32 };
      fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2), 'utf-8');
      config.reload();
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  // --- Discovery ---
  route('POST', '/api/discover/x32', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, []).length > 0) return jsonError('Unexpected fields', 400);
    try { return json(await discovery.discoverX32()); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/discover/obs', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, []).length > 0) return jsonError('Unexpected fields', 400);
    try { return json(await discovery.discoverObs()); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/discover/proclaim', async (req) => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return body;
    if (unknownKeys(body, []).length > 0) return jsonError('Unexpected fields', 400);
    try { return json(await discovery.discoverProclaim()); }
    catch (err) { return jsonError((err as Error).message); }
  });

  // --- Server addresses ---
  route('GET', '/api/server/addresses', () => {
    const port = config.server.port;
    const ifaces = os.networkInterfaces();
    const addresses: string[] = [];
    for (const iface of Object.values(ifaces)) {
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) addresses.push(`http://${addr.address}:${port}`);
      }
    }
    addresses.unshift(`http://localhost:${port}`);
    return json({ port, addresses });
  });

  route('GET', '/api/server/qr', async (req) => {
    const url = new URL(req.url);
    const qrUrl = url.searchParams.get('url');
    if (!qrUrl) return jsonError('url query parameter required', 400);
    try {
      const svg = await qrcode.toString(qrUrl, { type: 'svg', margin: 1 });
      return new Response(svg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' },
      });
    } catch (err) { return jsonError((err as Error).message); }
  });

  return function handleRequest(req: Request): Response | Promise<Response> | null {
    const url = new URL(req.url);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec({ pathname: url.pathname });
      if (match) return r.handler(req, match.pathname.groups as Record<string, string>);
    }
    return null; // no route matched — caller handles static files / 404
  };
}

export { setupRoutes };
