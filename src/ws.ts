import type { AppState, ChangeEvent, Connections, Channel, X32Connection } from './types';
import * as levelsWs from './levels-ws';
import * as screenshotWs from './screenshot-ws';

// ── Types ────────────────────────────────────────────────────────────────────

interface StateHandle {
  get(): AppState;
  on(event: 'change', listener: (ev: ChangeEvent) => void): void;
}

// Per-socket data stored in ws.data by Bun
interface SocketData {
  // Which channels this socket is subscribed to.
  // Topics: 'state' | 'levels' | 'screenshot' | `bus:${number}`
  topics: Set<string>;
}

// Shape of messages the client sends
interface SubscribeMsg {
  type: 'subscribe' | 'unsubscribe';
  channels: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function buildBusState(busIndex: number, appState: AppState): { type: string; busIndex: number; busChannel: Channel | null; channels: Channel[] } {
  const allChannels = appState.x32.channels;
  const busChannel = allChannels.find((c) => c.type === 'bus' && c.index === busIndex) ?? null;
  const channels = allChannels.filter(
    (c) => c.type === 'ch' && c.busSends?.some((s) => s.busIndex === busIndex && s.on),
  );
  return { type: 'bus-state', busIndex, busChannel, channels };
}

// ── Setup ────────────────────────────────────────────────────────────────────

interface SetupResult {
  websocket: {
    open(ws: import('bun').ServerWebSocket<SocketData>): void;
    message(ws: import('bun').ServerWebSocket<SocketData>, msg: string | Buffer): void;
    close(ws: import('bun').ServerWebSocket<SocketData>): void;
  };
  upgrade(req: Request, server: import('bun').Server<SocketData>): boolean;
  hasClients(): boolean;
}

function setupWebSocket(
  state: StateHandle,
  connections?: Connections,
  {
    disconnectDelay = 5000,
    canStopX32 = (): boolean => true,
  }: { disconnectDelay?: number; canStopX32?: () => boolean } = {},
): SetupResult {
  let connectionsStarted = false;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Track all open sockets so we can count them and enumerate them for bus sends.
  const openSockets = new Set<import('bun').ServerWebSocket<SocketData>>();

  // Per-bus ref counts: busIndex → number of open clients subscribed to that bus.
  const busSendRefCounts = new Map<number, number>();

  // Reference to the Bun Server, captured on first upgrade call.
  let server: import('bun').Server<SocketData> | null = null;

  function openClientCount(): number {
    return openSockets.size;
  }

  function startBusTracking(x32: X32Connection, busIndex: number): void {
    const current = busSendRefCounts.get(busIndex) ?? 0;
    busSendRefCounts.set(busIndex, current + 1);
    if (current === 0 && x32) x32.startBusSendTracking(busIndex);
  }

  function stopBusTracking(x32: X32Connection, busIndex: number): void {
    const current = busSendRefCounts.get(busIndex) ?? 0;
    if (current <= 1) {
      busSendRefCounts.delete(busIndex);
      x32.stopBusSendTracking(busIndex);
    } else {
      busSendRefCounts.set(busIndex, current - 1);
    }
  }

  function startConnections(): void {
    if (!connections || connectionsStarted) return;
    connectionsStarted = true;
    connections.obs.connect();
    connections.x32.connect();
    connections.x32.startMeterUpdates();
    connections.proclaim.connect();
    connections.ptz.connect();
  }

  function stopConnections(): void {
    if (!connections) return;
    connectionsStarted = false;
    connections.obs.disconnect();
    connections.proclaim.disconnect();
    connections.ptz.disconnect();
    if (canStopX32()) {
      connections.x32.stopMeterUpdates();
      connections.x32.disconnect();
    }
  }

  // ── State broadcast ───────────────────────────────────────────────────────

  let pendingFlush: ReturnType<typeof setTimeout> | null = null;
  let latestState: AppState | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function flushState(): void {
    pendingFlush = null;
    if (!latestState || !server) return;

    // Publish full state to 'state' topic
    const stateMsg = JSON.stringify({ type: 'state', data: stripLevels(latestState) });
    server.publish('state', stateMsg);

    // Publish bus state to each active bus topic
    for (const busIndex of busSendRefCounts.keys()) {
      const busMsg = JSON.stringify(buildBusState(busIndex, latestState));
      server.publish(`bus:${busIndex}`, busMsg);
    }
  }

  state.on('change', ({ state: fullState }: ChangeEvent) => {
    latestState = fullState;
    if (!pendingFlush) {
      pendingFlush = setTimeout(flushState, 100);
    }
  });

  // ── Levels & screenshot publishers ───────────────────────────────────────

  const LEVELS_BACKPRESSURE = 64 * 1024;
  const SCREENSHOT_BACKPRESSURE = 256 * 1024;

  levelsWs.setPublisher((levels) => {
    if (!server) return;
    const msg = JSON.stringify({ type: 'levels', ...levels });
    // Publish to 'levels' topic; Bun doesn't expose per-socket bufferedAmount via
    // publish, so we iterate open sockets subscribed to levels for backpressure.
    for (const ws of openSockets) {
      if (ws.data.topics.has('levels') && ws.getBufferedAmount() <= LEVELS_BACKPRESSURE) {
        try { ws.sendText(msg); } catch { /* disconnected */ }
      }
    }
  });

  screenshotWs.setPublisher((frame) => {
    if (!server) return;
    for (const ws of openSockets) {
      if (ws.data.topics.has('screenshot') && ws.getBufferedAmount() <= SCREENSHOT_BACKPRESSURE) {
        try { ws.sendBinary(frame); } catch { /* disconnected */ }
      }
    }
  });

  // ── WebSocket handler ─────────────────────────────────────────────────────

  const websocket = {
    open(ws: import('bun').ServerWebSocket<SocketData>): void {
      openSockets.add(ws);

      // Cancel any pending disconnect
      if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }

      // Start device connections on first client
      startConnections();

      // Subscribe to 'state' by default; client can add more via subscribe messages
      ws.subscribe('state');
      ws.data.topics.add('state');

      // Send full current state immediately
      const currentState = state.get();
      latestState = currentState;
      ws.sendText(JSON.stringify({ type: 'state', data: stripLevels(currentState) }));

      // Start heartbeat on first client
      if (openSockets.size === 1 && !heartbeatTimer) {
        heartbeatTimer = setInterval(() => {
          latestState = state.get();
          flushState();
        }, 10000);
      }
    },

    message(ws: import('bun').ServerWebSocket<SocketData>, msg: string | Buffer): void {
      if (typeof msg !== 'string') return;
      let parsed: SubscribeMsg;
      try { parsed = JSON.parse(msg) as SubscribeMsg; } catch { return; }
      if (!parsed || !Array.isArray(parsed.channels)) return;

      if (parsed.type === 'subscribe') {
        for (const channel of parsed.channels) {
          if (ws.data.topics.has(channel)) continue;
          ws.data.topics.add(channel);
          ws.subscribe(channel);

          // Bus subscription: start tracking and send initial bus state
          const busMatch = channel.match(/^bus:(\d+)$/);
          if (busMatch && connections?.x32) {
            const busIndex = parseInt(busMatch[1], 10);
            startBusTracking(connections.x32, busIndex);
            ws.sendText(JSON.stringify(buildBusState(busIndex, state.get())));

            // Start x32 if it was idle (bus-mix page opened standalone)
            if (!connectionsStarted && !connections.x32.isActive()) {
              startConnections();
            }
          }
        }
      } else if (parsed.type === 'unsubscribe') {
        for (const channel of parsed.channels) {
          if (!ws.data.topics.has(channel)) continue;
          ws.data.topics.delete(channel);
          ws.unsubscribe(channel);

          const busMatch = channel.match(/^bus:(\d+)$/);
          if (busMatch && connections?.x32) {
            stopBusTracking(connections.x32, parseInt(busMatch[1], 10));
          }
        }
      }
    },

    close(ws: import('bun').ServerWebSocket<SocketData>): void {
      openSockets.delete(ws);

      // Clean up bus subscriptions for this socket
      if (connections?.x32) {
        for (const topic of ws.data.topics) {
          const busMatch = topic.match(/^bus:(\d+)$/);
          if (busMatch) stopBusTracking(connections.x32, parseInt(busMatch[1], 10));
        }
      }

      if (openClientCount() > 0) return;

      // Stop heartbeat
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        stopConnections();
      }, disconnectDelay);
    },
  };

  function upgrade(req: Request, srv: import('bun').Server<SocketData>): boolean {
    // Capture server reference on first upgrade
    if (!server) server = srv;

    const url = new URL(req.url);
    if (!url.pathname.startsWith('/ws')) return false;

    // Parse bus index from /ws?bus=N or pass it through for the client to send via subscribe msg
    const upgraded = srv.upgrade(req, { data: { topics: new Set<string>() } });
    return upgraded;
  }

  function hasClients(): boolean {
    return openSockets.size > 0;
  }

  return { websocket, upgrade, hasClients };
}

export { setupWebSocket };
export type { SocketData };
