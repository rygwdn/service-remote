import ws = require('ws');
import http = require('http');
import type { Connections } from './types';

const { WebSocketServer } = ws;

function setupWebSocket(server: http.Server, state: ReturnType<typeof require>, connections?: Connections, { disconnectDelay = 5000 }: { disconnectDelay?: number } = {}): void {
  const wss = new WebSocketServer({ server });
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionsStarted = false;

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

    // Start connections when the first client connects
    if (connections && !connectionsStarted) {
      connectionsStarted = true;
      connections.obs.connect();
      connections.x32.connect();
      connections.x32.startMeterUpdates();
      connections.proclaim.connect();
    }

    socket.on('close', () => {
      if (!connections) return;
      // Stop connections when the last client disconnects.
      // The closing socket's readyState is CLOSED (3) at this point, so count
      // OPEN sockets to find how many clients remain.
      if (openClientCount() > 0) return;
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        connectionsStarted = false;
        connections.x32.stopMeterUpdates();
        connections.obs.disconnect();
        connections.x32.disconnect();
        connections.proclaim.disconnect();
      }, disconnectDelay);
    });
  });

  // Broadcast state changes to all connected browsers, throttled to 10x/sec
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  let latestState: unknown = null;

  function flushState(): void {
    pendingFlush = null;
    const msg = JSON.stringify({ type: 'state', data: latestState });
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try {
          client.send(msg);
        } catch {
          // Client disconnected between readyState check and send
        }
      }
    }
  }

  state.on('change', ({ state: fullState }: { section: string; state: unknown }) => {
    latestState = fullState;
    if (!pendingFlush) {
      pendingFlush = setTimeout(flushState, 100);
    }
  });
}

export = { setupWebSocket };
