import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import * as logger from './logger';

// The module-level broadcaster is updated each time setupScreenshotWs is called.
// obs.ts calls broadcast() which always forwards to the most recently set up instance.
let activeBroadcast: ((frame: Buffer) => void) | null = null;

/**
 * Broadcasts a raw JPEG Buffer to all connected /ws/screenshot clients.
 * No-op if no WS server has been set up yet.
 */
function broadcast(frame: Buffer): void {
  if (activeBroadcast) activeBroadcast(frame);
}

/**
 * Attaches a WebSocket server to the HTTP server that serves binary
 * JPEG frames at the path /ws/screenshot.
 *
 * Each call creates a new WebSocketServer bound to the given http.Server.
 * The returned broadcaster sends frames only to clients of that server.
 * Also updates the module-level broadcaster so obs.ts's broadcast() call
 * is routed to the most recently set up instance.
 *
 * Returns the broadcaster function bound to this server.
 */
function setupScreenshotWs(server: http.Server): (frame: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade requests for /ws/screenshot on this server
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws/screenshot') {
      wss.handleUpgrade(req, socket as import('stream').Duplex, head, (client) => {
        wss.emit('connection', client, req);
      });
    }
  });

  wss.on('connection', () => {
    logger.log('[Screenshot WS] Client connected');
  });

  function broadcastToServer(frame: Buffer): void {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(frame);
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

export { setupScreenshotWs, broadcast };
