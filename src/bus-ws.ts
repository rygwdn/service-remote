import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import type { AppState, Channel, X32Connection, ChangeEvent } from './types';

interface StateHandle {
  get(): AppState;
  on(event: 'change', listener: (ev: ChangeEvent) => void): void;
}

function buildBusState(busIndex: number, state: AppState): { type: string; busIndex: number; busChannel: Channel | null; channels: Channel[] } {
  const allChannels = state.x32.channels;
  const busChannel = allChannels.find((c) => c.type === 'bus' && c.index === busIndex) ?? null;
  const channels = allChannels.filter(
    (c) => c.type === 'ch' && c.busSends?.some((s) => s.busIndex === busIndex && s.on)
  );
  return { type: 'bus-state', busIndex, busChannel, channels };
}

function setupBusWs(server: http.Server, state: StateHandle, x32?: X32Connection, { disconnectDelay = 5000 }: { disconnectDelay?: number } = {}): void {
  // One WebSocketServer for all /ws/bus connections; busIndex is read per-client from the URL.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws/bus')) return;
    wss.handleUpgrade(req, socket as import('stream').Duplex, head, (client) => {
      wss.emit('connection', client, req);
    });
  });

  // Per-bus tracking: busIndex → set of open clients
  const busClients = new Map<number, Set<WebSocket>>();
  // Per-bus disconnect timers
  const disconnectTimers = new Map<number, ReturnType<typeof setTimeout>>();
  // Whether bus-ws started the x32 connection (so it can stop it on last client leaving)
  let busWsStartedX32 = false;

  function totalBusClients(): number {
    let n = 0;
    for (const s of busClients.values()) n += s.size;
    return n;
  }

  function addClient(busIndex: number, ws: WebSocket): void {
    const existing = disconnectTimers.get(busIndex);
    if (existing) { clearTimeout(existing); disconnectTimers.delete(busIndex); }

    if (!busClients.has(busIndex)) busClients.set(busIndex, new Set());
    busClients.get(busIndex)!.add(ws);

    if (busClients.get(busIndex)!.size === 1 && x32) {
      x32.startBusSendTracking(busIndex);
    }

    // Start X32 connection + meters if this is the very first bus client and x32 is idle
    if (totalBusClients() === 1 && x32 && !x32.isActive()) {
      busWsStartedX32 = true;
      x32.connect();
      x32.startMeterUpdates();
    }
  }

  function removeClient(busIndex: number, ws: WebSocket): void {
    const clients = busClients.get(busIndex);
    if (!clients) return;
    clients.delete(ws);
    if (clients.size === 0) {
      busClients.delete(busIndex);
      if (x32) {
        const timer = setTimeout(() => {
          disconnectTimers.delete(busIndex);
          x32.stopBusSendTracking(busIndex);
          // Stop x32 if bus-ws started it and no bus clients remain
          if (busWsStartedX32 && totalBusClients() === 0) {
            busWsStartedX32 = false;
            x32.stopMeterUpdates();
            x32.disconnect();
          }
        }, disconnectDelay);
        disconnectTimers.set(busIndex, timer);
      }
    }
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const busIndex = parseInt(url.searchParams.get('bus') ?? '0', 10);

    if (busIndex < 1 || busIndex > 16) {
      ws.close(1008, 'Invalid bus index');
      return;
    }

    addClient(busIndex, ws);

    // Send initial state
    ws.send(JSON.stringify(buildBusState(busIndex, state.get())));

    ws.on('close', () => {
      removeClient(busIndex, ws);
    });
  });

  // Broadcast state changes to relevant bus clients
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  let latestState: AppState | null = null;

  function flushState(): void {
    pendingFlush = null;
    if (!latestState) return;
    for (const [busIndex, clients] of busClients) {
      const msg = JSON.stringify(buildBusState(busIndex, latestState));
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          try { client.send(msg); } catch { /* client disconnected */ }
        }
      }
    }
  }

  // Heartbeat every 10s
  const heartbeatTimer = setInterval(() => {
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
    clearInterval(heartbeatTimer);
  });
}

export { setupBusWs };
