import dgram = require('dgram');
import nodeOsc = require('node-osc');
import config = require('../config');
import state = require('../state');
import logger = require('../logger');
import levelsWs = require('../levels-ws');
import type { Channel } from '../types';

const { Message: OscMessage, encode: oscEncode, decode: oscDecode } = nodeOsc;

// Single UDP socket used for both sending and receiving.
// The X32 replies to the source port of packets it receives, so we must use the
// same socket for send and recv — matching how the C reference tools work
// (single fd for both sendto() and recvfrom()). The separate Client+Server
// approach used different ports, so X32 replies were going to the wrong socket.
let sock: dgram.Socket | null = null;
let connected = false;
let wantConnected = false;
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let subscribeInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let meterInterval: ReturnType<typeof setInterval> | null = null;
let metersActive = false;
let loggedNoResponse = false;
let lastMeterSubscribeLogTime = 0;
let lastMeterReceiveLogTime = 0;

// Send queue: throttle outgoing messages to avoid flooding the mixer.
// The X32 can silently drop packets if commands arrive faster than it can process them.
const SEND_INTERVAL_MS = 20; // 20 ms between packets ≈ 50 msg/s max
let sendQueue: Buffer[] = [];
let sendTimer: ReturnType<typeof setInterval> | null = null;

interface OscArg {
  value: unknown;
}

interface OscResult {
  index: number;
  type: 'ch' | 'bus' | 'main' | 'mtx';
  patch: Partial<Channel>;
}

// Dynamically discovered channels
let channels: Channel[] = [];

// Pending fader map: key is `${type}-${index}`, value is { value, sentAt }
// When the client sends a fader command, we record it here so that stale OSC
// echoes from the X32 do not snap the slider back during or after a drag.
const pendingFaders = new Map<string, { value: number; sentAt: number }>();
const PENDING_FADER_TIMEOUT_MS = 2000;
const PENDING_FADER_TOLERANCE = 0.05;

// Number of input channels, buses, and matrices on the X32
const CH_COUNT = 32;
const BUS_COUNT = 16;
const MTX_COUNT = 6;

// main type: index 1 = stereo L/R, index 2 = mono/center
const MAIN_LABELS: Record<number, string> = { 1: 'Main L/R', 2: 'Main M/C' };

function connect(): void {
  logger.log('[X32] Attempting to connect to', config.x32.address, 'port', config.x32.port);
  wantConnected = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  if (subscribeInterval) { clearInterval(subscribeInterval); subscribeInterval = null; }
  if (meterInterval) { clearInterval(meterInterval); meterInterval = null; }
  if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
  sendQueue = [];

  if (sock) {
    logger.log('[X32] Closing existing socket');
    try { sock.close(); } catch (_) { /* ignore if already closed */ }
    sock = null;
  }

  connected = false;
  // Pre-populate all channels in sorted order with default labels
  channels = [];
  for (let i = 1; i <= CH_COUNT; i++) {
    channels.push({ index: i, type: 'ch', label: `CH ${String(i).padStart(2, '0')}`, fader: 0, muted: false, level: 0, source: 0, linkedToNext: false });
  }
  for (let i = 1; i <= BUS_COUNT; i++) {
    channels.push({ index: i, type: 'bus', label: `Bus ${String(i).padStart(2, '0')}`, fader: 0, muted: false, level: 0, source: 0, linkedToNext: false });
  }
  for (let i = 1; i <= MTX_COUNT; i++) {
    channels.push({ index: i, type: 'mtx', label: `Mtx ${String(i).padStart(2, '0')}`, fader: 0, muted: false, level: 0, source: 0, linkedToNext: false });
  }
  for (const [idx, lbl] of Object.entries(MAIN_LABELS)) {
    channels.push({ index: Number(idx), type: 'main', label: lbl, fader: 0, muted: false, level: 0, source: 1, linkedToNext: false });
  }

  // Bind to 0.0.0.0 so the OS accepts inbound packets on any local network
  // interface (LAN, loopback, etc.) and picks an ephemeral source port.
  // The X32 will reply to that same ephemeral port because it echoes back
  // to the source address/port of each UDP packet it receives.
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    logger.warn('[X32] Socket error:', err.message);
  });

  sock.on('message', (raw: Buffer) => {
    let address: string;
    let args: OscArg[];
    try {
      const decoded = oscDecode(raw) as { address: string; args: { value: unknown }[] };
      address = decoded.address;
      args = decoded.args;
    } catch (e) {
      logger.warn('[X32] Failed to decode OSC packet:', (e as Error).message);
      return;
    }
    handleMessage(address, args);
    // Immediately send the next queued request on any incoming reply to
    // pipeline discovery messages rather than waiting for the timer tick.
    flushSendQueue();
  });

  sock.bind(0, '0.0.0.0', () => {
    const port = sock!.address().port;
    logger.log(`[X32] Socket bound on ephemeral port ${port}`);

    // Start the throttled send queue pump
    sendTimer = setInterval(flushSendQueue, SEND_INTERVAL_MS);

    // Validate connection like the C tools: send /info and wait for a /info reply.
    // Bypass the queue so this goes immediately.
    logger.log('[X32] Sending /info to validate connection');
    sendImmediate('/info');

    setTimeout(() => {
      if (wantConnected && !connected) {
        if (!loggedNoResponse) {
          logger.log('[X32] No /info reply after 3s, will retry...');
          loggedNoResponse = true;
        }
        state.update('x32', { connected: false, channels });
        scheduleReconnect();
      }
    }, 3000);
  });
}

function scheduleReconnect(): void {
  if (!wantConnected) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  logger.log('[X32] Scheduling reconnect in 5s');
  reconnectTimer = setTimeout(connect, 5000);
}

function channelPrefix(index: number, type: 'ch' | 'bus' | 'main' | 'mtx'): string {
  if (type === 'main') {
    return index === 2 ? '/main/m' : '/main/st';
  }
  const padded = String(index).padStart(2, '0');
  return `/${type}/${padded}`;
}

function buildOscBuffer(address: string, args?: OscArg[]): Buffer {
  const msg = new OscMessage(address);
  if (args) {
    for (const a of args) {
      msg.append(a.value as number | string);
    }
  }
  return oscEncode(msg) as Buffer;
}

// Send immediately, bypassing the queue — used for connection handshake only.
function sendImmediate(address: string, args?: OscArg[]): void {
  if (!sock) return;
  const buf = buildOscBuffer(address, args);
  sock.send(buf, 0, buf.length, config.x32.port, config.x32.address, (err) => {
    if (err) logger.warn('[X32] Send error:', err.message);
  });
}

function flushSendQueue(): void {
  if (!sock || sendQueue.length === 0) return;
  const buf = sendQueue.shift()!;
  sock.send(buf, 0, buf.length, config.x32.port, config.x32.address, (err) => {
    if (err) logger.warn('[X32] Send error:', err.message);
  });
}

function sendOsc(address: string, args?: OscArg[]): void {
  if (!sock) {
    logger.warn('[X32] sendOsc called but no socket:', address);
    return;
  }
  sendQueue.push(buildOscBuffer(address, args));
}

// Parse a meter blob into an array of float32 values.
// The blob is delivered by node-osc's oscDecode which already strips the OSC
// blob length prefix. What remains is a packed array of little-endian float32
// values (linear peak level 0.0–1.0, 1.0 = 0 dBFS) with no leading count field.
// The count is derived from the buffer length: count = floor(blob.length / 4).
function parseMeterBlob(blob: Buffer): number[] {
  const count = Math.floor(blob.length / 4);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const offset = i * 4;
    values.push(Math.round(blob.readFloatLE(offset) * 1000) / 1000);
  }
  return values;
}

// Returns the list of OSC meter subscription requests for input channels, mix buses, and main/matrix.
// The X32 expects /meters/N with a single int arg (duration in 100ms ticks).
// It responds with /meters/0, /meters/2, /meters/3 blobs every 100 ms for the given duration.
// We renew every 1.5 s to keep the stream active (duration = 20 × 100 ms = 2 s).
function buildMeterRequests(): Array<{ address: string; args: OscArg[] }> {
  return [
    // Bank 0: input channel pre-fader levels (positions 0–31 = ch 1–32)
    { address: '/meters/0', args: [{ value: 20 }] },
    // Bank 2: mix bus output levels (positions 0–15 = bus 1–16)
    { address: '/meters/2', args: [{ value: 20 }] },
    // Bank 3: main/matrix output levels (pos 0=main L, 1=main R, 2=main M/C, 3–8 = mtx 1–6)
    { address: '/meters/3', args: [{ value: 20 }] },
  ];
}

function requestMeterUpdates(): void {
  const now = Date.now();
  if (now - lastMeterSubscribeLogTime > 30000) {
    logger.log('[X32] Subscribing to meter banks 0 (ch), 2 (bus), 3 (main/mtx)');
    lastMeterSubscribeLogTime = now;
  }
  for (const { address, args } of buildMeterRequests()) {
    sendOsc(address, args);
  }
}

function handleMeterMessage(address: string, args: OscArg[]): void {
  const blob = args[0]?.value;
  if (!Buffer.isBuffer(blob)) return;
  const values = parseMeterBlob(blob);
  const now = Date.now();
  if (now - lastMeterReceiveLogTime > 30000) {
    logger.log(`[X32] Meter data: ${address} blob=${blob.length}B values[0..3]=${values.slice(0, 4).join(', ')}`);
    lastMeterReceiveLogTime = now;
  }
  let updated = false;
  for (const ch of channels) {
    let level: number | undefined;
    if (address === '/meters/0' && ch.type === 'ch') {
      level = values[ch.index - 1]; // ch.index is 1-based; bank 0 pos 0 = ch 1
    } else if (address === '/meters/2' && ch.type === 'bus') {
      level = values[ch.index - 1]; // bank 2 pos 0 = bus 1
    } else if (address === '/meters/3') {
      // bank 3: pos 0–1 = main L/R (index 1), pos 2 = main M/C (index 2), pos 3–8 = mtx 1–6
      if (ch.type === 'main') {
        // Use the higher of L and R for the stereo main (index 1)
        if (ch.index === 1) level = Math.max(values[0] ?? 0, values[1] ?? 0);
        else if (ch.index === 2) level = values[2];
      } else if (ch.type === 'mtx') {
        level = values[2 + ch.index]; // pos 3 = mtx 1, pos 4 = mtx 2, ...
      }
    }
    if (level !== undefined && isFinite(level)) {
      ch.level = level;
      updated = true;
    }
  }
  if (updated) {
    // Broadcast level-only updates directly to /ws/levels — do NOT call state.update
    // so the main WebSocket doesn't re-render all Alpine x-for elements on every meter tick.
    const x32Levels: Record<string, number> = {};
    for (const ch of channels) {
      x32Levels[`${ch.type}-${ch.index}`] = ch.level;
    }
    levelsWs.broadcast({ x32: x32Levels, obs: {} });
  }
}

type OscPatchFn = (args: OscArg[]) => Partial<Channel> | null;

interface OscPattern {
  re: RegExp;
  type: OscResult['type'];
  indexGroup: number | null; // regex capture group for channel index, or null for fixed index
  fixedIndex?: number;
  patch: OscPatchFn;
}

function faderPatch(args: OscArg[]): Partial<Channel> {
  return { fader: (args?.[0]?.value as number) ?? 0 };
}

function mutePatch(args: OscArg[]): Partial<Channel> {
  return { muted: ((args?.[0]?.value as number) ?? 1) === 0 };
}

function namePatch(args: OscArg[]): Partial<Channel> | null {
  const name = args?.[0]?.value as string | undefined;
  return name ? { label: name } : null;
}

function sourcePatch(args: OscArg[]): Partial<Channel> {
  return { source: (args?.[0]?.value as number) ?? 0 };
}

const OSC_PATTERNS: OscPattern[] = [
  // Input channels
  { re: /^\/ch\/(\d+)\/mix\/fader$/,    type: 'ch',   indexGroup: 1, patch: faderPatch },
  { re: /^\/ch\/(\d+)\/mix\/on$/,       type: 'ch',   indexGroup: 1, patch: mutePatch },
  { re: /^\/ch\/(\d+)\/config\/name$/,  type: 'ch',   indexGroup: 1, patch: namePatch },
  { re: /^\/ch\/(\d+)\/config\/source$/,type: 'ch',   indexGroup: 1, patch: sourcePatch },
  // Mix buses
  { re: /^\/bus\/(\d+)\/mix\/fader$/,   type: 'bus',  indexGroup: 1, patch: faderPatch },
  { re: /^\/bus\/(\d+)\/mix\/on$/,      type: 'bus',  indexGroup: 1, patch: mutePatch },
  { re: /^\/bus\/(\d+)\/config\/name$/, type: 'bus',  indexGroup: 1, patch: namePatch },
  // Matrix
  { re: /^\/mtx\/(\d+)\/mix\/fader$/,   type: 'mtx',  indexGroup: 1, patch: faderPatch },
  { re: /^\/mtx\/(\d+)\/mix\/on$/,      type: 'mtx',  indexGroup: 1, patch: mutePatch },
  { re: /^\/mtx\/(\d+)\/config\/name$/, type: 'mtx',  indexGroup: 1, patch: namePatch },
  // Main L/R (index 1) and Main M/C (index 2)
  { re: /^\/main\/st\/mix\/fader$/,     type: 'main', indexGroup: null, fixedIndex: 1, patch: faderPatch },
  { re: /^\/main\/st\/mix\/on$/,        type: 'main', indexGroup: null, fixedIndex: 1, patch: mutePatch },
  { re: /^\/main\/m\/mix\/fader$/,      type: 'main', indexGroup: null, fixedIndex: 2, patch: faderPatch },
  { re: /^\/main\/m\/mix\/on$/,         type: 'main', indexGroup: null, fixedIndex: 2, patch: mutePatch },
];

// Pure function: parse an OSC address + args into a channel state patch.
// Returns { index, type, patch } or null if the message isn't a recognised channel message.
function parseOscMessage(address: string, args: OscArg[]): OscResult | null {
  for (const pattern of OSC_PATTERNS) {
    const m = address.match(pattern.re);
    if (!m) continue;
    const index = pattern.indexGroup !== null ? parseInt(m[pattern.indexGroup], 10) : pattern.fixedIndex!;
    const patch = pattern.patch(args);
    if (!patch) return null;
    return { index, type: pattern.type, patch };
  }
  return null;
}

function handleMessage(address: string, args: OscArg[]): void {
  // Connection validation: /info reply means the X32 is reachable
  if (address === '/info' && !connected) {
    connected = true;
    loggedNoResponse = false;
    logger.log('[X32] /info reply — connection confirmed, starting discovery');

    // X32 requires /xremote every <10s to stay subscribed to updates
    sendOsc('/xremote');
    keepAliveInterval = setInterval(() => {
      logger.debug('[X32] keepalive /xremote');
      sendOsc('/xremote');
    }, 8000);
    // Subscriptions expire after ~10s; renew periodically
    subscribeInterval = setInterval(subscribeToChanges, 8000);

    // Request names, sources, and link state for all channels.
    // Throttled via the send queue to avoid flooding the mixer.
    logger.log(`[X32] Requesting names/sources/links for ${CH_COUNT} ch, ${BUS_COUNT} bus, ${MTX_COUNT} mtx, and main`);
    for (let i = 1; i <= CH_COUNT; i++) {
      sendOsc(`${channelPrefix(i, 'ch')}/config/name`);
      sendOsc(`${channelPrefix(i, 'ch')}/config/source`);
    }
    for (let i = 1; i <= BUS_COUNT; i++) {
      sendOsc(`${channelPrefix(i, 'bus')}/config/name`);
    }
    for (let i = 1; i <= MTX_COUNT; i++) {
      sendOsc(`${channelPrefix(i, 'mtx')}/config/name`);
    }
    // Link state: one request per odd/even pair
    for (let i = 1; i <= CH_COUNT; i += 2) {
      sendOsc(`/config/chlink/${i}-${i + 1}`);
    }
    for (let i = 1; i <= BUS_COUNT; i += 2) {
      sendOsc(`/config/buslink/${i}-${i + 1}`);
    }
    for (let i = 1; i <= MTX_COUNT; i += 2) {
      sendOsc(`/config/mtxlink/${i}-${i + 1}`);
    }
    // Request initial fader/mute state for main channels
    for (const index of Object.keys(MAIN_LABELS).map(Number)) {
      const prefix = channelPrefix(index, 'main');
      sendOsc(`${prefix}/mix/fader`);
      sendOsc(`${prefix}/mix/on`);
    }

    if (metersActive) {
      logger.log('[X32] Restarting meter updates after reconnect');
      requestMeterUpdates();
      meterInterval = setInterval(requestMeterUpdates, 1500);
    }
    return;
  }

  if (address === '/meters/0' || address === '/meters/2' || address === '/meters/3') {
    handleMeterMessage(address, args);
    return;
  }

  // Link state responses: /config/chlink/1-2, /config/buslink/1-2, /config/mtxlink/1-2, etc.
  const linkMatch = address.match(/^\/config\/(ch|bus|mtx)link\/(\d+)-(\d+)$/);
  if (linkMatch) {
    const type = linkMatch[1] as 'ch' | 'bus' | 'mtx';
    const oddIndex = parseInt(linkMatch[2], 10);
    const linked = ((args?.[0]?.value as number) ?? 0) === 1;
    const oddCh = channels.find((c) => c.index === oddIndex && c.type === type);
    const evenCh = channels.find((c) => c.index === oddIndex + 1 && c.type === type);
    if (oddCh) oddCh.linkedToNext = linked;
    if (evenCh) evenCh.linkedToNext = false; // even channel is always the follower
    state.update('x32', { connected: true, channels: [...channels] });
    return;
  }

  const result = parseOscMessage(address, args);
  if (result) {
    updateChannel(result.index, result.type, result.patch);
  }
}

/**
 * Pure function: apply an OSC-parsed patch to a channel, respecting the
 * pending fader map.  Returns the filtered patch that should be applied.
 *
 * Rules for the fader field:
 * - If no pending entry exists → apply normally.
 * - If a pending entry exists AND is younger than PENDING_FADER_TIMEOUT_MS:
 *   - If |incoming - pending| <= PENDING_FADER_TOLERANCE → confirmation;
 *     clear the pending entry and apply.
 *   - Otherwise → stale echo; omit fader from the returned patch.
 * - If the pending entry has expired (>= PENDING_FADER_TIMEOUT_MS) → clear
 *   it and apply normally.
 *
 * Non-fader fields are always included in the returned patch.
 */
function applyOscPatchWithPending(
  channel: { type: string; index: number },
  patch: Partial<Channel>,
  pending: Map<string, { value: number; sentAt: number }>,
): Partial<Channel> {
  if (!('fader' in patch)) return patch;

  const key = `${channel.type}-${channel.index}`;
  const entry = pending.get(key);

  if (!entry) return patch;

  const age = Date.now() - entry.sentAt;
  if (age >= PENDING_FADER_TIMEOUT_MS) {
    // Expired: clear and apply normally
    pending.delete(key);
    return patch;
  }

  const diff = Math.abs((patch.fader as number) - entry.value);
  if (diff <= PENDING_FADER_TOLERANCE) {
    // Confirmation: X32 echoed back our value; clear pending and apply
    pending.delete(key);
    return patch;
  }

  // Stale echo: omit the fader field, pass through everything else
  const { fader: _fader, ...rest } = patch;
  return rest;
}

function updateChannel(index: number, type: 'ch' | 'bus' | 'main' | 'mtx', patch: Partial<Channel>): void {
  const ch = channels.find((c) => c.index === index && c.type === type);
  if (!ch) {
    logger.warn(`[X32] updateChannel: unknown ${type} ${index} — ignoring`);
    return;
  }
  const effectivePatch = applyOscPatchWithPending({ type, index }, patch, pendingFaders);
  Object.assign(ch, effectivePatch);
  state.update('x32', { connected: true, channels: [...channels] });
}

function subscribeToChanges(): void {
  logger.debug(`[X32] Renewing subscriptions for ${channels.length} channel(s)`);
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
  logger.log('[X32] Disconnecting');
  wantConnected = false;
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  if (subscribeInterval) { clearInterval(subscribeInterval); subscribeInterval = null; }
  if (meterInterval) { clearInterval(meterInterval); meterInterval = null; }
  if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  sendQueue = [];
  if (sock) { try { sock.close(); } catch (_) { /* ignore */ } sock = null; }
  connected = false;
  metersActive = false;
  logger.log('[X32] Disconnected');
}

export = {
  parseOscMessage,
  parseMeterBlob,
  buildMeterRequests,
  applyOscPatchWithPending,
  connect,
  disconnect,

  /**
   * Record a pending fader value for the given channel.  Call this immediately
   * after sending a fader command so that stale OSC echoes are suppressed until
   * the X32 confirms the new value (or 2 s elapse).
   */
  setPendingFader(type: 'ch' | 'bus' | 'main' | 'mtx', index: number, value: number): void {
    const key = `${type}-${index}`;
    pendingFaders.set(key, { value, sentAt: Date.now() });
  },

  startMeterUpdates(): void {
    logger.log('[X32] startMeterUpdates (connected=' + connected + ')');
    metersActive = true;
    if (!connected) return;
    requestMeterUpdates();
    if (meterInterval) clearInterval(meterInterval);
    meterInterval = setInterval(requestMeterUpdates, 1500);
  },

  stopMeterUpdates(): void {
    logger.log('[X32] stopMeterUpdates');
    metersActive = false;
    if (meterInterval) { clearInterval(meterInterval); meterInterval = null; }
  },

  setFader(channelIndex: number, value: number, type: 'ch' | 'bus' | 'main' | 'mtx' = 'ch'): void {
    const clamped = Math.max(0, Math.min(1, value));
    logger.log(`[X32] setFader ${type} ${channelIndex} = ${clamped}`);
    // Record the pending fader before sending so that OSC echoes arriving during
    // or immediately after the drag are suppressed until the X32 confirms.
    const key = `${type}-${channelIndex}`;
    pendingFaders.set(key, { value: clamped, sentAt: Date.now() });
    sendOsc(`${channelPrefix(channelIndex, type)}/mix/fader`, [
      { value: clamped },
    ]);
    // Apply the update optimistically in local state (bypassing pending check
    // so our own setFader always writes through).
    const ch = channels.find((c) => c.index === channelIndex && c.type === type);
    if (ch) {
      ch.fader = clamped;
      state.update('x32', { connected: true, channels: [...channels] });
    }
  },

  toggleMute(channelIndex: number, type: 'ch' | 'bus' | 'main' | 'mtx' = 'ch'): void {
    const ch = channels.find((c) => c.index === channelIndex && c.type === type);
    if (!ch) {
      logger.warn(`[X32] toggleMute: ${type} ${channelIndex} not found`);
      return;
    }
    const newState = ch.muted ? 1 : 0; // 1 = on (unmuted), 0 = off (muted)
    logger.log(`[X32] toggleMute ${type} ${channelIndex}: muted=${ch.muted} → ${!ch.muted}`);
    sendOsc(`${channelPrefix(channelIndex, type)}/mix/on`, [
      { value: newState },
    ]);
    updateChannel(channelIndex, type, { muted: !ch.muted });
  },
};
