const { Client, Server } = require('node-osc');
const config = require('../config');
const state = require('../state');

let client = null;
let server = null;
let connected = false;
let keepAliveInterval = null;
let subscribeInterval = null;
let reconnectTimer = null;

// Track configured channels with their state
const channels = config.x32.channels.map((ch) => ({
  index: ch.index,
  label: ch.label,
  fader: 0,
  muted: false,
}));

function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(keepAliveInterval);
  clearInterval(subscribeInterval);

  if (server) server.close();
  if (client) client.close();

  server = new Server(0, '0.0.0.0');
  server.on('message', (msg) => handleMessage(msg));

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

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5000);
}

function channelPrefix(index) {
  const padded = String(index).padStart(2, '0');
  return `/ch/${padded}`;
}

function sendOsc(address, args) {
  if (args && args.length > 0) {
    client.send(address, ...args.map((a) => a.value), () => {});
  } else {
    client.send(address, () => {});
  }
}

// Pure function: parse an OSC address + args into a channel state patch.
// Returns { index, patch } or null if the message isn't a recognised channel message.
function parseOscMessage(address, args) {
  const faderMatch = address.match(/^\/ch\/(\d+)\/mix\/fader$/);
  if (faderMatch) {
    return { index: parseInt(faderMatch[1], 10), patch: { fader: args?.[0]?.value ?? 0 } };
  }

  const muteMatch = address.match(/^\/ch\/(\d+)\/mix\/on$/);
  if (muteMatch) {
    return { index: parseInt(muteMatch[1], 10), patch: { muted: (args?.[0]?.value ?? 1) === 0 } };
  }

  const nameMatch = address.match(/^\/ch\/(\d+)\/config\/name$/);
  if (nameMatch) {
    const name = args?.[0]?.value;
    if (!name) return null;
    return { index: parseInt(nameMatch[1], 10), patch: { label: name } };
  }

  return null;
}

function handleMessage(msg) {
  // node-osc delivers messages as [address, arg1, arg2, ...]
  const [address, ...rawArgs] = msg;
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

function updateChannel(index, patch) {
  const ch = channels.find((c) => c.index === index);
  if (!ch) return;
  Object.assign(ch, patch);
  state.update('x32', { connected: true, channels: [...channels] });
}

function subscribeToChanges() {
  for (const ch of channels) {
    const prefix = channelPrefix(ch.index);
    // X32 /subscribe format: address, param type, fader range, update interval (ms)
    sendOsc('/subscribe', [
      { type: 'string', value: `${prefix}/mix/fader` },
      { type: 'integer', value: 20 },
    ]);
    sendOsc('/subscribe', [
      { type: 'string', value: `${prefix}/mix/on` },
      { type: 'integer', value: 20 },
    ]);
  }
}

module.exports = {
  parseOscMessage,
  connect,

  setFader(channelIndex, value) {
    const clamped = Math.max(0, Math.min(1, value));
    sendOsc(`${channelPrefix(channelIndex)}/mix/fader`, [
      { type: 'float', value: clamped },
    ]);
    updateChannel(channelIndex, { fader: clamped });
  },

  toggleMute(channelIndex) {
    const ch = channels.find((c) => c.index === channelIndex);
    if (!ch) return;
    const newState = ch.muted ? 1 : 0; // 1 = on (unmuted), 0 = off (muted)
    sendOsc(`${channelPrefix(channelIndex)}/mix/on`, [
      { type: 'integer', value: newState },
    ]);
    updateChannel(channelIndex, { muted: !ch.muted });
  },
};
