import http from 'http';
import express from 'express';
import path from 'path';
import { exec } from 'child_process';
import config from './src/config';
import * as logger from './src/logger';
import { version } from './src/version';
import state from './src/state';
import { startTray } from './src/tray';
import { setupWebSocket } from './src/ws';
import { setupRoutes } from './src/routes';
import { setupLevelsWs } from './src/levels-ws';
import { setupScreenshotWs } from './src/screenshot-ws';
import { setupBusWs } from './src/bus-ws';
import obs from './src/connections/obs';
import * as x32 from './src/connections/x32';
import * as proclaim from './src/connections/proclaim';
import * as ptz from './src/connections/ptz';
import * as youtube from './src/connections/youtube';

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
  obs.disconnect();
  x32.disconnect();
  proclaim.disconnect();
  ptz.disconnect();
  youtube.disconnect();
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

// In compiled mode the public/ files are baked in via scripts/embed-public.ts;
// fall back to serving from the filesystem during development.
let embeddedPublic: Record<string, { mimeType: string; content: Buffer }> = {};
try { embeddedPublic = (await import('./src/embedded-public')).default; } catch (_) {}

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

setupRoutes(app, { obs, x32, proclaim, ptz });
setupWebSocket(server, state, { obs, x32, proclaim, ptz });
youtube.connect();
setupLevelsWs(server);
setupScreenshotWs(server);
setupBusWs(server, state, x32);

// Set up file logging next to config.json
const logFile = path.join(path.dirname(config.userConfigPath), 'service-remote.log');
logger.setLogFile(logFile);

const port = config.server.port;
const url = `http://localhost:${port}`;
server.listen(port, () => {
  logger.log(`[Server] Service Remote v${version} running at ${url}`);
  if (config.server.openBrowser) openBrowser(url);
  startTray(port, version, state, () => shutdown('tray'));
});
