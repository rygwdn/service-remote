import path from 'path';
import { handleServiceArgs, installService, uninstallService } from './src/service';
import config from './src/config';

// Handle --install-service / --uninstall-service before loading any other modules.
if (process.platform === 'win32') {
  const serviceAction = handleServiceArgs();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : config.server.port;
  if (serviceAction === 'install') {
    installService(process.execPath, port);
    process.exit(0);
  } else if (serviceAction === 'uninstall') {
    uninstallService();
    process.exit(0);
  }
}
import * as logger from './src/logger';
import { version } from './src/version';
import state from './src/state';
import { startTray } from './src/tray';
import { setupWebSocket } from './src/ws';
import { setupRoutes } from './src/routes';
import obs from './src/connections/obs';
import * as x32 from './src/connections/x32';
import * as proclaim from './src/connections/proclaim';
import * as ptz from './src/connections/ptz';
import * as youtube from './src/connections/youtube';
import updater from './src/updater';
import type { UpdateInfo } from './src/updater';

// ── Crash / unexpected-shutdown logging ──────────────────────────────────────

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return;
  logger.error('[Server] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('[Server] Unhandled promise rejection:', reason);
});

// ── App setup ────────────────────────────────────────────────────────────────

// In compiled mode the public/ files are baked in via scripts/embed-public.ts.
let embeddedPublic: Record<string, { mimeType: string; content: Buffer }> = {};
try { embeddedPublic = (await import('./src/embedded-public')).default; } catch (_) {}

const hasEmbedded = Object.keys(embeddedPublic).length > 0;
const publicDir = path.join(__dirname, 'public');

async function serveStatic(pathname: string): Promise<Response | null> {
  const key = pathname === '/' ? '/index.html' : pathname;

  if (hasEmbedded) {
    const file = embeddedPublic[key];
    if (!file) return null;
    return new Response(new Uint8Array(file.content), {
      headers: { 'Content-Type': file.mimeType, 'Cache-Control': 'no-store' },
    });
  }

  // Dev mode: serve from filesystem
  const filePath = path.join(publicDir, key);
  const bunFile = Bun.file(filePath);
  if (!(await bunFile.exists())) return null;
  return new Response(bunFile, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

youtube.connect();

const handleRequest = setupRoutes({ obs, x32, proclaim, ptz });

const { websocket, upgrade, hasClients } = setupWebSocket(
  state,
  { obs, x32, proclaim, ptz },
  { canStopX32: () => !hasClients() },
);

// ── Bun.serve ────────────────────────────────────────────────────────────────

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : config.server.port;

const server = Bun.serve<import('./src/ws').SocketData>({
  port,

  async fetch(req, srv) {
    // WebSocket upgrade
    if (upgrade(req, srv)) return undefined as unknown as Response;

    // API routes
    const apiResponse = handleRequest(req);
    if (apiResponse) return apiResponse;

    // Static files
    const { pathname } = new URL(req.url);
    const staticResponse = await serveStatic(pathname);
    if (staticResponse) return staticResponse;

    return new Response('Not found', { status: 404 });
  },

  websocket,
});

// ── File logging ─────────────────────────────────────────────────────────────

const logFile = path.join(path.dirname(config.userConfigPath), 'service-remote.log');
logger.setLogFile(logFile);

// ── Start ─────────────────────────────────────────────────────────────────────

const url = `http://localhost:${server.port}`;
logger.log(`[Server] Service Remote v${version} running at ${url}`);


// ── Update checker ────────────────────────────────────────────────────────────

let pendingUpdate: UpdateInfo | null = null;

async function applyUpdate(info: UpdateInfo, tray: import('./src/tray').TrayHandle | null): Promise<void> {
  try {
    const os = await import('os');
    const { spawnSync } = await import('child_process');
    const exePath = await updater.download(info, os.tmpdir());
    logger.log(`[Server] Running installer: ${exePath} --install-service`);
    spawnSync(exePath, ['--install-service'], { stdio: 'inherit' });
  } catch (err) {
    logger.warn('[Server] Update failed:', err instanceof Error ? err.message : String(err));
    // Re-show the menu item so the user can retry
    tray?.sendUpdateAvailable();
  }
}

const tray = startTray(port, version, state, () => shutdown('tray'), () => {
  if (!pendingUpdate) return;
  const info = pendingUpdate;
  pendingUpdate = null;
  tray?.sendUpdateClear();
  void applyUpdate(info, tray);
});

updater.on('update-available', (info: UpdateInfo) => {
  pendingUpdate = info;
  tray?.sendUpdateAvailable();
});

updater.start();

// ── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.log(`[Server] Received ${signal}, shutting down...`);
  updater.stop();
  obs.disconnect();
  x32.disconnect();
  proclaim.disconnect();
  ptz.disconnect();
  youtube.disconnect();
  server.stop(true);
  logger.log('[Server] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
