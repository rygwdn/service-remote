import fs from 'fs';
import os from 'os';
import path from 'path';
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
    try {
      const body = await req.json() as { scene: string };
      await obs.setScene(body.scene);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/obs/mute', async (req) => {
    try {
      const body = await req.json() as { input: string };
      await obs.toggleMute(body.input);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/obs/volume', async (req) => {
    try {
      const body = await req.json() as { input: string; volumeDb: number };
      await obs.setInputVolume(body.input, body.volumeDb);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/obs/stream', async () => {
    try {
      await obs.toggleStream();
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/obs/record', async () => {
    try {
      await obs.toggleRecord();
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
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
    try {
      const body = await req.json() as { channel: number; value: number; type?: 'ch' | 'bus' | 'main' | 'mtx' };
      x32.setFader(body.channel, body.value, body.type || 'ch');
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/x32/mute', async (req) => {
    try {
      const body = await req.json() as { channel: number; type?: 'ch' | 'bus' | 'main' | 'mtx' };
      x32.toggleMute(body.channel, body.type || 'ch');
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/x32/spill', async (req) => {
    try {
      const body = await req.json() as { channel: number; type?: 'ch' | 'bus'; assigned: boolean };
      const type = body.type === 'bus' ? 'bus' : 'ch';
      x32.setSpill(body.channel, type, !!body.assigned);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/x32/bus-send', async (req) => {
    try {
      const body = await req.json() as { channel: number; busIndex?: number; value?: number };
      if (body.busIndex == null || body.value == null) {
        return jsonError('channel, busIndex, and value are required', 400);
      }
      x32.setBusSend(body.channel, body.busIndex, body.value);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  // --- Proclaim ---
  route('POST', '/api/proclaim/action', async (req) => {
    try {
      const body = await req.json() as { action: string; index?: number };
      const ok = await proclaim.sendAction(body.action, body.index);
      return json({ ok });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/proclaim/goto-item', async (req) => {
    try {
      const body = await req.json() as { itemId: string };
      const ok = await proclaim.goToItem(body.itemId);
      return json({ ok });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('GET', '/api/proclaim/thumb', async (req) => {
    const url = new URL(req.url);
    const itemId = url.searchParams.get('itemId') ?? undefined;
    const slideIndex = url.searchParams.get('slideIndex') ?? undefined;

    const localRevision = proclaim.getSlideLocalRevision(itemId, slideIndex);
    const cacheKey = localRevision ? `${itemId}:${slideIndex}:${localRevision}` : null;

    if (cacheKey && thumbCache.has(cacheKey)) {
      return new Response(new Uint8Array(thumbCache.get(cacheKey)!), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
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
    try {
      const body = await req.json() as { camera?: number; panDir: -1 | 0 | 1; tiltDir: -1 | 0 | 1; panSpeed?: number; tiltSpeed?: number };
      ptz.panTilt(body.camera ?? 0, body.panDir, body.tiltDir, body.panSpeed, body.tiltSpeed);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/ptz/zoom', async (req) => {
    try {
      const body = await req.json() as { camera?: number; direction: 'in' | 'out' };
      ptz.zoom(body.camera ?? 0, body.direction);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/ptz/focus', async (req) => {
    try {
      const body = await req.json() as { camera?: number; mode: 'auto' | 'manual' | 'near' | 'far' };
      ptz.focus(body.camera ?? 0, body.mode);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/ptz/preset', async (req) => {
    try {
      const body = await req.json() as { camera?: number; action: 'recall' | 'save'; preset: number };
      ptz.preset(body.camera ?? 0, body.action, body.preset);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/ptz/home', async (req) => {
    try {
      const body = await req.json() as { camera?: number };
      ptz.home(body.camera ?? 0);
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  // --- YouTube ---
  route('POST', '/api/youtube/start', async () => {
    try {
      await youtube.startBroadcast();
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/youtube/stop', async () => {
    try {
      await youtube.stopBroadcast();
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/youtube/import-obs-creds', async (req) => {
    try {
      const body = await req.json() as { obsConfigDir?: string };
      const creds = await youtube.importObsCreds(body.obsConfigDir);
      if (!creds) return json({ found: false });
      if (creds.accessToken && creds.tokenExpiry && creds.tokenExpiry > Date.now() + 60_000) {
        youtube.seedAccessToken(creds.accessToken, creds.tokenExpiry);
      }
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
  route('GET', '/api/config', () => json({ obs: config.obs, x32: config.x32, proclaim: config.proclaim, ptz: config.ptz, youtube: config.youtube }));

  route('POST', '/api/config', async (req) => {
    const body = await req.json() as {
      obs?: { address?: string; password?: string; screenshotInterval?: number };
      x32?: { address?: string; port?: number };
      proclaim?: { host?: string; port?: number; password?: string; pollInterval?: number };
      ptz?: { cameras?: unknown[] };
      youtube?: { apiKey?: string; broadcastId?: string; pollInterval?: number };
    };
    if (!body.obs || !body.x32 || !body.proclaim) {
      return jsonError('Request must include obs, x32, and proclaim keys', 400);
    }
    const obsChanged = body.obs.address !== config.obs.address || body.obs.password !== config.obs.password;
    const x32Changed = body.x32.address !== config.x32.address || body.x32.port !== config.x32.port;
    const proclaimChanged = body.proclaim.host !== config.proclaim.host || body.proclaim.port !== config.proclaim.port || body.proclaim.password !== config.proclaim.password || body.proclaim.pollInterval !== config.proclaim.pollInterval;
    const ptzChanged = body.ptz != null && JSON.stringify(body.ptz) !== JSON.stringify(config.ptz);
    try {
      const newConfig = { server: config.server, obs: body.obs, x32: body.x32, proclaim: body.proclaim, ptz: body.ptz ?? config.ptz, youtube: body.youtube ?? config.youtube, ui: config.ui };
      fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2), 'utf-8');
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
    const body = await req.json() as { hiddenObs?: unknown; hiddenX32?: unknown };
    if (!Array.isArray(body.hiddenObs) || !Array.isArray(body.hiddenX32)) {
      return jsonError('hiddenObs and hiddenX32 must be arrays', 400);
    }
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(cfgPath)) {
        existing = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      }
      existing.ui = { hiddenObs: body.hiddenObs, hiddenX32: body.hiddenX32 };
      fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2), 'utf-8');
      config.reload();
      return json({ ok: true });
    } catch (err) { return jsonError((err as Error).message); }
  });

  // --- Discovery ---
  route('POST', '/api/discover/x32', async () => {
    try { return json(await discovery.discoverX32()); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/discover/obs', async () => {
    try { return json(await discovery.discoverObs()); }
    catch (err) { return jsonError((err as Error).message); }
  });

  route('POST', '/api/discover/proclaim', async () => {
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
