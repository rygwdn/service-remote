// Must be first: extracts embedded native binaries in compiled mode.
require('./src/native-loader');

const http = require('http');
const express = require('express');
const path = require('path');
const config = require('./src/config');
const state = require('./src/state');
const { startTray } = require('./src/tray');
const { setupWebSocket } = require('./src/ws');
const { setupRoutes } = require('./src/routes');
const obs = require('./src/connections/obs');
const x32 = require('./src/connections/x32');
const proclaim = require('./src/connections/proclaim');

const app = express();
const server = http.createServer(app);

app.use(express.json());

// In compiled mode the public/ files are baked in via scripts/embed-public.js;
// fall back to serving from the filesystem during development.
let embeddedPublic = {};
try { embeddedPublic = require('./src/embedded-public'); } catch (_) {}

if (Object.keys(embeddedPublic).length > 0) {
  app.use((req, res, next) => {
    const key = req.path === '/' ? '/index.html' : req.path;
    const file = embeddedPublic[key];
    if (!file) return next();
    res.set('Content-Type', file.mimeType);
    res.send(file.content);
  });
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

setupRoutes(app, { obs, x32, proclaim });
setupWebSocket(server, state);

obs.connect();
x32.connect();
proclaim.connect();

const port = config.server.port;
server.listen(port, () => {
  console.log(`Service Remote running at http://localhost:${port}`);
  startTray(port, state);
});
