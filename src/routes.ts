import type { Application, Request, Response } from 'express';
import fs = require('fs');
import os = require('os');
import qrcode = require('qrcode');
import type { Connections } from './types';
import discovery = require('./discovery');
import config = require('./config');
import logger = require('./logger');
import defaultState = require('./state');
import youtube = require('./connections/youtube');

const userConfigPath = config.userConfigPath;

const THUMB_POLL_TIMEOUT_MS = 5000;

function setupRoutes(app: Application, { obs, x32, proclaim, ptz }: Connections, stateOverride?: typeof defaultState, configPathOverride?: string): void {
  const state = stateOverride ?? defaultState;
  const cfgPath = configPathOverride ?? userConfigPath;

  // Concurrency limiter for Proclaim thumbnail fetches (instance-local so tests don't share state)
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

  // --- OBS ---
  app.post('/api/obs/scene', async (req: Request, res: Response) => {
    try {
      await obs.setScene(req.body.scene);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/obs/mute', async (req: Request, res: Response) => {
    try {
      await obs.toggleMute(req.body.input);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/obs/volume', async (req: Request, res: Response) => {
    try {
      await obs.setInputVolume(req.body.input, req.body.volumeDb);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/obs/stream', async (req: Request, res: Response) => {
    try {
      await obs.toggleStream();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/obs/record', async (req: Request, res: Response) => {
    try {
      await obs.toggleRecord();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- X32 ---
  app.post('/api/x32/fader', (req: Request, res: Response) => {
    try {
      x32.setFader(req.body.channel, req.body.value, req.body.type || 'ch');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/x32/mute', (req: Request, res: Response) => {
    try {
      x32.toggleMute(req.body.channel, req.body.type || 'ch');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/x32/spill', (req: Request, res: Response) => {
    try {
      const type = req.body.type === 'bus' ? 'bus' : 'ch';
      x32.setSpill(req.body.channel, type, !!req.body.assigned);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Proclaim ---
  app.post('/api/proclaim/action', async (req: Request, res: Response) => {
    try {
      const ok = await proclaim.sendAction(req.body.action, req.body.index);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/proclaim/goto-item', async (req: Request, res: Response) => {
    try {
      const ok = await proclaim.goToItem(req.body.itemId);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/proclaim/thumb', async (req: Request, res: Response) => {
    const itemId = req.query.itemId as string | undefined;
    const slideIndex = req.query.slideIndex as string | undefined;

    // Look up the canonical localRevision for this slide (used for cache key + HTTP headers)
    const localRevision = proclaim.getSlideLocalRevision(itemId, slideIndex);
    // Include itemId + slideIndex in cache key — localRevision alone may be shared across slides
    const cacheKey = localRevision ? `${itemId}:${slideIndex}:${localRevision}` : null;

    // Serve from server-side cache if available
    if (cacheKey && thumbCache.has(cacheKey)) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(thumbCache.get(cacheKey));
    }

    await acquireThumbSlot();
    try {
      const url = proclaim.getThumbUrl(itemId, slideIndex, req.query.localRevision as string | undefined);
      const sessionId = proclaim.getOnAirSessionId();
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
      if (sessionId) headers['OnAirSessionId'] = sessionId;

      const deadline = Date.now() + THUMB_POLL_TIMEOUT_MS;
      let imageBuffer: Buffer | null = null;

      while (Date.now() < deadline) {
        const r = await fetch(url, { headers });
        if (!r.ok) {
          logger.error(`[Proclaim] Thumb ${r.status} for: ${url} (sessionId=${sessionId})`);
          return res.status(r.status).end();
        }
        const contentType = r.headers.get('content-type') || '';
        if (contentType.startsWith('image/')) {
          imageBuffer = Buffer.from(await r.arrayBuffer());
          break;
        }
        // Check for completionEstimateMs in JSON response
        let estimateMs = 0;
        try {
          const json = JSON.parse(await r.text());
          if (typeof json.completionEstimateMs === 'number') {
            estimateMs = json.completionEstimateMs;
          }
        } catch {
          // not JSON or no estimate — fall through to 204
        }
        if (estimateMs <= 0) {
          logger.warn(`[Proclaim] Thumb returned non-image content-type: ${contentType} for: ${url}`);
          return res.status(204).end();
        }
        // Wait the estimated time before retrying (clamped to remaining deadline)
        const wait = Math.min(estimateMs, deadline - Date.now());
        if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }

      if (!imageBuffer) {
        logger.warn(`[Proclaim] Thumb poll timed out after ${THUMB_POLL_TIMEOUT_MS}ms for: ${url}`);
        return res.status(204).end();
      }

      // Cache by (itemId, slideIndex, localRevision) if available
      if (cacheKey) {
        thumbCache.set(cacheKey, imageBuffer);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.set('Cache-Control', 'no-store');
      }
      res.set('Content-Type', 'image/png');
      res.send(imageBuffer);
    } catch (err) {
      logger.error('[Proclaim] Thumb fetch failed:', (err as Error).message);
      res.status(500).end();
    } finally {
      releaseThumbSlot();
    }
  });

  // --- PTZ ---
  app.post('/api/ptz/pan-tilt', (req: Request, res: Response) => {
    try {
      const { camera = 0, panDir, tiltDir, panSpeed, tiltSpeed } = req.body as {
        camera?: number; panDir: -1 | 0 | 1; tiltDir: -1 | 0 | 1;
        panSpeed?: number; tiltSpeed?: number;
      };
      ptz.panTilt(camera, panDir, tiltDir, panSpeed, tiltSpeed);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/ptz/zoom', (req: Request, res: Response) => {
    try {
      const { camera = 0, direction } = req.body as { camera?: number; direction: 'in' | 'out' };
      ptz.zoom(camera, direction);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/ptz/focus', (req: Request, res: Response) => {
    try {
      const { camera = 0, mode } = req.body as { camera?: number; mode: 'auto' | 'manual' | 'near' | 'far' };
      ptz.focus(camera, mode);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/ptz/preset', (req: Request, res: Response) => {
    try {
      const { camera = 0, action, preset } = req.body as { camera?: number; action: 'recall' | 'save'; preset: number };
      ptz.preset(camera, action, preset);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/ptz/home', (req: Request, res: Response) => {
    try {
      const { camera = 0 } = req.body as { camera?: number };
      ptz.home(camera);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- YouTube ---
  app.post('/api/youtube/start', async (req: Request, res: Response) => {
    try {
      await youtube.startBroadcast();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/youtube/stop', async (req: Request, res: Response) => {
    try {
      await youtube.stopBroadcast();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/youtube/import-obs-creds', async (req: Request, res: Response) => {
    try {
      const creds = await youtube.importObsCreds(req.body.obsConfigDir as string | undefined);
      if (!creds) {
        res.json({ found: false });
      } else {
        res.json({ found: true, clientId: creds.clientId, clientSecret: creds.clientSecret, refreshToken: creds.refreshToken });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- OBS program preview screenshot ---
  app.get('/api/obs/screenshot', async (req: Request, res: Response) => {
    try {
      const currentState = state.get();
      const sceneName = currentState.obs.currentScene;
      if (!sceneName) return res.status(503).end();
      const buf = await obs.getSceneScreenshot(sceneName);
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      logger.error('[OBS] Screenshot failed:', (err as Error).message);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- State (for initial page load) ---
  app.get('/api/state', (req: Request, res: Response) => {
    res.json(state.get());
  });

  // --- Logs ---
  app.get('/api/logs', (req: Request, res: Response) => {
    res.json({ logs: logger.getLogs() });
  });

  // --- Config ---
  app.get('/api/config', (req: Request, res: Response) => {
    res.json({ obs: config.obs, x32: config.x32, proclaim: config.proclaim, ptz: config.ptz, youtube: config.youtube });
  });

  app.post('/api/config', async (req: Request, res: Response) => {
    const body = req.body as {
      obs?: { address?: string; password?: string; screenshotInterval?: number };
      x32?: { address?: string; port?: number };
      proclaim?: { host?: string; port?: number; password?: string; pollInterval?: number };
      ptz?: { cameras?: unknown[] };
      youtube?: { apiKey?: string; broadcastId?: string; pollInterval?: number };
    };
    if (!body.obs || !body.x32 || !body.proclaim) {
      res.status(400).json({ error: 'Request must include obs, x32, and proclaim keys' });
      return;
    }

    const obsChanged = body.obs.address !== config.obs.address || body.obs.password !== config.obs.password;
    const x32Changed = body.x32.address !== config.x32.address || body.x32.port !== config.x32.port;
    const proclaimChanged = body.proclaim.host !== config.proclaim.host || body.proclaim.port !== config.proclaim.port || body.proclaim.password !== config.proclaim.password || body.proclaim.pollInterval !== config.proclaim.pollInterval;
    const ptzChanged = body.ptz != null && JSON.stringify(body.ptz) !== JSON.stringify(config.ptz);

    try {
      const newConfig = {
        server: config.server,
        obs: body.obs,
        x32: body.x32,
        proclaim: body.proclaim,
        ptz: body.ptz ?? config.ptz,
        youtube: body.youtube ?? config.youtube,
        ui: config.ui,
      };
      fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2), 'utf-8');
      config.reload();

      if (obsChanged) { obs.disconnect(); await obs.connect(); }
      if (x32Changed) { x32.disconnect(); x32.connect(); }
      if (proclaimChanged) { proclaim.disconnect(); await proclaim.connect(); }
      if (ptzChanged) { ptz.disconnect(); ptz.connect(); }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- UI preferences (hidden faders) ---
  app.get('/api/ui/hidden', (req: Request, res: Response) => {
    res.json({ hiddenObs: config.ui.hiddenObs, hiddenX32: config.ui.hiddenX32 });
  });

  app.post('/api/ui/hidden', (req: Request, res: Response) => {
    const { hiddenObs, hiddenX32 } = req.body as { hiddenObs?: unknown; hiddenX32?: unknown };
    if (!Array.isArray(hiddenObs) || !Array.isArray(hiddenX32)) {
      res.status(400).json({ error: 'hiddenObs and hiddenX32 must be arrays' });
      return;
    }
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(cfgPath)) {
        existing = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      }
      existing.ui = { hiddenObs, hiddenX32 };
      fs.writeFileSync(cfgPath, JSON.stringify(existing, null, 2), 'utf-8');
      config.reload();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Discovery ---
  app.post('/api/discover/x32', async (req: Request, res: Response) => {
    try {
      const result = await discovery.discoverX32();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/discover/obs', async (req: Request, res: Response) => {
    try {
      const result = await discovery.discoverObs();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/discover/proclaim', async (req: Request, res: Response) => {
    try {
      const result = await discovery.discoverProclaim();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Server addresses ---
  app.get('/api/server/addresses', (req: Request, res: Response) => {
    const port = config.server.port;
    const ifaces = os.networkInterfaces();
    const addresses: string[] = [];
    for (const iface of Object.values(ifaces)) {
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          addresses.push(`http://${addr.address}:${port}`);
        }
      }
    }
    // Always include localhost
    addresses.unshift(`http://localhost:${port}`);
    res.json({ port, addresses });
  });

  app.get('/api/server/qr', async (req: Request, res: Response) => {
    const url = req.query.url as string | undefined;
    if (!url) {
      res.status(400).json({ error: 'url query parameter required' });
      return;
    }
    try {
      const svg = await qrcode.toString(url, { type: 'svg', margin: 1 });
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=300');
      res.send(svg);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}

export = { setupRoutes };
