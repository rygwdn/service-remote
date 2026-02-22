function setupRoutes(app, { obs, x32, proclaim }) {
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
  app.post('/api/proclaim/action', (req, res) => {
    const ok = proclaim.sendAction(req.body.action);
    res.json({ ok });
  });

  // --- State (for initial page load) ---
  const state = require('./state');
  app.get('/api/state', (req, res) => {
    res.json(state.get());
  });
}

module.exports = { setupRoutes };
