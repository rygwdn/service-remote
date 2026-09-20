import type { AppState, ChangeEvent, Connections, Channel, X32Connection } from './types';
import type { RequestSecurity } from './security';
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
  // Topics requested in the WebSocket URL's `topics` query parameter. When
  // absent, the legacy default is ['state'] for the main control panel.
  defaultTopics?: string[];
}

// Shape of messages the client sends
interface SubscribeMsg {
  type: 'subscribe' | 'unsubscribe';
  channels: unknown;
}

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_CHANNELS_PER_MESSAGE = 16;
const MAX_TOPICS_PER_SOCKET = 8;
const MAX_BUS_TOPICS_PER_SOCKET = 4;
const FIXED_TOPICS: Record<string, true> = { state: true, levels: true, screenshot: true };

function busIndexForTopic(topic: string): number | null {
  const match = topic.match(/^bus:(?:[1-9]|1[0-6])$/);
  return match ? Number(topic.slice(4)) : null;
}

function isAllowedTopic(topic: string): boolean {
  return FIXED_TOPICS[topic] === true || busIndexForTopic(topic) !== null;
}
// Parse and bound a topic selection before it is installed on a socket. This
// keeps URL defaults and their open-time subscriptions under the same
// allowlist and per-socket limits.
function normalizeTopics(values: readonly unknown[]): string[] {
  const topics: string[] = [];
  let busTopicCount = 0;
  for (const value of values.slice(0, MAX_CHANNELS_PER_MESSAGE)) {
    if (typeof value !== 'string' || !isAllowedTopic(value) || topics.includes(value)) continue;
    if (topics.length >= MAX_TOPICS_PER_SOCKET) break;
    const busIndex = busIndexForTopic(value);
    if (busIndex !== null && busTopicCount >= MAX_BUS_TOPICS_PER_SOCKET) continue;
    topics.push(value);
    if (busIndex !== null) busTopicCount++;
  }
  return topics;
}

function defaultTopicsForUrl(url: URL): string[] {
  const raw = url.searchParams.get('topics');
  // Preserve the original main-panel contract when no selection is given.
  if (raw === null) return ['state'];
  // An explicitly empty selection intentionally subscribes to no topics.
  return normalizeTopics(raw ? raw.split(',').map((topic) => topic.trim()) : []);
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

function buildBusState(busIndex: number, appState: AppState): { type: string; busIndex: number; connected: boolean; busChannel: Channel | null; channels: Channel[] } {
  const allChannels = appState.x32.channels;
  const busChannel = allChannels.find((c) => c.type === 'bus' && c.index === busIndex) ?? null;
  const channels = allChannels.filter(
    (c) => c.type === 'ch' && c.busSends?.some((s) => s.busIndex === busIndex && s.on),
  );
  return { type: 'bus-state', busIndex, connected: appState.x32.connected, busChannel, channels };
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
    security,
  }: { disconnectDelay?: number; canStopX32?: () => boolean; security?: RequestSecurity } = {},
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

  function hasTopicSubscribers(topic: string): boolean {
    for (const ws of openSockets) {
      if (ws.data.topics.has(topic)) return true;
    }
    return false;
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

    // Avoid serializing a full snapshot when no socket currently subscribes
    // to it. Bun's topic publication already filters recipients, but does not
    // avoid the caller's serialization work.
    if (hasTopicSubscribers('state')) {
      const stateMsg = JSON.stringify({ type: 'state', data: stripLevels(latestState) });
      server.publish('state', stateMsg);
    }

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

      const initialTopics = normalizeTopics(ws.data.defaultTopics ?? ['state']);
      ws.data.defaultTopics = initialTopics;
      for (const topic of initialTopics) {
        ws.subscribe(topic);
        ws.data.topics.add(topic);
        const busIndex = busIndexForTopic(topic);
        if (busIndex !== null && connections?.x32) {
          startBusTracking(connections.x32, busIndex);
        }
      }

      // Send current snapshots only for the topics selected for this socket.
      const currentState = state.get();
      latestState = currentState;
      if (ws.data.topics.has('state')) {
        ws.sendText(JSON.stringify({ type: 'state', data: stripLevels(currentState) }));
      }
      for (const topic of ws.data.topics) {
        const busIndex = busIndexForTopic(topic);
        if (busIndex !== null) ws.sendText(JSON.stringify(buildBusState(busIndex, currentState)));
      }

      // Start heartbeat on first client
      if (openSockets.size === 1 && !heartbeatTimer) {
        heartbeatTimer = setInterval(() => {
          latestState = state.get();
          flushState();
        }, 10000);
      }
    },

    message(ws: import('bun').ServerWebSocket<SocketData>, msg: string | Buffer): void {
      if (typeof msg !== 'string' || Buffer.byteLength(msg, 'utf8') > MAX_MESSAGE_BYTES) return;
      let parsed: SubscribeMsg;
      try { parsed = JSON.parse(msg) as SubscribeMsg; } catch { return; }
      if (!parsed || (parsed.type !== 'subscribe' && parsed.type !== 'unsubscribe') || !Array.isArray(parsed.channels)) return;
      const channels = parsed.channels
        .filter((channel): channel is string => typeof channel === 'string')
        .slice(0, MAX_CHANNELS_PER_MESSAGE);

      if (parsed.type === 'subscribe') {
        let busTopicCount = 0;
        for (const topic of ws.data.topics) if (busIndexForTopic(topic) !== null) busTopicCount++;
        for (const channel of channels) {
          if (!isAllowedTopic(channel) || ws.data.topics.has(channel)) continue;
          const busIndex = busIndexForTopic(channel);
          if (ws.data.topics.size >= MAX_TOPICS_PER_SOCKET) break;
          if (busIndex !== null && busTopicCount >= MAX_BUS_TOPICS_PER_SOCKET) continue;

          ws.data.topics.add(channel);
          ws.subscribe(channel);
          if (busIndex !== null) {
            busTopicCount++;
            if (connections?.x32) {
              startBusTracking(connections.x32, busIndex);
              ws.sendText(JSON.stringify(buildBusState(busIndex, state.get())));

              // Start x32 if it was idle (bus-mix page opened standalone)
              if (!connectionsStarted && !connections.x32.isActive()) startConnections();
            }
          }
        }
      } else {
        for (const channel of channels) {
          if (!isAllowedTopic(channel) || !ws.data.topics.has(channel)) continue;
          ws.data.topics.delete(channel);
          ws.unsubscribe(channel);

          const busIndex = busIndexForTopic(channel);
          if (busIndex !== null && connections?.x32) stopBusTracking(connections.x32, busIndex);
        }
      }
    },

    close(ws: import('bun').ServerWebSocket<SocketData>): void {
      openSockets.delete(ws);

      // Clean up bus subscriptions for this socket
      if (connections?.x32) {
        for (const topic of ws.data.topics) {
          const busIndex = busIndexForTopic(topic);
          if (busIndex !== null) stopBusTracking(connections.x32, busIndex);
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
    const url = new URL(req.url);
    if (url.pathname !== '/ws') return false;
    if (security && (security.checkHost(req) || !security.authenticate(req))) return false;
    // Capture server reference only after the request has passed all gates.
    if (!server) server = srv;
    const upgraded = srv.upgrade(req, {
      data: {
        topics: new Set<string>(),
        defaultTopics: defaultTopicsForUrl(url),
      },
    });
    return upgraded;
  }

  function hasClients(): boolean {
    return openSockets.size > 0;
  }

  return { websocket, upgrade, hasClients };
}

export { setupWebSocket };
export type { SocketData };
