'use strict';

const { spawn, exec } = require('child_process');
const path = require('path');

function startTray(port, state) {
  if (process.platform !== 'win32') return;

  const ps1 = path.join(__dirname, 'tray.ps1');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-File', ps1,
  ], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  child.on('error', err => console.warn('[Tray] failed to start PowerShell:', err.message));

  // Parse newline-delimited JSON events from the tray process
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      if (msg.event === 'open') {
        exec(`start http://localhost:${port}`);
      } else if (msg.event === 'exit') {
        process.exit(0);
      }
    }
  });

  function send(obj) {
    if (!child.killed) {
      child.stdin.write(JSON.stringify(obj) + '\n');
    }
  }

  // Update the status item whenever any connection state changes
  state.on('change', ({ state: s }) => {
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

module.exports = { startTray };
