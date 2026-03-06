'use strict';

import childProcess = require('child_process');
import fs = require('fs');
import path = require('path');
import logger = require('./logger');
import type { ChangeEvent } from './types';

const { spawn, exec } = childProcess;

function startTray(
  port: number,
  state: { on: (event: 'change', listener: (ev: ChangeEvent) => void) => void },
  shutdown: () => void
): void {
  logger.log(`[Tray] startTray called (platform: ${process.platform})`);

  if (process.platform !== 'win32') {
    logger.log('[Tray] Not Windows — skipping system tray');
    return;
  }

  // When running as a compiled binary, tray.ps1 is placed next to the executable.
  // Fall back to __dirname (baked-in source path) for development (`bun start`).
  const nextToExe = path.join(path.dirname(process.execPath), 'tray.ps1');
  const ps1 = fs.existsSync(nextToExe) ? nextToExe : path.join(__dirname, 'tray.ps1');
  logger.log(`[Tray] Spawning PowerShell tray script: ${ps1}`);

  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-File', ps1,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  logger.log(`[Tray] PowerShell process spawned (pid: ${child.pid ?? 'unknown'})`);

  child.on('error', (err: Error) => logger.warn('[Tray] Failed to start PowerShell:', err.message));

  child.on('exit', (code: number | null, signal: string | null) => {
    logger.log(`[Tray] PowerShell process exited (code: ${code}, signal: ${signal})`);
  });

  // Capture and log PowerShell stderr so errors appear in the log file
  let errBuf = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    errBuf += chunk.toString();
    const lines = errBuf.split('\n');
    errBuf = lines.pop()!;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Diagnostic lines from tray.ps1 start with '[Tray]'; everything else is an unexpected PS error
      if (trimmed.startsWith('[Tray]')) {
        logger.log('[Tray] PS:', trimmed);
      } else {
        logger.warn('[Tray] PS error:', trimmed);
      }
    }
  });

  // Parse newline-delimited JSON events from the tray process
  let buf = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop()!; // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logger.log(`[Tray] Received: ${trimmed}`);
      let msg: { event?: string };
      try { msg = JSON.parse(trimmed); } catch {
        logger.warn('[Tray] Failed to parse tray message:', trimmed);
        continue;
      }
      if (msg.event === 'open') {
        logger.log('[Tray] Opening browser');
        exec(`start http://localhost:${port}`);
      } else if (msg.event === 'exit') {
        logger.log('[Tray] Exit requested from tray — shutting down');
        shutdown();
      } else {
        logger.warn('[Tray] Unknown event from tray:', trimmed);
      }
    }
  });

  function send(obj: unknown): void {
    if (!child.killed && child.exitCode === null) {
      try {
        child.stdin!.write(JSON.stringify(obj) + '\n');
      } catch (err: unknown) {
        logger.warn('[Tray] Failed to write to tray process:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Update the status item whenever any connection state changes
  state.on('change', ({ state: s }: ChangeEvent) => {
    const obs  = s.obs.connected      ? 'OBS:on'  : 'OBS:off';
    const x32  = s.x32.connected      ? 'X32:on'  : 'X32:off';
    const midi = s.proclaim.connected ? 'MIDI:on' : 'MIDI:off';
    send({ cmd: 'status', text: `${obs}  ${x32}  ${midi}` });
  });

  // Kill the tray process when the server exits
  process.on('exit', () => {
    if (!child.killed) send({ cmd: 'exit' });
  });
}

export = { startTray };
