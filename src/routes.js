function setupRoutes(app, { obs, x32, proclaim }, stateOverride) {
  const state = stateOverride || require('./state');
  // --- OBS ---
  app.post('/api/obs/scene', async (req, res) => {
    try {
      await obs.setScene(req.body.scene);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/obs/mute', async (req, res) => {
    try {
      await obs.toggleMute(req.body.input);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/obs/volume', async (req, res) => {
    try {
      await obs.setInputVolume(req.body.input, req.body.volumeDb);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/obs/stream', async (req, res) => {
    try {
      await obs.toggleStream();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/obs/record', async (req, res) => {
    try {
      await obs.toggleRecord();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- X32 ---
  app.post('/api/x32/fader', (req, res) => {
    try {
      x32.setFader(req.body.channel, req.body.value);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/x32/mute', (req, res) => {
    try {
      x32.toggleMute(req.body.channel);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Proclaim ---
  app.post('/api/proclaim/action', async (req, res) => {
    try {
      const ok = await proclaim.sendAction(req.body.action, req.body.index);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/proclaim/thumb', async (req, res) => {
    try {
      const url = proclaim.getThumbUrl(req.query.itemId, req.query.slideIndex, req.query.localRevision);
      const r = await fetch(url, { headers: { ProclaimAuthToken: proclaim.getToken() } });
      if (!r.ok) return res.status(r.status).end();
      res.set('Content-Type', 'image/png');
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      res.status(500).end();
    }
  });

  // --- State (for initial page load) ---
  app.get('/api/state', (req, res) => {
    res.json(state.get());
  });
}

module.exports = { setupRoutes };
