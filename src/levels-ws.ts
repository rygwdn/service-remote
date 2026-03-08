import ws = require('ws');
import http = require('http');
import logger = require('./logger');

const { WebSocketServer } = ws;

interface LevelsPayload {
  x32: Record<string, number>;
  obs: Record<string, number>;
}

// The module-level broadcaster is updated each time setupLevelsWs is called.
// x32.ts and obs.ts call broadcast() which always forwards to the most recently set up instance.
let activeBroadcast: ((levels: LevelsPayload) => void) | null = null;

/**
 * Broadcasts a levels payload to all connected /ws/levels clients.
 * No-op if no WS server has been set up yet.
 */
function broadcast(levels: LevelsPayload): void {
  if (activeBroadcast) activeBroadcast(levels);
}

/**
 * Attaches a WebSocket server to the HTTP server that serves compact JSON
 * level payloads at the path /ws/levels.
 *
 * Each call creates a new WebSocketServer bound to the given http.Server.
 * The returned broadcaster sends payloads only to clients of that server.
 * Also updates the module-level broadcaster so x32.ts/obs.ts's broadcast() call
 * is routed to the most recently set up instance.
 *
 * Returns the broadcaster function bound to this server.
 */
function setupLevelsWs(server: http.Server): (levels: LevelsPayload) => void {
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade requests for /ws/levels on this server
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws/levels') {
      wss.handleUpgrade(req, socket as import('stream').Duplex, head, (client) => {
        wss.emit('connection', client, req);
      });
    }
  });

  wss.on('connection', () => {
    logger.log('[Levels WS] Client connected');
  });

  function broadcastToServer(levels: LevelsPayload): void {
    const msg = JSON.stringify(levels);
    for (const client of wss.clients) {
      if (client.readyState === ws.WebSocket.OPEN) {
        try {
          client.send(msg);
        } catch {
          // Client disconnected between readyState check and send
        }
      }
    }
  }

  // Update the module-level broadcaster to point at this server's instance
  activeBroadcast = broadcastToServer;

  return broadcastToServer;
}

export = { setupLevelsWs, broadcast };
