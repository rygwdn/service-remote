import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import type { Connections, AppState, ChangeEvent } from './types';

function stripLevels(state: AppState): AppState {
  return {
    ...state,
    obs: {
      ...state.obs,
      audioSources: state.obs.audioSources.map(({ level: _, ...s }) => s as typeof s & { level: never }),
    },
    x32: {
      ...state.x32,
      channels: state.x32.channels.map(({ level: _, ...ch }) => ch as typeof ch & { level: never }),
    },
  };
}

interface StateHandle {
  get(): AppState;
  on(event: 'change', listener: (ev: ChangeEvent) => void): void;
}

function setupWebSocket(server: http.Server, state: StateHandle, connections?: Connections, { disconnectDelay = 5000 }: { disconnectDelay?: number } = {}): void {
  const wss = new WebSocketServer({ noServer: true });

  // Only handle upgrade requests that are NOT for dedicated sub-paths.
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws/screenshot') return; // handled by screenshot-ws.ts
    if (req.url === '/ws/levels') return;     // handled by levels-ws.ts
    wss.handleUpgrade(req, socket as import('stream').Duplex, head, (client) => {
      wss.emit('connection', client, req);
    });
  });
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionsStarted = false;

  function openClientCount(): number {
    let count = 0;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) count++;
    }
    return count;
  }

  wss.on('connection', (socket) => {
    // Cancel any pending disconnect
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }

    // Send full state on connect
    socket.send(JSON.stringify({ type: 'state', data: stripLevels(state.get()) }));

    // Start connections when the first client connects
    if (connections && !connectionsStarted) {
      connectionsStarted = true;
      connections.obs.connect();
      connections.x32.connect();
      connections.x32.startMeterUpdates();
      connections.proclaim.connect();
      connections.ptz.connect();
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
        connections.ptz.disconnect();
      }, disconnectDelay);
    });
  });

  // Broadcast state changes to all connected browsers, throttled to 10x/sec
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  let latestState: unknown = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function flushState(): void {
    pendingFlush = null;
    if (latestState === null) return;
    const msg = JSON.stringify({ type: 'state', data: stripLevels(latestState as AppState) });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(msg);
        } catch {
          // Client disconnected between readyState check and send
        }
      }
    }
  }

  // Send state to all clients every 10s even if nothing changed (keepalive)
  heartbeatTimer = setInterval(() => {
    latestState = state.get();
    flushState();
  }, 10000);

  state.on('change', ({ state: fullState }: ChangeEvent) => {
    latestState = fullState;
    if (!pendingFlush) {
      pendingFlush = setTimeout(flushState, 100);
    }
  });

  wss.on('close', () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  });
}

export { setupWebSocket };
