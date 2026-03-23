import dgram = require('dgram');
import config = require('../config');
import state = require('../state');
import logger = require('../logger');
import type { PtzCameraState } from '../types';

// ── VISCA/IP helpers (exported for unit tests) ────────────────────────────────

/**
 * Wraps a VISCA payload in an 8-byte VISCA/IP UDP header.
 * [0-1] Payload type 0x0100  [2-3] Payload length  [4-7] Sequence number
 */
function buildViscaPacket(seqNum: number, payload: number[]): Buffer {
  const buf = Buffer.alloc(8 + payload.length);
  buf[0] = 0x01; buf[1] = 0x00;
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(seqNum, 4);
  for (let i = 0; i < payload.length; i++) buf[8 + i] = payload[i];
  return buf;
}

/**
 * Encodes a signed 16-bit integer as 4 VISCA nibbles.
 * Example: 880 (0x0370) → [0, 3, 7, 0]; -1 (0xFFFF) → [F, F, F, F]
 */
function encodePos(value: number): number[] {
  const v = value & 0xFFFF;
  return [(v >> 12) & 0xF, (v >> 8) & 0xF, (v >> 4) & 0xF, v & 0xF];
}

/**
 * Decodes 4 VISCA nibbles as a signed 16-bit integer.
 */
function decodePos(nibbles: number[]): number {
  const v = (nibbles[0] << 12) | (nibbles[1] << 8) | (nibbles[2] << 4) | nibbles[3];
  return v >= 0x8000 ? v - 0x10000 : v;
}

// ── Pure command builders ─────────────────────────────────────────────────────

/**
 * Absolute Pan/Tilt Position command (go-to style, no runaway on lost packets).
 * pan/tilt: VISCA position units (signed 16-bit, 0 = center)
 * panSpeed: 1–24, tiltSpeed: 1–20
 */
function absPanTiltCommand(cameraId: number, pan: number, tilt: number, panSpeed: number, tiltSpeed: number): number[] {
  const addr = 0x80 | cameraId;
  const vv = Math.max(1, Math.min(24, panSpeed));
  const ww = Math.max(1, Math.min(20, tiltSpeed));
  return [addr, 0x01, 0x06, 0x02, vv, ww, ...encodePos(pan), ...encodePos(tilt), 0xFF];
}

/**
 * Absolute Zoom Position command (go-to style).
 * zoom: 0 (wide) to 16384 (tele)
 */
function absZoomCommand(cameraId: number, zoom: number): number[] {
  const addr = 0x80 | cameraId;
  const z = Math.max(0, Math.min(16384, zoom));
  return [addr, 0x01, 0x04, 0x47, ...encodePos(z), 0xFF];
}

/** Pan/Tilt Position Inquiry — camera responds with current pan + tilt. */
function panTiltInquiry(cameraId: number): number[] {
  return [0x80 | cameraId, 0x09, 0x06, 0x12, 0xFF];
}

/** Zoom Position Inquiry — camera responds with current zoom. */
function zoomInquiry(cameraId: number): number[] {
  return [0x80 | cameraId, 0x09, 0x04, 0x47, 0xFF];
}

/** Focus mode / drive command. 'stop' halts a near/far drive. */
function focusCommand(cameraId: number, mode: 'auto' | 'manual' | 'near' | 'far' | 'stop'): number[] {
  const addr = 0x80 | cameraId;
  if (mode === 'auto')   return [addr, 0x01, 0x04, 0x38, 0x02, 0xFF];
  if (mode === 'manual') return [addr, 0x01, 0x04, 0x38, 0x03, 0xFF];
  if (mode === 'far')    return [addr, 0x01, 0x04, 0x08, 0x02, 0xFF];
  if (mode === 'near')   return [addr, 0x01, 0x04, 0x08, 0x03, 0xFF];
  /* stop */             return [addr, 0x01, 0x04, 0x08, 0x00, 0xFF];
}

/** Preset recall (0x02) or save (0x01). Preset index is 0-based. */
function presetCommand(cameraId: number, action: 'recall' | 'save', preset: number): number[] {
  const addr = 0x80 | cameraId;
  return [addr, 0x01, 0x04, 0x3F, action === 'recall' ? 0x02 : 0x01, preset & 0xFF, 0xFF];
}

/** Return to home position. */
function homeCommand(cameraId: number): number[] {
  return [0x80 | cameraId, 0x01, 0x06, 0x04, 0xFF];
}

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Extract the VISCA payload from a received buffer.
 * Handles both VISCA/IP (8-byte header) and raw VISCA.
 */
function extractPayload(msg: Buffer): Buffer {
  // VISCA/IP response header starts with 0x01 0x11 (type = response)
  if (msg.length >= 8 && msg[0] === 0x01 && msg[1] === 0x11) {
    return msg.subarray(8);
  }
  return msg;
}

function extractSeqNum(msg: Buffer): number | null {
  if (msg.length >= 8 && msg[0] === 0x01 && msg[1] === 0x11) {
    return msg.readUInt32BE(4);
  }
  return null;
}

function parsePanTiltResponse(msg: Buffer): { pan: number; tilt: number } | null {
  const p = extractPayload(msg);
  // 90 50 0p 0q 0r 0s 0t 0u 0v 0w FF (11 bytes minimum)
  if (p.length < 11 || p[0] !== 0x90 || p[1] !== 0x50) return null;
  return {
    pan:  decodePos([p[2], p[3], p[4], p[5]]),
    tilt: decodePos([p[6], p[7], p[8], p[9]]),
  };
}

function parseZoomResponse(msg: Buffer): number | null {
  const p = extractPayload(msg);
  // 90 50 0p 0q 0r 0s FF (7 bytes minimum)
  if (p.length < 7 || p[0] !== 0x90 || p[1] !== 0x50) return null;
  return decodePos([p[2], p[3], p[4], p[5]]);
}

// ── Per-camera connection ─────────────────────────────────────────────────────

type InquiryHandler = (msg: Buffer) => void;

interface CameraConn {
  idx: number;
  socket: dgram.Socket | null;
  seqNum: number;
  pending: Map<number, InquiryHandler>;
  pan: number | null;
  tilt: number | null;
  zoom: number | null;
  focusStopTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  positionTimer: ReturnType<typeof setInterval> | null;
  wantConnected: boolean;
}

const RECONNECT_MS = 5000;
const POSITION_POLL_MS = 15000; // re-sync position every 15 s
const FOCUS_AUTO_STOP_MS = 500; // auto-stop focus drive if no refresh arrives

let cameras: CameraConn[] = [];
let wantConnectedGlobal = false;

function makeCameraConn(idx: number): CameraConn {
  return {
    idx,
    socket: null,
    seqNum: 1,
    pending: new Map(),
    pan: null,
    tilt: null,
    zoom: null,
    focusStopTimer: null,
    reconnectTimer: null,
    positionTimer: null,
    wantConnected: false,
  };
}

function nextSeq(cam: CameraConn): number {
  const n = cam.seqNum;
  cam.seqNum = ((cam.seqNum + 1) >>> 0) || 1;
  return n;
}

function updateCameraState(cam: CameraConn, patch: Partial<PtzCameraState>): void {
  const currentCameras = state.get().ptz.cameras;
  const updated = currentCameras.map((c, i) => i === cam.idx ? { ...c, ...patch } : c);
  state.update('ptz', { cameras: updated });
}

function sendPacket(cam: CameraConn, payload: number[], seq?: number): void {
  if (!cam.socket) return;
  const cfg = config.ptz.cameras[cam.idx];
  const s = seq ?? nextSeq(cam);
  const pkt = buildViscaPacket(s, payload);
  cam.socket.send(pkt, cfg.port, cfg.address, (err) => {
    if (err) logger.error(`[PTZ cam${cam.idx}] Send error:`, err.message);
  });
}

function sendInquiry(cam: CameraConn, payload: number[], handler: InquiryHandler): void {
  const seq = nextSeq(cam);
  cam.pending.set(seq, handler);
  // Remove pending entry after timeout so stale entries don't accumulate
  setTimeout(() => cam.pending.delete(seq), 2000);
  sendPacket(cam, payload, seq);
}

function queryPosition(cam: CameraConn): void {
  if (!cam.socket) return;
  const cfg = config.ptz.cameras[cam.idx];

  sendInquiry(cam, panTiltInquiry(cfg.cameraId), (msg) => {
    const pos = parsePanTiltResponse(msg);
    if (!pos) return;
    cam.pan = pos.pan;
    cam.tilt = pos.tilt;
  });

  sendInquiry(cam, zoomInquiry(cfg.cameraId), (msg) => {
    const z = parseZoomResponse(msg);
    if (z !== null) cam.zoom = z;
  });
}

function cleanupCamera(cam: CameraConn): void {
  if (cam.focusStopTimer) { clearTimeout(cam.focusStopTimer); cam.focusStopTimer = null; }
  if (cam.positionTimer)  { clearInterval(cam.positionTimer); cam.positionTimer = null; }
  cam.pending.clear();
  if (cam.socket) {
    try { cam.socket.close(); } catch (_) {}
    cam.socket = null;
  }
  cam.pan = null;
  cam.tilt = null;
  cam.zoom = null;
  updateCameraState(cam, { connected: false });
}

function scheduleReconnect(cam: CameraConn): void {
  if (!cam.wantConnected) return;
  cam.reconnectTimer = setTimeout(() => doConnectCamera(cam), RECONNECT_MS);
}

function doConnectCamera(cam: CameraConn): void {
  if (!cam.wantConnected) return;
  const cfg = config.ptz.cameras[cam.idx];
  if (!cfg?.enabled) return;

  const sock = dgram.createSocket('udp4');
  cam.socket = sock;

  sock.on('error', (err) => {
    logger.error(`[PTZ cam${cam.idx}] Socket error:`, err.message);
    cleanupCamera(cam);
    scheduleReconnect(cam);
  });

  sock.on('message', (msg: Buffer) => {
    const seqNum = extractSeqNum(msg);
    if (seqNum !== null) {
      const handler = cam.pending.get(seqNum);
      if (handler) {
        cam.pending.delete(seqNum);
        handler(msg);
      }
    }
  });

  sock.bind(0, () => {
    logger.log(`[PTZ cam${cam.idx}] Connected to ${cfg.address}:${cfg.port}`);
    updateCameraState(cam, {
      connected: true,
      presets: Array.from({ length: cfg.numPresets }, (_, i) => i),
    });

    // Query current position so go-to commands have a valid starting point
    queryPosition(cam);

    // Periodic position re-sync (camera might be moved externally)
    cam.positionTimer = setInterval(() => queryPosition(cam), POSITION_POLL_MS);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function connect(): void {
  wantConnectedGlobal = true;
  const cfgs = config.ptz.cameras;

  // Ensure we have the right number of camera connection objects
  while (cameras.length < cfgs.length) cameras.push(makeCameraConn(cameras.length));

  // Initialise state array if needed
  const currentCams = state.get().ptz.cameras;
  if (currentCams.length !== cfgs.length) {
    state.update('ptz', {
      cameras: cfgs.map((cfg, i) => ({
        ...(currentCams[i] ?? { connected: false, pan: null, tilt: null, zoom: null, presets: [] }),
        name: cfg.name,
      })),
    });
  }

  cameras.forEach((cam, i) => {
    cam.wantConnected = true;
    if (cfgs[i]?.enabled) doConnectCamera(cam);
  });
}

function disconnect(): void {
  wantConnectedGlobal = false;
  cameras.forEach((cam) => {
    cam.wantConnected = false;
    if (cam.reconnectTimer) { clearTimeout(cam.reconnectTimer); cam.reconnectTimer = null; }
    cleanupCamera(cam);
  });
}

/**
 * Step the camera by one pan/tilt increment (go-to style).
 * panDir: -1 = left, 0 = no pan, 1 = right
 * tiltDir: -1 = down, 0 = no tilt, 1 = up
 * Each call moves by cfg.panStep / tiltStep units.
 */
function panTilt(camera: number, panDir: -1 | 0 | 1, tiltDir: -1 | 0 | 1, panSpeed?: number, tiltSpeed?: number): void {
  const cam = cameras[camera];
  if (!cam?.socket) return;

  const cfg = config.ptz.cameras[camera];
  const [panMin, panMax]   = cfg.panRange;
  const [tiltMin, tiltMax] = cfg.tiltRange;

  const newPan  = Math.max(panMin,  Math.min(panMax,  (cam.pan  ?? 0) + panDir  * cfg.panStep));
  const newTilt = Math.max(tiltMin, Math.min(tiltMax, (cam.tilt ?? 0) + tiltDir * cfg.tiltStep));
  cam.pan  = newPan;
  cam.tilt = newTilt;

  sendPacket(cam, absPanTiltCommand(cfg.cameraId, newPan, newTilt,
    Math.max(1, Math.min(24, panSpeed ?? 12)),
    Math.max(1, Math.min(20, tiltSpeed ?? 10)),
  ));
}

/**
 * Step zoom in or out by one increment (go-to style, no stop command needed).
 */
function zoom(camera: number, direction: 'in' | 'out'): void {
  const cam = cameras[camera];
  if (!cam?.socket) return;

  const cfg = config.ptz.cameras[camera];
  const [zoomMin, zoomMax] = cfg.zoomRange;

  const delta   = direction === 'in' ? cfg.zoomStep : -cfg.zoomStep;
  const newZoom = Math.max(zoomMin, Math.min(zoomMax, (cam.zoom ?? 0) + delta));
  cam.zoom = newZoom;

  sendPacket(cam, absZoomCommand(cfg.cameraId, newZoom));
}

/**
 * Focus control.
 * 'auto' / 'manual' are mode switches (idempotent, no stop needed).
 * 'near' / 'far' are drive commands — a server-side 500 ms auto-stop is
 * scheduled so the camera stops even if the client goes away.
 * Repeated calls before the timer fires simply refresh the deadline.
 */
function focus(camera: number, mode: 'auto' | 'manual' | 'near' | 'far'): void {
  const cam = cameras[camera];
  if (!cam?.socket) return;

  const cameraId = config.ptz.cameras[camera].cameraId;

  if (cam.focusStopTimer) { clearTimeout(cam.focusStopTimer); cam.focusStopTimer = null; }

  sendPacket(cam, focusCommand(cameraId, mode));

  if (mode === 'near' || mode === 'far') {
    cam.focusStopTimer = setTimeout(() => {
      sendPacket(cam, focusCommand(cameraId, 'stop'));
      cam.focusStopTimer = null;
    }, FOCUS_AUTO_STOP_MS);
  }
}

/**
 * Recall or save a preset. After recall the position is re-queried so the
 * go-to position model stays in sync.
 */
function preset(camera: number, action: 'recall' | 'save', presetIndex: number): void {
  const cam = cameras[camera];
  if (!cam?.socket) return;

  const cameraId = config.ptz.cameras[camera].cameraId;
  sendPacket(cam, presetCommand(cameraId, action, presetIndex));

  // After recall, camera moves to the preset position — re-sync our model
  if (action === 'recall') {
    cam.pan = null;
    cam.tilt = null;
    cam.zoom = null;
    setTimeout(() => queryPosition(cam), 1500);
  }
}

/** Move to home position and reset the position model. */
function home(camera: number): void {
  const cam = cameras[camera];
  if (!cam?.socket) return;

  const cameraId = config.ptz.cameras[camera].cameraId;
  sendPacket(cam, homeCommand(cameraId));
  cam.pan = 0;
  cam.tilt = 0;
}

export = {
  connect,
  disconnect,
  panTilt,
  zoom,
  focus,
  preset,
  home,
  // Pure helpers exported for unit tests
  buildViscaPacket,
  encodePos,
  decodePos,
  absPanTiltCommand,
  absZoomCommand,
  panTiltInquiry,
  zoomInquiry,
  focusCommand,
  presetCommand,
  homeCommand,
};
