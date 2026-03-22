import dgram = require('dgram');
import config = require('../config');
import state = require('../state');
import logger = require('../logger');

// ── VISCA/IP packet builder ───────────────────────────────────────────────────

/**
 * Wraps a VISCA payload in an 8-byte VISCA/IP UDP header.
 * Header layout (big-endian):
 *   [0–1] Payload type: 0x01 0x00 = VISCA command
 *   [2–3] Payload length (uint16)
 *   [4–7] Sequence number (uint32)
 *   [8…]  VISCA payload (including 0x8n camera-address byte)
 */
function buildViscaPacket(seqNum: number, payload: number[]): Buffer {
  const buf = Buffer.alloc(8 + payload.length);
  buf[0] = 0x01; buf[1] = 0x00;
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(seqNum, 4);
  for (let i = 0; i < payload.length; i++) buf[8 + i] = payload[i];
  return buf;
}

// ── Pure VISCA command builders (exported for unit testing) ───────────────────

/**
 * Pan-Tilt Drive command.
 * pan:  -1 = left, 0 = stop, 1 = right
 * tilt: -1 = down, 0 = stop, 1 = up
 * panSpeed:  1–24 (clamped)
 * tiltSpeed: 1–20 (clamped)
 */
function panTiltCommand(cameraId: number, pan: -1 | 0 | 1, tilt: -1 | 0 | 1, panSpeed: number, tiltSpeed: number): number[] {
  const addr = 0x80 | cameraId;
  const panDir  = pan  === -1 ? 0x01 : pan  === 1 ? 0x02 : 0x03;
  const tiltDir = tilt ===  1 ? 0x01 : tilt === -1 ? 0x02 : 0x03;
  const vv = Math.max(1, Math.min(24, panSpeed));
  const ww = Math.max(1, Math.min(20, tiltSpeed));
  return [addr, 0x01, 0x06, 0x01, vv, ww, panDir, tiltDir, 0xFF];
}

/**
 * Zoom command.
 * direction: 'in' = tele, 'out' = wide, 'stop'
 * speed: 0–7 (clamped); ignored for 'stop'
 */
function zoomCommand(cameraId: number, direction: 'in' | 'out' | 'stop', speed: number): number[] {
  const addr = 0x80 | cameraId;
  let pp: number;
  if (direction === 'stop') {
    pp = 0x00;
  } else {
    const s = Math.max(0, Math.min(7, speed));
    pp = (direction === 'in' ? 0x20 : 0x30) | s;
  }
  return [addr, 0x01, 0x04, 0x07, pp, 0xFF];
}

/**
 * Focus command.
 * 'auto'   → autofocus on
 * 'manual' → autofocus off (manual focus mode)
 * 'far'    → focus drive far (in manual mode)
 * 'near'   → focus drive near (in manual mode)
 * 'stop'   → stop focus drive
 */
function focusCommand(cameraId: number, mode: 'auto' | 'manual' | 'near' | 'far' | 'stop'): number[] {
  const addr = 0x80 | cameraId;
  if (mode === 'auto')   return [addr, 0x01, 0x04, 0x38, 0x02, 0xFF];
  if (mode === 'manual') return [addr, 0x01, 0x04, 0x38, 0x03, 0xFF];
  if (mode === 'far')    return [addr, 0x01, 0x04, 0x08, 0x02, 0xFF];
  if (mode === 'near')   return [addr, 0x01, 0x04, 0x08, 0x03, 0xFF];
  /* stop */             return [addr, 0x01, 0x04, 0x08, 0x00, 0xFF];
}

/**
 * Preset command.
 * action: 'recall' or 'save'
 * preset: 0-based preset index (0–254)
 */
function presetCommand(cameraId: number, action: 'recall' | 'save', preset: number): number[] {
  const addr = 0x80 | cameraId;
  const mode = action === 'recall' ? 0x02 : 0x01;
  return [addr, 0x01, 0x04, 0x3F, mode, preset & 0xFF, 0xFF];
}

/** Return-to-home position command. */
function homeCommand(cameraId: number): number[] {
  const addr = 0x80 | cameraId;
  return [addr, 0x01, 0x06, 0x04, 0xFF];
}

// ── UDP socket management ─────────────────────────────────────────────────────

let sock: dgram.Socket | null = null;
let seqNum = 1;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wantConnected = false;

const RECONNECT_DELAY_MS = 5000;

function nextSeq(): number {
  const n = seqNum;
  seqNum = (seqNum + 1) >>> 0; // wrap at uint32
  if (seqNum === 0) seqNum = 1;
  return n;
}

function sendCommand(payload: number[]): void {
  if (!sock) return;
  const cfg = config.ptz;
  const packet = buildViscaPacket(nextSeq(), payload);
  sock.send(packet, cfg.port, cfg.address, (err) => {
    if (err) logger.error('[PTZ] Send error:', err.message);
  });
}

function doConnect(): void {
  if (!wantConnected) return;
  const cfg = config.ptz;
  if (!cfg.enabled) return;

  sock = dgram.createSocket('udp4');

  sock.on('error', (err) => {
    logger.error('[PTZ] Socket error:', err.message);
    cleanup();
    scheduleReconnect();
  });

  sock.on('message', (_msg) => {
    // VISCA ACK/completion responses — no action needed for control commands
  });

  sock.bind(0, () => {
    logger.log(`[PTZ] Connected to ${cfg.address}:${cfg.port}`);
    state.update('ptz', {
      connected: true,
      presets: Array.from({ length: cfg.numPresets }, (_, i) => i),
    });
  });
}

function cleanup(): void {
  if (sock) {
    try { sock.close(); } catch (_) {}
    sock = null;
  }
  state.update('ptz', { connected: false });
}

function scheduleReconnect(): void {
  if (!wantConnected) return;
  reconnectTimer = setTimeout(doConnect, RECONNECT_DELAY_MS);
}

// ── Public API ────────────────────────────────────────────────────────────────

function connect(): void {
  wantConnected = true;
  if (!config.ptz.enabled) return;
  doConnect();
}

function disconnect(): void {
  wantConnected = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  cleanup();
}

function panTilt(pan: -1 | 0 | 1, tilt: -1 | 0 | 1, panSpeed = 12, tiltSpeed = 10): void {
  sendCommand(panTiltCommand(config.ptz.cameraId, pan, tilt, panSpeed, tiltSpeed));
}

function zoom(direction: 'in' | 'out' | 'stop', speed = 3): void {
  sendCommand(zoomCommand(config.ptz.cameraId, direction, speed));
}

function focus(mode: 'auto' | 'manual' | 'near' | 'far' | 'stop'): void {
  sendCommand(focusCommand(config.ptz.cameraId, mode));
}

function preset(action: 'recall' | 'save', presetIndex: number): void {
  sendCommand(presetCommand(config.ptz.cameraId, action, presetIndex));
}

function home(): void {
  sendCommand(homeCommand(config.ptz.cameraId));
}

export = {
  connect,
  disconnect,
  panTilt,
  zoom,
  focus,
  preset,
  home,
  // Pure command builders — exported for unit tests
  buildViscaPacket,
  panTiltCommand,
  zoomCommand,
  focusCommand,
  presetCommand,
  homeCommand,
};
