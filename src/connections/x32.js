const dgram = require('dgram');
const osc = require('osc-min');
const config = require('../config');
const state = require('../state');

const client = dgram.createSocket('udp4');
let connected = false;
let keepAliveInterval = null;
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

  client.removeAllListeners('message');
  client.on('message', handleMessage);

  // X32 requires /xremote every <10s to stay connected
  sendOsc('/xremote');
  keepAliveInterval = setInterval(() => sendOsc('/xremote'), 8000);

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
  const msg = args
    ? osc.toBuffer({ address, args })
    : osc.toBuffer({ address, args: [] });
  client.send(msg, 0, msg.length, config.x32.port, config.x32.address);
}

function handleMessage(buf) {
  let msg;
  try {
    msg = osc.fromBuffer(buf);
  } catch {
    return;
  }

  if (!connected) {
    connected = true;
    console.log('[X32] Connected');
  }

  // Match /ch/XX/mix/fader
  const faderMatch = msg.address.match(/^\/ch\/(\d+)\/mix\/fader$/);
  if (faderMatch) {
    const index = parseInt(faderMatch[1]);
    const value = msg.args?.[0]?.value ?? 0;
    updateChannel(index, { fader: value });
    return;
  }

  // Match /ch/XX/mix/on (mute state: 0 = muted, 1 = on)
  const muteMatch = msg.address.match(/^\/ch\/(\d+)\/mix\/on$/);
  if (muteMatch) {
    const index = parseInt(muteMatch[1]);
    const on = msg.args?.[0]?.value ?? 1;
    updateChannel(index, { muted: on === 0 });
    return;
  }

  // Match /ch/XX/config/name
  const nameMatch = msg.address.match(/^\/ch\/(\d+)\/config\/name$/);
  if (nameMatch) {
    const index = parseInt(nameMatch[1]);
    const name = msg.args?.[0]?.value;
    if (name) {
      updateChannel(index, { label: name });
    }
    return;
  }
}

function updateChannel(index, patch) {
  const ch = channels.find((c) => c.index === index);
  if (!ch) return;
  Object.assign(ch, patch);
  state.update('x32', { connected: true, channels: [...channels] });
}

// Subscribe to channel changes so we get live updates
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

// Re-subscribe periodically (subscriptions expire after ~10s)
setInterval(subscribeToChanges, 8000);

module.exports = {
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
