import type { Application, Request, Response } from 'express';
import fs = require('fs');
import type { Connections } from './types';
import discovery = require('./discovery');
import config = require('./config');

const userConfigPath = config.userConfigPath;

function setupRoutes(app: Application, { obs, x32, proclaim }: Connections, stateOverride?: ReturnType<typeof require>, configPathOverride?: string): void {
  const state = stateOverride || require('./state');
  const cfgPath = configPathOverride ?? userConfigPath;

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
      x32.setFader(req.body.channel, req.body.value);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/x32/mute', (req: Request, res: Response) => {
    try {
      x32.toggleMute(req.body.channel);
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

  app.get('/api/proclaim/thumb', async (req: Request, res: Response) => {
    try {
      const url = proclaim.getThumbUrl(
        req.query.itemId as string | undefined,
        req.query.slideIndex as string | undefined,
        req.query.localRevision as string | undefined
      );
      const r = await fetch(url, { headers: { ProclaimAuthToken: proclaim.getToken() || '' } });
      if (!r.ok) return res.status(r.status).end();
      res.set('Content-Type', 'image/png');
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      res.status(500).end();
    }
  });

  // --- OBS program preview screenshot ---
  app.get('/api/obs/screenshot', async (req: Request, res: Response) => {
    try {
      const currentState = state.get();
      const sceneName = currentState.obs.currentScene;
      if (!sceneName) return res.status(503).end();
      const result = await (obs as any).call('GetSourceScreenshot', {
        sourceName: sceneName,
        imageFormat: 'jpeg',
        imageWidth: 480,
        imageCompressionQuality: 70,
      });
      const b64 = (result.imageData as string).replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'no-store');
      res.send(buf);
    } catch (err) {
      res.status(500).end();
    }
  });

  // --- State (for initial page load) ---
  app.get('/api/state', (req: Request, res: Response) => {
    res.json(state.get());
  });

  // --- Config ---
  app.get('/api/config', (req: Request, res: Response) => {
    res.json({ obs: config.obs, x32: config.x32, proclaim: config.proclaim });
  });

  app.post('/api/config', async (req: Request, res: Response) => {
    const body = req.body as {
      obs?: { address?: string; password?: string };
      x32?: { address?: string; port?: number; channels?: unknown[] };
      proclaim?: { host?: string; port?: number; password?: string };
    };
    if (!body.obs || !body.x32 || !body.proclaim) {
      res.status(400).json({ error: 'Request must include obs, x32, and proclaim keys' });
      return;
    }

    // Detect changes against current config before applying
    const obsChanged = body.obs.address !== config.obs.address || body.obs.password !== config.obs.password;
    const x32Changed = body.x32.address !== config.x32.address || body.x32.port !== config.x32.port;
    const proclaimChanged = body.proclaim.host !== config.proclaim.host || body.proclaim.port !== config.proclaim.port || body.proclaim.password !== config.proclaim.password;

    try {
      // Merge new connection config with existing server config (server port not exposed in UI)
      const newConfig = {
        server: config.server,
        obs: body.obs,
        x32: body.x32,
        proclaim: body.proclaim,
      };
      fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2), 'utf-8');
      config.reload();

      if (obsChanged) { obs.disconnect(); await obs.connect(); }
      if (x32Changed) { x32.disconnect(); x32.connect(); }
      if (proclaimChanged) { proclaim.disconnect(); await proclaim.connect(); }

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
}

export = { setupRoutes };
