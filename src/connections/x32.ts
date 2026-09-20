import dgram from 'dgram';
import nodeOsc = require('node-osc');
import config from '../config';
import state from '../state';
import * as logger from '../logger';
import * as levelsWs from '../levels-ws';
import type { Channel, BusSend } from '../types';

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
let livenessInterval: ReturnType<typeof setInterval> | null = null;
let sendTimer: ReturnType<typeof setInterval> | null = null;
let sendQueue: QueuedPacket[] = [];
let metersActive = false;
let lastValidResponseAt = 0;
let connectionGeneration = 0;
// Reference counts for per-bus send tracking: busIndex → number of active subscribers
const busSendRefCounts = new Map<number, number>();
// Renewal intervals per bus: busIndex → interval handle
const busSendIntervals = new Map<number, ReturnType<typeof setInterval>>();
let lastMeterSubscribeLogTime = 0;
let lastMeterReceiveLogTime = 0;
const loggedMeterChannels = new Set<string>();
let loggedNoResponse = false;

const SEND_INTERVAL_MS = 20;
const MAX_QUEUED_READS = 256;
const HANDSHAKE_TIMEOUT_MS = 3000;
const RESPONSE_TIMEOUT_MS = 15000;
const LIVENESS_CHECK_INTERVAL_MS = 1000;

type QueueKind = 'read' | 'write';
interface QueuedPacket {
  buf: Buffer;
  kind: QueueKind;
  key?: string;
}

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

// Internal tracking of full DCA bitmask per channel (key = `${type}-${index}`).
// Used to preserve other DCA group assignments when toggling only bit 7 (DCA 8).
const dcaGroupsMap = new Map<string, number>();

// Pending fader map: key is `${type}-${index}`, value is { value, sentAt }
// When the client sends a fader command, we record it here so that stale OSC
// echoes from the X32 do not snap the slider back during or after a drag.
const pendingFaders = new Map<string, { value: number; sentAt: number }>();
const PENDING_FADER_TIMEOUT_MS = 2000;
const PENDING_FADER_TOLERANCE = 0.05;

// Pending bus-send map: key is `ch${channelIndex}-bus${busIndex}`, value is { level, sentAt }
// Same suppression logic as pendingFaders, but for channel-to-bus send levels.
const pendingBusSends = new Map<string, { level: number; sentAt: number }>();

// OSC path suffix used for DCA group assignment messages (e.g. /ch/01/grp/dca)
const DCA_GROUP_PATH = '/grp/dca';

// Number of input channels, buses, and matrices on the X32
const CH_COUNT = 32;
const BUS_COUNT = 16;
const MTX_COUNT = 6;

// main type: index 1 = stereo L/R, index 2 = mono/center
const MAIN_LABELS: Record<number, string> = { 1: 'Main L/R', 2: 'Main M/C' };

function isChannelType(value: unknown): value is OscResult['type'] {
  return value === 'ch' || value === 'bus' || value === 'main' || value === 'mtx';
}

function validChannelIndex(index: unknown, type: OscResult['type']): index is number {
  if (typeof index !== 'number' || !Number.isInteger(index)) return false;
  if (type === 'ch') return index >= 1 && index <= CH_COUNT;
  if (type === 'bus') return index >= 1 && index <= BUS_COUNT;
  if (type === 'mtx') return index >= 1 && index <= MTX_COUNT;
  return index === 1 || index === 2;
}

function validBusIndex(index: unknown): index is number {
  return typeof index === 'number' && Number.isInteger(index) && index >= 1 && index <= BUS_COUNT;
}

function cloneChannel(channel: Channel): Channel {
  return {
    ...channel,
    ...(channel.busSends ? { busSends: channel.busSends.map((send) => ({ ...send })) } : {}),
  };
}

function snapshotChannels(): Channel[] {
  return channels.map(cloneChannel);
}

function publishState(isConnected = connected): void {
  state.update('x32', { connected: isConnected, channels: snapshotChannels() });
}

function clearIntervalHandle(handle: ReturnType<typeof setInterval> | null): null {
  if (handle) clearInterval(handle);
  return null;
}

function clearBusTrackingIntervals(): void {
  for (const interval of busSendIntervals.values()) clearInterval(interval);
  busSendIntervals.clear();
}

function clearConnectionResources(preserveWrites = false): void {
  keepAliveInterval = clearIntervalHandle(keepAliveInterval);
  subscribeInterval = clearIntervalHandle(subscribeInterval);
  meterInterval = clearIntervalHandle(meterInterval);
  livenessInterval = clearIntervalHandle(livenessInterval);
  sendTimer = clearIntervalHandle(sendTimer);
  clearBusTrackingIntervals();
  sendQueue = preserveWrites ? sendQueue.filter((packet) => packet.kind === 'write') : [];
}

function closeSocket(socket: dgram.Socket | null): void {
  if (!socket) return;
  try { socket.close(); } catch { /* ignore if already closed */ }
}

function scheduleReconnect(): void {
  if (!wantConnected || reconnectTimer) return;
  logger.log('[X32] Scheduling reconnect in 5s');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (wantConnected) connect();
  }, 5000);
}

function markDisconnected(generation: number, reason: string): void {
  if (generation !== connectionGeneration || !wantConnected) return;
  if (!sock && !connected) {
    scheduleReconnect();
    return;
  }
  const wasConnected = connected;
  connected = false;
  lastValidResponseAt = 0;
  clearConnectionResources(true);
  const staleSocket = sock;
  sock = null;
  closeSocket(staleSocket);
  publishState(false);
  if (wasConnected) logger.warn(`[X32] Mixer unavailable (${reason}); reconnecting`);
  else if (!loggedNoResponse) {
    logger.log(`[X32] No mixer response (${reason}); will retry...`);
    loggedNoResponse = true;
  }
  scheduleReconnect();
}

function connect(): void {
  logger.log('[X32] Attempting to connect to', config.x32.address, 'port', config.x32.port);
  wantConnected = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectionGeneration += 1;
  const generation = connectionGeneration;
  clearConnectionResources(true);
  closeSocket(sock);
  sock = null;
  connected = false;
  lastValidResponseAt = 0;
  loggedNoResponse = false;
  loggedMeterChannels.clear();

  // Pre-populate all channels in sorted order with default labels.
  channels = [];
  dcaGroupsMap.clear();
  for (let i = 1; i <= CH_COUNT; i++) {
    channels.push({ index: i, type: 'ch', label: `CH ${String(i).padStart(2, '0')}`, fader: 0, muted: false, level: 0, source: 0, linkedToNext: false, spill: false, color: 0 });
  }
  for (let i = 1; i <= BUS_COUNT; i++) {
    channels.push({ index: i, type: 'bus', label: `Bus ${String(i).padStart(2, '0')}`, fader: 0, muted: false, level: 0, source: 0, linkedToNext: false, spill: false, color: 0 });
  }
  for (let i = 1; i <= MTX_COUNT; i++) {
    channels.push({ index: i, type: 'mtx', label: `Mtx ${String(i).padStart(2, '0')}`, fader: 0, muted: false, level: 0, source: 0, linkedToNext: false, spill: false, color: 0 });
  }
  for (const [idx, lbl] of Object.entries(MAIN_LABELS)) {
    channels.push({ index: Number(idx), type: 'main', label: lbl, fader: 0, muted: false, level: 0, source: 1, linkedToNext: false, spill: false, color: 0 });
  }
  publishState(false);

  // Bind to 0.0.0.0 so the OS accepts inbound packets on any local network
  // interface and picks an ephemeral source port.
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock = socket;
  socket.on('error', (err) => {
    if (generation !== connectionGeneration) return;
    logger.warn('[X32] Socket error:', err.message);
    markDisconnected(generation, 'socket error');
  });
  socket.on('close', () => {
    if (generation === connectionGeneration && wantConnected && connected) {
      markDisconnected(generation, 'socket closed');
    }
  });
  socket.on('message', (raw: Buffer) => {
    if (generation !== connectionGeneration || socket !== sock) return;
    let address: string;
    let args: OscArg[];
    try {
      const decoded = oscDecode(raw) as { address?: unknown; args?: unknown };
      if (typeof decoded.address !== 'string') return;
      address = decoded.address;
      args = Array.isArray(decoded.args) ? decoded.args as OscArg[] : [];
    } catch (e) {
      logger.warn('[X32] Failed to decode OSC packet:', (e as Error).message);
      return;
    }
    lastValidResponseAt = Date.now();
    handleMessage(address, args);
    // Immediately send the next queued request on any incoming reply.
    flushSendQueue();
  });

  socket.bind(0, '0.0.0.0', () => {
    if (generation !== connectionGeneration || socket !== sock) return;
    const port = socket.address().port;
    logger.log(`[X32] Socket bound on ephemeral port ${port}`);
    sendTimer = setInterval(flushSendQueue, SEND_INTERVAL_MS);
    livenessInterval = setInterval(() => {
      if (generation !== connectionGeneration || !wantConnected) return;
      const elapsed = Date.now() - lastValidResponseAt;
      if (!connected && elapsed >= HANDSHAKE_TIMEOUT_MS) {
        markDisconnected(generation, 'no /info reply');
      } else if (connected && elapsed >= RESPONSE_TIMEOUT_MS) {
        markDisconnected(generation, 'reply timeout');
      }
    }, LIVENESS_CHECK_INTERVAL_MS);
    logger.log('[X32] Sending /info to validate connection');
    sendImmediate('/info');
  });
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
  const socket = sock;
  if (!socket) return;
  const generation = connectionGeneration;
  const buf = buildOscBuffer(address, args);
  socket.send(buf, 0, buf.length, config.x32.port, config.x32.address, (err) => {
    if (err && generation === connectionGeneration && wantConnected) logger.warn('[X32] Send error:', err.message);
  });
}

function queueKey(address: string, args?: OscArg[]): string {
  let encodedArgs: string;
  try {
    encodedArgs = JSON.stringify(args?.map((arg) => arg.value)) ?? '';
  } catch {
    encodedArgs = String(args);
  }
  return `${address}\u0000${encodedArgs}`;
}

function flushSendQueue(): void {
  const socket = sock;
  if (!socket || sendQueue.length === 0) return;
  const packet = sendQueue.shift()!;
  const generation = connectionGeneration;
  socket.send(packet.buf, 0, packet.buf.length, config.x32.port, config.x32.address, (err) => {
    if (err && generation === connectionGeneration && wantConnected) logger.warn('[X32] Send error:', err.message);
  });
}

function sendOsc(address: string, args?: OscArg[], kind: QueueKind = 'read'): void {
  if (!sock) {
    if (kind === 'write' && wantConnected) sendQueue.push({ buf: buildOscBuffer(address, args), kind });
    else logger.warn('[X32] sendOsc called but no socket:', address);
    return;
  }
  const key = kind === 'read' ? queueKey(address, args) : undefined;
  if (key && sendQueue.some((packet) => packet.kind === 'read' && packet.key === key)) return;
  if (kind === 'read') {
    let readCount = 0;
    for (const packet of sendQueue) if (packet.kind === 'read') readCount += 1;
    if (readCount >= MAX_QUEUED_READS) {
      const staleIndex = sendQueue.findIndex((packet) => packet.kind === 'read');
      if (staleIndex >= 0) sendQueue.splice(staleIndex, 1);
    }
  }
  sendQueue.push({ buf: buildOscBuffer(address, args), kind, key });
}

// Parse a meter blob into an array of float32 values.
// The blob is delivered by node-osc's oscDecode which already strips the outer
// OSC blob length prefix. The X32 then prepends its own 4-byte count field
// (little-endian uint32) indicating how many float32 values follow.
// We skip that 4-byte count and read the rest as packed little-endian float32
// values (linear peak level 0.0–1.0, 1.0 = 0 dBFS).
function parseMeterBlob(blob: Buffer): number[] {
  if (blob.length < 8) return [];
  const data = blob.subarray(4);
  const count = Math.floor(data.length / 4);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = data.readFloatLE(i * 4);
    values.push(Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0);
  }
  return values;
}

// Returns the list of OSC meter subscription requests for input channels, mix buses, matrix, and main.
// Protocol: /meters ,si <bank-path> <time_factor>
//   bank-path: "/meters/0", "/meters/2", etc.
//   time_factor: 1–99; update interval = 50ms × time_factor; active for ~10s.
// The X32 responds with /meters/0 and /meters/2 blobs every 50ms × time_factor.
// We renew every 1.5 s to keep the stream active (time_factor=5 → 250ms interval, ~40 updates in 10s).
//
// Bank layouts (from the Unofficial X32/M32 OSC Remote Protocol doc):
//   /meters/0: 32 ch + 8 aux + 4x2 fx returns + 16 bus + 6 mtx = 70 floats
//              pos 0–31=ch 1–32, pos 32–39=aux, pos 40–47=fx, pos 48–63=bus 1–16, pos 64–69=mtx 1–6
//   /meters/2: 16 bus + 6 mtx + 2 main LR + 1 mono + dynamics = 49 floats
//              pos 0–15=bus 1–16, pos 16–21=mtx 1–6, pos 22–23=main L/R, pos 24=main M/C
function buildMeterRequests(): Array<{ address: string; args: OscArg[] }> {
  return [
    // Bank 0: input channels (pos 0–31), bus (pos 48–63), mtx (pos 64–69)
    { address: '/meters', args: [{ value: '/meters/0' }, { value: 5 }] },
    // Bank 2: bus (pos 0–15), mtx (pos 16–21), main L/R (pos 22–23), main M/C (pos 24)
    { address: '/meters', args: [{ value: '/meters/2' }, { value: 5 }] },
  ];
}

function requestMeterUpdates(): void {
  const now = Date.now();
  if (now - lastMeterSubscribeLogTime > 30000) {
    logger.log('[X32] Subscribing to meter banks 0 (ch/bus/mtx) and 2 (bus/mtx/main)');
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
  channels = channels.map((ch) => {
    let level: number | undefined;
    if (address === '/meters/0') {
      if (ch.type === 'ch') level = values[ch.index - 1];
      else if (ch.type === 'bus') level = values[48 + ch.index - 1];
      else if (ch.type === 'mtx') level = values[64 + ch.index - 1];
    } else if (address === '/meters/2') {
      if (ch.type === 'bus') level = values[ch.index - 1];
      else if (ch.type === 'mtx') level = values[16 + ch.index - 1];
      else if (ch.type === 'main') {
        if (ch.index === 1) level = Math.max(values[22] ?? 0, values[23] ?? 0);
        else if (ch.index === 2) level = values[24];
      }
    }
    if (level === undefined || !Number.isFinite(level)) return ch;
    const key = `${ch.type}-${ch.index}`;
    if (!loggedMeterChannels.has(key)) {
      loggedMeterChannels.add(key);
      logger.log(`[X32] First meter data for ${key} (${ch.label}): level=${level} via ${address}`);
    }
    if (ch.level === level) return ch;
    updated = true;
    return { ...ch, level };
  });
  if (updated) {
    // Broadcast level-only updates directly to /ws/levels; meter ticks do not
    // need to re-render all main WebSocket channel elements.
    const x32Levels: Record<string, number> = {};
    for (const ch of channels) x32Levels[`${ch.type}-${ch.index}`] = ch.level;
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

function faderPatch(args: OscArg[]): Partial<Channel> | null {
  const raw = args?.[0]?.value;
  const value = raw === undefined ? 0 : raw;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? { fader: value } : null;
}

function mutePatch(args: OscArg[]): Partial<Channel> | null {
  const raw = args?.[0]?.value;
  const value = raw === undefined ? 1 : raw;
  return typeof value === 'number' && Number.isFinite(value) && (value === 0 || value === 1)
    ? { muted: value === 0 }
    : null;
}

function namePatch(args: OscArg[]): Partial<Channel> | null {
  const name = args?.[0]?.value;
  return typeof name === 'string' && name.length > 0 ? { label: name } : null;
}

function sourcePatch(args: OscArg[]): Partial<Channel> | null {
  const raw = args?.[0]?.value;
  const value = raw === undefined ? 0 : raw;
  return typeof value === 'number' && Number.isFinite(value) ? { source: value } : null;
}

function colorPatch(args: OscArg[]): Partial<Channel> | null {
  const raw = args?.[0]?.value;
  const value = raw === undefined ? 0 : raw;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15 ? { color: value } : null;
}

// DCA group bitmask: bit 7 (value 128) = DCA group 8.
function dcaPatch(args: OscArg[]): Partial<Channel> | null {
  const raw = args?.[0]?.value;
  const value = raw === undefined ? 0 : raw;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? { spill: (value & 128) !== 0 } : null;
}

const OSC_PATTERNS: OscPattern[] = [
  // Input channels
  { re: /^\/ch\/(\d+)\/mix\/fader$/,      type: 'ch',   indexGroup: 1,    patch: faderPatch },
  { re: /^\/ch\/(\d+)\/mix\/on$/,         type: 'ch',   indexGroup: 1,    patch: mutePatch },
  { re: /^\/ch\/(\d+)\/config\/name$/,    type: 'ch',   indexGroup: 1,    patch: namePatch },
  { re: /^\/ch\/(\d+)\/config\/source$/,  type: 'ch',   indexGroup: 1,    patch: sourcePatch },
  { re: /^\/ch\/(\d+)\/config\/color$/,   type: 'ch',   indexGroup: 1,    patch: colorPatch },
  { re: new RegExp(`^/ch/(\\d+)${DCA_GROUP_PATH}$`),    type: 'ch',   indexGroup: 1, patch: dcaPatch },
  // Mix buses
  { re: /^\/bus\/(\d+)\/mix\/fader$/,     type: 'bus',  indexGroup: 1,    patch: faderPatch },
  { re: /^\/bus\/(\d+)\/mix\/on$/,        type: 'bus',  indexGroup: 1,    patch: mutePatch },
  { re: /^\/bus\/(\d+)\/config\/name$/,   type: 'bus',  indexGroup: 1,    patch: namePatch },
  { re: /^\/bus\/(\d+)\/config\/color$/,  type: 'bus',  indexGroup: 1,    patch: colorPatch },
  { re: new RegExp(`^/bus/(\\d+)${DCA_GROUP_PATH}$`),   type: 'bus',  indexGroup: 1, patch: dcaPatch },
  // Matrix
  { re: /^\/mtx\/(\d+)\/mix\/fader$/,     type: 'mtx',  indexGroup: 1,    patch: faderPatch },
  { re: /^\/mtx\/(\d+)\/mix\/on$/,        type: 'mtx',  indexGroup: 1,    patch: mutePatch },
  { re: /^\/mtx\/(\d+)\/config\/name$/,   type: 'mtx',  indexGroup: 1,    patch: namePatch },
  { re: /^\/mtx\/(\d+)\/config\/color$/,  type: 'mtx',  indexGroup: 1,    patch: colorPatch },
  // Main L/R (index 1) and Main M/C (index 2)
  { re: /^\/main\/st\/mix\/fader$/,       type: 'main', indexGroup: null, fixedIndex: 1, patch: faderPatch },
  { re: /^\/main\/st\/mix\/on$/,          type: 'main', indexGroup: null, fixedIndex: 1, patch: mutePatch },
  { re: /^\/main\/st\/config\/color$/,    type: 'main', indexGroup: null, fixedIndex: 1, patch: colorPatch },
  { re: /^\/main\/m\/mix\/fader$/,        type: 'main', indexGroup: null, fixedIndex: 2, patch: faderPatch },
  { re: /^\/main\/m\/mix\/on$/,           type: 'main', indexGroup: null, fixedIndex: 2, patch: mutePatch },
];

interface BusSendResult {
  channelIndex: number;
  busIndex: number;
  patch: Partial<BusSend>;
}
// Pure function: parse an OSC address + args for channel-to-bus send messages.
// Handles /ch/NN/mix/BB/level and /ch/NN/mix/BB/on.
// Returns { channelIndex, busIndex, patch } or null if not a bus send message.
function parseBusSendMessage(address: string, args: OscArg[]): BusSendResult | null {
  if (typeof address !== 'string' || !Array.isArray(args)) return null;
  const levelMatch = address.match(/^\/ch\/(\d+)\/mix\/(\d+)\/level$/);
  const onMatch = address.match(/^\/ch\/(\d+)\/mix\/(\d+)\/on$/);
  const match = levelMatch ?? onMatch;
  if (!match) return null;
  const channelIndex = Number.parseInt(match[1], 10);
  const busIndex = Number.parseInt(match[2], 10);
  if (!validChannelIndex(channelIndex, 'ch') || !validBusIndex(busIndex)) return null;
  const raw = args?.[0]?.value;
  if (levelMatch) {
    const value = raw === undefined ? 0 : raw;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
    return { channelIndex, busIndex, patch: { level: value } };
  }
  const value = raw === undefined ? 0 : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || (value !== 0 && value !== 1)) return null;
  return { channelIndex, busIndex, patch: { on: value === 1 } };
}

// Pure function: parse an OSC address + args into a channel state patch.
// Returns { index, type, patch } or null if the message isn't a recognised channel message.
function parseOscMessage(address: string, args: OscArg[]): OscResult | null {
  if (typeof address !== 'string' || !Array.isArray(args)) return null;
  for (const pattern of OSC_PATTERNS) {
    const match = address.match(pattern.re);
    if (!match) continue;
    const index = pattern.indexGroup !== null ? Number.parseInt(match[pattern.indexGroup], 10) : pattern.fixedIndex!;
    if (!isChannelType(pattern.type) || !validChannelIndex(index, pattern.type)) return null;
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
    publishState(true);
    logger.log('[X32] /info reply — connection confirmed, starting discovery');

    // These guards keep duplicate /info packets from creating duplicate loops.
    keepAliveInterval = clearIntervalHandle(keepAliveInterval);
    subscribeInterval = clearIntervalHandle(subscribeInterval);
    sendOsc('/xremote');
    keepAliveInterval = setInterval(() => {
      logger.debug('[X32] keepalive /xremote');
      sendOsc('/xremote');
    }, 8000);
    subscribeInterval = setInterval(subscribeToChanges, 8000);

    // Request names, sources, and link state for all channels.
    // Throttled via the send queue to avoid flooding the mixer.
    logger.log(`[X32] Requesting names/sources/links/dca for ${CH_COUNT} ch, ${BUS_COUNT} bus, ${MTX_COUNT} mtx, and main`);
    for (let i = 1; i <= CH_COUNT; i++) {
      sendOsc(`${channelPrefix(i, 'ch')}/config/name`);
      sendOsc(`${channelPrefix(i, 'ch')}/config/color`);
      sendOsc(`${channelPrefix(i, 'ch')}/config/source`);
      sendOsc(`${channelPrefix(i, 'ch')}${DCA_GROUP_PATH}`);
    }
    for (let i = 1; i <= BUS_COUNT; i++) {
      sendOsc(`${channelPrefix(i, 'bus')}/config/name`);
      sendOsc(`${channelPrefix(i, 'bus')}/config/color`);
      sendOsc(`${channelPrefix(i, 'bus')}${DCA_GROUP_PATH}`);
    }
    for (let i = 1; i <= MTX_COUNT; i++) {
      sendOsc(`${channelPrefix(i, 'mtx')}/config/name`);
      sendOsc(`${channelPrefix(i, 'mtx')}/config/color`);
    }
    sendOsc(`${channelPrefix(1, 'main')}/config/color`);
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
      meterInterval = clearIntervalHandle(meterInterval);
      requestMeterUpdates();
      meterInterval = setInterval(requestMeterUpdates, 1500);
    }
    restartBusSendTracking();
    return;
  }

  if (address === '/meters/0' || address === '/meters/2') {
    handleMeterMessage(address, args);
    return;
  }

  // Link state responses: /config/chlink/1-2, /config/buslink/1-2, /config/mtxlink/1-2, etc.
  const linkMatch = address.match(/^\/config\/(ch|bus|mtx)link\/(\d+)-(\d+)$/);
  if (linkMatch) {
    const type = linkMatch[1] as 'ch' | 'bus' | 'mtx';
    const oddIndex = Number.parseInt(linkMatch[2], 10);
    const evenIndex = Number.parseInt(linkMatch[3], 10);
    const raw = args?.[0]?.value;
    const linked = raw === undefined ? false : raw;
    if (!validChannelIndex(oddIndex, type) || !validChannelIndex(evenIndex, type) ||
      typeof linked !== 'number' || !Number.isFinite(linked) || (linked !== 0 && linked !== 1)) return;
    channels = channels.map((channel) => {
      if (channel.type === type && channel.index === oddIndex) return { ...channel, linkedToNext: linked === 1 };
      if (channel.type === type && channel.index === evenIndex) return { ...channel, linkedToNext: false };
      return channel;
    });
    publishState(true);
    return;
  }

  // Intercept DCA group messages to store the full bitmask for read-modify-write.
  const dcaMatch = address.match(new RegExp(`^/(ch|bus)/(\\d+)${DCA_GROUP_PATH}$`));
  if (dcaMatch) {
    const type = dcaMatch[1] as 'ch' | 'bus';
    const index = Number.parseInt(dcaMatch[2], 10);
    const raw = args?.[0]?.value;
    const value = raw === undefined ? 0 : raw;
    if (validChannelIndex(index, type) && typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      dcaGroupsMap.set(`${type}-${index}`, value);
    }
  }

  // Bus send messages: /ch/NN/mix/BB/level and /ch/NN/mix/BB/on
  const busSendResult = parseBusSendMessage(address, args);
  if (busSendResult) {
    updateBusSend(busSendResult.channelIndex, busSendResult.busIndex, busSendResult.patch);
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

/**
 * Pure function: apply a bus-send patch respecting the pending bus-send map.
 * Mirrors applyOscPatchWithPending but operates on BusSend.level.
 */
function applyBusSendPatchWithPending(
  key: string,
  patch: Partial<BusSend>,
  pending: Map<string, { level: number; sentAt: number }>,
): Partial<BusSend> {
  if (!('level' in patch)) return patch;

  const entry = pending.get(key);
  if (!entry) return patch;

  const age = Date.now() - entry.sentAt;
  if (age >= PENDING_FADER_TIMEOUT_MS) {
    pending.delete(key);
    return patch;
  }

  const diff = Math.abs((patch.level as number) - entry.level);
  if (diff <= PENDING_FADER_TOLERANCE) {
    pending.delete(key);
    return patch;
  }

  const { level: _level, ...rest } = patch;
  return rest;
}

function updateChannel(index: number, type: 'ch' | 'bus' | 'main' | 'mtx', patch: Partial<Channel>): void {
  const channel = channels.find((candidate) => candidate.index === index && candidate.type === type);
  if (!channel) {
    logger.warn(`[X32] updateChannel: unknown ${type} ${index} — ignoring`);
    return;
  }
  const effectivePatch = applyOscPatchWithPending({ type, index }, patch, pendingFaders);
  channels = channels.map((candidate) => candidate === channel
    ? { ...candidate, ...effectivePatch, ...(candidate.busSends ? { busSends: candidate.busSends.map((send) => ({ ...send })) } : {}) }
    : candidate);
  publishState(true);
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
    if (ch.type !== 'main') {
      sendOsc('/subscribe', [
        { value: `${prefix}/config/color` },
        { value: 20 },
      ]);
    }
    if (ch.type === 'ch' || ch.type === 'bus') {
      sendOsc('/subscribe', [
        { value: `${prefix}${DCA_GROUP_PATH}` },
        { value: 20 },
      ]);
    }
  }
}

function disconnect(): void {
  logger.log('[X32] Disconnecting');
  wantConnected = false;
  connectionGeneration += 1;
  clearConnectionResources();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  closeSocket(sock);
  sock = null;
  connected = false;
  dcaGroupsMap.clear();
  metersActive = false;
  busSendRefCounts.clear();
  pendingFaders.clear();
  pendingBusSends.clear();
  channels = channels.map((channel) => {
    if (!channel.busSends) return channel;
    const { busSends: _busSends, ...withoutBusSends } = channel;
    return withoutBusSends;
  });
  publishState(false);
}
function setPendingFader(type: 'ch' | 'bus' | 'main' | 'mtx', index: number, value: number): void {
  if (!isChannelType(type) || !validChannelIndex(index, type) || !Number.isFinite(value)) {
    throw new Error('Invalid X32 pending fader');
  }
  pendingFaders.set(`${type}-${index}`, { value, sentAt: Date.now() });
}

function isActive(): boolean {
  return wantConnected;
}

function startMeterUpdates(): void {
  logger.log('[X32] startMeterUpdates (connected=' + connected + ')');
  metersActive = true;
  if (!connected) return;
  requestMeterUpdates();
  meterInterval = clearIntervalHandle(meterInterval);
  meterInterval = setInterval(requestMeterUpdates, 1500);
}

function stopMeterUpdates(): void {
  logger.log('[X32] stopMeterUpdates');
  metersActive = false;
  meterInterval = clearIntervalHandle(meterInterval);
}


function setFader(channelIndex: number, value: number, type: 'ch' | 'bus' | 'main' | 'mtx' = 'ch'): Promise<void> {
  if (!isChannelType(type) || !validChannelIndex(channelIndex, type) || !Number.isFinite(value) || value < 0 || value > 1) {
    return Promise.reject(new Error('Invalid X32 fader'));
  }
  const clamped = value;
  const channel = channels.find((candidate) => candidate.index === channelIndex && candidate.type === type);
  if (!channel) return Promise.reject(new Error('Unknown X32 channel'));
  logger.log(`[X32] setFader ${type} ${channelIndex} = ${clamped}`);
  pendingFaders.set(`${type}-${channelIndex}`, { value: clamped, sentAt: Date.now() });
  sendOsc(`${channelPrefix(channelIndex, type)}/mix/fader`, [{ value: clamped }], 'write');
  channels = channels.map((candidate) => candidate === channel ? { ...candidate, fader: clamped } : candidate);
  publishState(connected);
  return Promise.resolve();
}

function setSpill(channelIndex: number, type: 'ch' | 'bus', assigned: boolean): void {
  if ((type !== 'ch' && type !== 'bus') || !validChannelIndex(channelIndex, type) || typeof assigned !== 'boolean') {
    throw new Error('Invalid X32 spill');
  }
  const key = `${type}-${channelIndex}`;
  const currentBitmask = dcaGroupsMap.get(key) ?? 0;
  const newBitmask = assigned ? (currentBitmask | 128) : (currentBitmask & ~128);
  dcaGroupsMap.set(key, newBitmask);
  logger.log(`[X32] setSpill ${type} ${channelIndex} = ${assigned} (bitmask ${newBitmask})`);
  sendOsc(`${channelPrefix(channelIndex, type)}${DCA_GROUP_PATH}`, [{ value: newBitmask }], 'write');
  updateChannel(channelIndex, type, { spill: assigned });
}

function updateBusSend(channelIndex: number, busIndex: number, patch: Partial<BusSend>): void {
  if (!validChannelIndex(channelIndex, 'ch') || !validBusIndex(busIndex)) return;
  const channel = channels.find((candidate) => candidate.index === channelIndex && candidate.type === 'ch');
  if (!channel) return;
  const key = `ch${channelIndex}-bus${busIndex}`;
  const effectivePatch = applyBusSendPatchWithPending(key, patch, pendingBusSends);
  const busSends = channel.busSends ? channel.busSends.map((send) => ({ ...send })) : [];
  const existing = busSends.find((send) => send.busIndex === busIndex);
  if (existing) Object.assign(existing, effectivePatch);
  else busSends.push({ busIndex, level: 0, on: false, ...effectivePatch });
  channels = channels.map((candidate) => candidate === channel ? { ...candidate, busSends } : candidate);
  publishState(true);
}

function requestBusSendUpdates(busIndex: number): void {
  if (!validBusIndex(busIndex)) return;
  logger.debug(`[X32] Requesting bus send data for bus ${busIndex}`);
  const padded = String(busIndex).padStart(2, '0');
  for (let i = 1; i <= CH_COUNT; i++) {
    const ch = String(i).padStart(2, '0');
    sendOsc(`/ch/${ch}/mix/${padded}/level`);
    sendOsc(`/ch/${ch}/mix/${padded}/on`);
  }
}

function ensureBusTrackingInterval(busIndex: number): void {
  if (busSendIntervals.has(busIndex)) return;
  busSendIntervals.set(busIndex, setInterval(() => {
    if (connected && busSendRefCounts.has(busIndex)) requestBusSendUpdates(busIndex);
  }, 8000));
}

function restartBusSendTracking(): void {
  for (const busIndex of busSendRefCounts.keys()) {
    ensureBusTrackingInterval(busIndex);
    if (connected) requestBusSendUpdates(busIndex);
  }
}

function startBusSendTracking(busIndex: number): void {
  if (!validBusIndex(busIndex)) throw new Error('Invalid X32 bus index');
  const current = busSendRefCounts.get(busIndex) ?? 0;
  busSendRefCounts.set(busIndex, current + 1);
  ensureBusTrackingInterval(busIndex);
  if (current === 0) {
    logger.log(`[X32] startBusSendTracking bus ${busIndex}`);
    if (connected) requestBusSendUpdates(busIndex);
  }
}

function stopBusSendTracking(busIndex: number): void {
  if (!validBusIndex(busIndex)) throw new Error('Invalid X32 bus index');
  const current = busSendRefCounts.get(busIndex) ?? 0;
  if (current > 1) {
    busSendRefCounts.set(busIndex, current - 1);
    return;
  }
  busSendRefCounts.delete(busIndex);
  const interval = busSendIntervals.get(busIndex);
  if (interval) {
    clearInterval(interval);
    busSendIntervals.delete(busIndex);
  }
  channels = channels.map((channel) => {
    if (!channel.busSends) return channel;
    const busSends = channel.busSends.filter((send) => send.busIndex !== busIndex);
    return busSends.length > 0 ? { ...channel, busSends } : (() => {
      const { busSends: _removed, ...withoutBusSends } = channel;
      return withoutBusSends;
    })();
  });
  logger.log(`[X32] stopBusSendTracking bus ${busIndex}`);
  publishState(connected);
}

function setBusSend(channelIndex: number, busIndex: number, value: number): Promise<void> {
  if (!validChannelIndex(channelIndex, 'ch') || !validBusIndex(busIndex) || !Number.isFinite(value) || value < 0 || value > 1) {
    return Promise.reject(new Error('Invalid X32 bus send'));
  }
  const channel = channels.find((candidate) => candidate.index === channelIndex && candidate.type === 'ch');
  if (!channel) return Promise.reject(new Error('Unknown X32 channel'));
  const clamped = value;
  logger.log(`[X32] setBusSend ch ${channelIndex} → bus ${busIndex} = ${clamped}`);
  const key = `ch${channelIndex}-bus${busIndex}`;
  pendingBusSends.set(key, { level: clamped, sentAt: Date.now() });
  const ch = String(channelIndex).padStart(2, '0');
  const bus = String(busIndex).padStart(2, '0');
  sendOsc(`/ch/${ch}/mix/${bus}/level`, [{ value: clamped }], 'write');
  const busSends = channel.busSends ? channel.busSends.map((send) => ({ ...send })) : [];
  const existing = busSends.find((send) => send.busIndex === busIndex);
  if (existing) existing.level = clamped;
  else busSends.push({ busIndex, level: clamped, on: false });
  channels = channels.map((candidate) => candidate === channel ? { ...candidate, busSends } : candidate);
  publishState(connected);
  return Promise.resolve();
}

function toggleMute(channelIndex: number, type: 'ch' | 'bus' | 'main' | 'mtx' = 'ch'): void {
  if (!isChannelType(type) || !validChannelIndex(channelIndex, type)) throw new Error('Invalid X32 channel');
  const channel = channels.find((candidate) => candidate.index === channelIndex && candidate.type === type);
  if (!channel) throw new Error('Unknown X32 channel');
  const newState = channel.muted ? 1 : 0;
  logger.log(`[X32] toggleMute ${type} ${channelIndex}: muted=${channel.muted} → ${!channel.muted}`);
  sendOsc(`${channelPrefix(channelIndex, type)}/mix/on`, [{ value: newState }], 'write');
  updateChannel(channelIndex, type, { muted: !channel.muted });
}

export {
  parseOscMessage,
  parseBusSendMessage,
  parseMeterBlob,
  buildMeterRequests,
  applyOscPatchWithPending,
  applyBusSendPatchWithPending,
  connect,
  disconnect,
  isActive,
  setPendingFader,
  startMeterUpdates,
  stopMeterUpdates,
  setFader,
  setSpill,
  toggleMute,
  startBusSendTracking,
  stopBusSendTracking,
  setBusSend,
};
