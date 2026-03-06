import ws = require('ws');
import http = require('http');
import type { Connections } from './types';

const { WebSocketServer } = ws;

function setupWebSocket(server: http.Server, state: ReturnType<typeof require>, connections?: Connections): void {
  const wss = new WebSocketServer({ server });
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function openClientCount(): number {
    let count = 0;
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) count++;
    }
    return count;
  }

  wss.on('connection', (socket) => {
    // Cancel any pending disconnect
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }

    // Send full state on connect
    socket.send(JSON.stringify({ type: 'state', data: state.get() }));

    // Start each service only if it isn't already connected
    if (connections) {
      const s = state.get();
      if (!s.obs?.connected)      connections.obs.connect();
      if (!s.x32?.connected)      { connections.x32.connect(); connections.x32.startMeterUpdates(); }
      if (!s.proclaim?.connected) connections.proclaim.connect();
    }

    socket.on('close', () => {
      if (!connections) return;
      // Stop connections when the last client disconnects.
      // The closing socket's readyState is CLOSED (3) at this point, so count
      // OPEN sockets to find how many clients remain.
      if (openClientCount() > 0) return;
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        connections.x32.stopMeterUpdates();
        connections.obs.disconnect();
        connections.x32.disconnect();
        connections.proclaim.disconnect();
      }, 5000);
    });
  });

  // Broadcast state changes to all connected browsers
  state.on('change', ({ section, state: fullState }: { section: string; state: unknown }) => {
    const msg = JSON.stringify({ type: 'state', data: fullState });
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try {
          client.send(msg);
        } catch {
          // Client disconnected between readyState check and send
        }
      }
    }
  });
}

export = { setupWebSocket };
