import nodeOsc = require('node-osc');
import config = require('../config');
import state = require('../state');
import logger = require('../logger');
import type { Channel } from '../types';

const { Client, Server } = nodeOsc;

let client: InstanceType<typeof Client> | null = null;
let server: InstanceType<typeof Server> | null = null;
let connected = false;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let subscribeInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

interface OscArg {
  value: unknown;
}

interface OscResult {
  index: number;
  type: 'ch' | 'bus';
  patch: Partial<Channel>;
}

// Dynamically discovered channels
let channels: Channel[] = [];

// Number of input channels and buses on the X32
const CH_COUNT = 32;
const BUS_COUNT = 16;

function connect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (subscribeInterval) clearInterval(subscribeInterval);

  if (server) server.close();
  if (client) client.close();

  // Start with empty channels — populated via auto-discovery
  channels = [];

  server = new Server(0, '0.0.0.0');
  server.on('message', (msg: unknown[]) => handleMessage(msg));

  client = new Client(config.x32.address, config.x32.port);

  // X32 requires /xremote every <10s to stay connected
  sendOsc('/xremote');
  keepAliveInterval = setInterval(() => sendOsc('/xremote'), 8000);
  // Subscriptions expire after ~10s; renew periodically
  subscribeInterval = setInterval(subscribeToChanges, 8000);

  // Request names for all input channels and buses — non-empty names indicate active channels
  for (let i = 1; i <= CH_COUNT; i++) {
    sendOsc(`${channelPrefix(i, 'ch')}/config/name`);
  }
  for (let i = 1; i <= BUS_COUNT; i++) {
    sendOsc(`${channelPrefix(i, 'bus')}/config/name`);
  }

  // If we get responses, we're connected
  setTimeout(() => {
    if (!connected) {
      logger.log('[X32] No response, will retry...');
      state.update('x32', { connected: false, channels });
      scheduleReconnect();
    }
  }, 3000);
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5000);
}

function channelPrefix(index: number, type: 'ch' | 'bus'): string {
  const padded = String(index).padStart(2, '0');
  return `/${type}/${padded}`;
}

function sendOsc(address: string, args?: OscArg[]): void {
  if (!client) return;
  if (args && args.length > 0) {
    client.send(address, ...args.map((a) => a.value as number | string), () => {});
  } else {
    client.send(address, () => {});
  }
}

// Pure function: parse an OSC address + args into a channel state patch.
// Returns { index, type, patch } or null if the message isn't a recognised channel message.
function parseOscMessage(address: string, args: OscArg[]): OscResult | null {
  // Input channels: /ch/XX/...
  const chFaderMatch = address.match(/^\/ch\/(\d+)\/mix\/fader$/);
  if (chFaderMatch) {
    return { index: parseInt(chFaderMatch[1], 10), type: 'ch', patch: { fader: (args?.[0]?.value as number) ?? 0 } };
  }

  const chMuteMatch = address.match(/^\/ch\/(\d+)\/mix\/on$/);
  if (chMuteMatch) {
    return { index: parseInt(chMuteMatch[1], 10), type: 'ch', patch: { muted: ((args?.[0]?.value as number) ?? 1) === 0 } };
  }

  const chNameMatch = address.match(/^\/ch\/(\d+)\/config\/name$/);
  if (chNameMatch) {
    const name = args?.[0]?.value as string | undefined;
    if (!name) return null;
    return { index: parseInt(chNameMatch[1], 10), type: 'ch', patch: { label: name } };
  }

  // Mix buses: /bus/XX/...
  const busFaderMatch = address.match(/^\/bus\/(\d+)\/mix\/fader$/);
  if (busFaderMatch) {
    return { index: parseInt(busFaderMatch[1], 10), type: 'bus', patch: { fader: (args?.[0]?.value as number) ?? 0 } };
  }

  const busMuteMatch = address.match(/^\/bus\/(\d+)\/mix\/on$/);
  if (busMuteMatch) {
    return { index: parseInt(busMuteMatch[1], 10), type: 'bus', patch: { muted: ((args?.[0]?.value as number) ?? 1) === 0 } };
  }

  const busNameMatch = address.match(/^\/bus\/(\d+)\/config\/name$/);
  if (busNameMatch) {
    const name = args?.[0]?.value as string | undefined;
    if (!name) return null;
    return { index: parseInt(busNameMatch[1], 10), type: 'bus', patch: { label: name } };
  }

  return null;
}

function handleMessage(msg: unknown[]): void {
  // node-osc delivers messages as [address, arg1, arg2, ...]
  const [address, ...rawArgs] = msg as [string, ...unknown[]];
  const args = rawArgs.map((v) => ({ value: v }));

  if (!connected) {
    connected = true;
    logger.log('[X32] Connected');
  }

  const result = parseOscMessage(address, args);
  if (result) {
    updateChannel(result.index, result.type, result.patch);
  }
}

function updateChannel(index: number, type: 'ch' | 'bus', patch: Partial<Channel>): void {
  let ch = channels.find((c) => c.index === index && c.type === type);
  if (!ch) {
    // Only create a new channel entry when a name is received (auto-discovery)
    if (!patch.label) return;
    ch = { index, type, label: patch.label, fader: 0, muted: false };
    channels.push(ch);
    channels.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'ch' ? -1 : 1;
      return a.index - b.index;
    });
    // Request initial fader/mute state for newly discovered channel
    const prefix = channelPrefix(index, type);
    sendOsc(`${prefix}/mix/fader`);
    sendOsc(`${prefix}/mix/on`);
  } else {
    Object.assign(ch, patch);
  }
  state.update('x32', { connected: true, channels: [...channels] });
}

function subscribeToChanges(): void {
  for (const ch of channels) {
    const prefix = channelPrefix(ch.index, ch.type);
    sendOsc('/subscribe', [
      { value: `${prefix}/mix/fader` },
      { value: 20 },
    ]);
    sendOsc('/subscribe', [
      { value: `${prefix}/mix/on` },
      { value: 20 },
    ]);
  }
}

function disconnect(): void {
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  if (subscribeInterval) { clearInterval(subscribeInterval); subscribeInterval = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (server) { server.close(); server = null; }
  if (client) { client.close(); client = null; }
  connected = false;
}

export = {
  parseOscMessage,
  connect,
  disconnect,

  setFader(channelIndex: number, value: number, type: 'ch' | 'bus' = 'ch'): void {
    const clamped = Math.max(0, Math.min(1, value));
    sendOsc(`${channelPrefix(channelIndex, type)}/mix/fader`, [
      { value: clamped },
    ]);
    updateChannel(channelIndex, type, { fader: clamped });
  },

  toggleMute(channelIndex: number, type: 'ch' | 'bus' = 'ch'): void {
    const ch = channels.find((c) => c.index === channelIndex && c.type === type);
    if (!ch) return;
    const newState = ch.muted ? 1 : 0; // 1 = on (unmuted), 0 = off (muted)
    sendOsc(`${channelPrefix(channelIndex, type)}/mix/on`, [
      { value: newState },
    ]);
    updateChannel(channelIndex, type, { muted: !ch.muted });
  },
};
