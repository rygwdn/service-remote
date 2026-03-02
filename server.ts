import http = require('http');
import express = require('express');
import path = require('path');
import childProcess = require('child_process');
import config = require('./src/config');
import logger = require('./src/logger');

const { exec } = childProcess;
import state = require('./src/state');
const { startTray } = require('./src/tray');
const { setupWebSocket } = require('./src/ws');
const { setupRoutes } = require('./src/routes');
import obs = require('./src/connections/obs');
import x32 = require('./src/connections/x32');
import proclaim = require('./src/connections/proclaim');

// ── Crash / unexpected-shutdown logging ──────────────────────────────────────

// Ignore EPIPE errors on stdout/stderr (happens when terminal is closed)
process.stdout.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return; // stdout/stderr closed, not a real crash
  logger.error('[Server] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('[Server] Unhandled promise rejection:', reason);
});

function shutdown(signal: string): void {
  logger.log(`[Server] Received ${signal}, shutting down...`);
  server.close(() => {
    logger.log('[Server] Shutdown complete');
    process.exit(0);
  });
  // Force-exit if active connections prevent a clean close within 5 s
  setTimeout(() => {
    logger.warn('[Server] Forced exit after shutdown timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Helpers ──────────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'  ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) logger.warn('[Server] Could not open browser:', err.message);
  });
}

// ── App setup ────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

app.use(express.json());

// In compiled mode the public/ files are baked in via scripts/embed-public.js;
// fall back to serving from the filesystem during development.
let embeddedPublic: Record<string, { mimeType: string; content: Buffer }> = {};
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
setupWebSocket(server, state, x32);

// Set up file logging next to config.json
const logFile = path.join(path.dirname(config.userConfigPath), 'service-remote.log');
logger.setLogFile(logFile);

obs.connect();
x32.connect();
proclaim.connect();

const port = config.server.port;
const url = `http://localhost:${port}`;
server.listen(port, () => {
  logger.log(`[Server] Service Remote running at ${url}`);
  openBrowser(url);
  startTray(port, state);
});
