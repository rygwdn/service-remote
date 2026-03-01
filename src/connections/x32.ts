import nodeOsc = require('node-osc');
import config = require('../config');
import state = require('../state');
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
  patch: Partial<Channel>;
}

// Track configured channels with their state
const channels: Channel[] = config.x32.channels.map((ch) => ({
  index: ch.index,
  label: ch.label,
  fader: 0,
  muted: false,
}));

function connect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (keepAliveInterval) clearInterval(keepAliveInterval);
  if (subscribeInterval) clearInterval(subscribeInterval);

  if (server) server.close();
  if (client) client.close();

  server = new Server(0, '0.0.0.0');
  server.on('message', (msg: unknown[]) => handleMessage(msg));

  client = new Client(config.x32.address, config.x32.port);

  // X32 requires /xremote every <10s to stay connected
  sendOsc('/xremote');
  keepAliveInterval = setInterval(() => sendOsc('/xremote'), 8000);
  // Subscriptions expire after ~10s; renew periodically
  subscribeInterval = setInterval(subscribeToChanges, 8000);

  // Request initial state for each configured channel
  for (const ch of channels) {
    const prefix = channelPrefix(ch.index);
    sendOsc(`${prefix}/mix/fader`);
    sendOsc(`${prefix}/mix/on`);
    sendOsc(`${prefix}/config/name`);
  }

  // If we get responses, we're connected
  setTimeout(() => {
    if (!connected) {
      console.log('[X32] No response, will retry...');
      state.update('x32', { connected: false, channels });
      scheduleReconnect();
    }
  }, 3000);
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5000);
}

function channelPrefix(index: number): string {
  const padded = String(index).padStart(2, '0');
  return `/ch/${padded}`;
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
// Returns { index, patch } or null if the message isn't a recognised channel message.
function parseOscMessage(address: string, args: OscArg[]): OscResult | null {
  const faderMatch = address.match(/^\/ch\/(\d+)\/mix\/fader$/);
  if (faderMatch) {
    return { index: parseInt(faderMatch[1], 10), patch: { fader: (args?.[0]?.value as number) ?? 0 } };
  }

  const muteMatch = address.match(/^\/ch\/(\d+)\/mix\/on$/);
  if (muteMatch) {
    return { index: parseInt(muteMatch[1], 10), patch: { muted: ((args?.[0]?.value as number) ?? 1) === 0 } };
  }

  const nameMatch = address.match(/^\/ch\/(\d+)\/config\/name$/);
  if (nameMatch) {
    const name = args?.[0]?.value as string | undefined;
    if (!name) return null;
    return { index: parseInt(nameMatch[1], 10), patch: { label: name } };
  }

  return null;
}

function handleMessage(msg: unknown[]): void {
  // node-osc delivers messages as [address, arg1, arg2, ...]
  const [address, ...rawArgs] = msg as [string, ...unknown[]];
  const args = rawArgs.map((v) => ({ value: v }));

  if (!connected) {
    connected = true;
    console.log('[X32] Connected');
  }

  const result = parseOscMessage(address, args);
  if (result) {
    updateChannel(result.index, result.patch);
  }
}

function updateChannel(index: number, patch: Partial<Channel>): void {
  const ch = channels.find((c) => c.index === index);
  if (!ch) return;
  Object.assign(ch, patch);
  state.update('x32', { connected: true, channels: [...channels] });
}

function subscribeToChanges(): void {
  for (const ch of channels) {
    const prefix = channelPrefix(ch.index);
    // X32 /subscribe format: address, param type, fader range, update interval (ms)
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

export = {
  parseOscMessage,
  connect,

  setFader(channelIndex: number, value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    sendOsc(`${channelPrefix(channelIndex)}/mix/fader`, [
      { value: clamped },
    ]);
    updateChannel(channelIndex, { fader: clamped });
  },

  toggleMute(channelIndex: number): void {
    const ch = channels.find((c) => c.index === channelIndex);
    if (!ch) return;
    const newState = ch.muted ? 1 : 0; // 1 = on (unmuted), 0 = off (muted)
    sendOsc(`${channelPrefix(channelIndex)}/mix/on`, [
      { value: newState },
    ]);
    updateChannel(channelIndex, { muted: !ch.muted });
  },
};
