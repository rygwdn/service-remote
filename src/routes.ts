import type { Application, Request, Response } from 'express';
import type { Connections } from './types';

function setupRoutes(app: Application, { obs, x32, proclaim }: Connections, stateOverride?: ReturnType<typeof require>): void {
  const state = stateOverride || require('./state');

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

  // --- State (for initial page load) ---
  app.get('/api/state', (req: Request, res: Response) => {
    res.json(state.get());
  });
}

export = { setupRoutes };
