'use strict';

import childProcess = require('child_process');
import logger = require('./logger');
import type { ChangeEvent } from './types';

const { spawn, exec } = childProcess;

// PS1 script embedded at compile time — no external file needed at runtime.
// PowerShell reads it via -EncodedCommand (UTF-16LE base64), leaving stdin
// free for the JSON IPC channel used to send status/exit commands.
const TRAY_SCRIPT = `\
# tray.ps1 — Windows system tray host for service-remote
# Communicates with the Node.js parent via stdin/stdout JSON lines.
#
# stdin commands (JSON):
#   { "cmd": "status", "text": "OBS:on  X32:off  MIDI:on" }
#   { "cmd": "exit" }
#
# stdout events (JSON):
#   { "event": "open" }
#   { "event": "exit" }

[Console]::Error.WriteLine('[Tray] PowerShell tray script starting')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[Console]::Error.WriteLine('[Tray] Assemblies loaded')

# Build a 16x16 solid-blue bitmap as the tray icon (no external file needed)
function New-TrayIcon {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(0, 87, 166))
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$icon = New-TrayIcon
[Console]::Error.WriteLine('[Tray] Tray icon created')

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = 'service-remote'
$tray.Visible = $true
[Console]::Error.WriteLine('[Tray] Tray icon set visible')

# Context menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = 'OBS:off  X32:off  MIDI:off'
$statusItem.Enabled = $false
$null = $menu.Items.Add($statusItem)

$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = 'Open in Browser'
$openItem.add_Click({
    [Console]::Out.WriteLine('{"event":"open"}')
    [Console]::Out.Flush()
})
$null = $menu.Items.Add($openItem)

$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = 'Exit'
$exitItem.add_Click({
    [Console]::Out.WriteLine('{"event":"exit"}')
    [Console]::Out.Flush()
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$null = $menu.Items.Add($exitItem)

$tray.ContextMenuStrip = $menu
[Console]::Error.WriteLine('[Tray] Context menu configured')

# Double-click also opens the browser
$tray.add_DoubleClick({
    [Console]::Out.WriteLine('{"event":"open"}')
    [Console]::Out.Flush()
})

# Read stdin commands on a background thread so the message pump stays responsive
$stdin = [Console]::In
$scriptBlock = {
    param($stdin, $statusItem, $tray, $menu)
    [Console]::Error.WriteLine('[Tray] stdin reader thread started')
    while ($true) {
        $line = $stdin.ReadLine()
        if ($null -eq $line) { break }
        $line = $line.Trim()
        if ($line -eq '') { continue }
        # [Console]::Error.WriteLine("[Tray] stdin command: $line")
        try {
            $msg = $line | ConvertFrom-Json
        } catch { continue }

        if ($msg.cmd -eq 'status') {
            # Marshal UI update back to the UI thread
            $tray.ContextMenuStrip.Invoke([Action]{
                $statusItem.Text = $msg.text
                $tray.Text = "service-remote — $($msg.text)"
            })
        } elseif ($msg.cmd -eq 'exit') {
            $tray.Visible = $false
            [System.Windows.Forms.Application]::Exit()
            break
        }
    }
    # stdin closed — parent process gone
    [Console]::Error.WriteLine('[Tray] stdin closed — exiting')
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
}

# Use a RunspacePool so we get a proper STA-compatible background thread
$rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
$rs.ApartmentState = 'MTA'
$rs.Open()
$ps = [System.Management.Automation.PowerShell]::Create()
$ps.Runspace = $rs
$null = $ps.AddScript($scriptBlock).AddArgument($stdin).AddArgument($statusItem).AddArgument($tray).AddArgument($menu)
$null = $ps.BeginInvoke()

[Console]::Error.WriteLine('[Tray] Starting Windows Forms message loop')
[System.Windows.Forms.Application]::Run()

$rs.Close()
$tray.Dispose()
[Console]::Error.WriteLine('[Tray] Message loop exited — script done')
`;

function startTray(
  port: number,
  version: string,
  state: { on: (event: 'change', listener: (ev: ChangeEvent) => void) => void },
  shutdown: () => void
): void {
  logger.log(`[Tray] startTray called (platform: ${process.platform})`);

  if (process.platform !== 'win32') {
    logger.log('[Tray] Not Windows — skipping system tray');
    return;
  }

  // Encode the embedded script as UTF-16LE base64 for PowerShell -EncodedCommand.
  // This leaves stdin free for the JSON IPC channel.
  const encoded = Buffer.from(TRAY_SCRIPT, 'utf16le').toString('base64');
  logger.log('[Tray] Spawning PowerShell tray script (embedded)');

  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded,
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
      } else if (trimmed === '#< CLIXML') {
        // PowerShell prepends this XML preamble to its structured error stream — harmless, ignore it
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
    const obs      = s.obs.connected      ? 'OBS:on'      : 'OBS:off';
    const x32      = s.x32.connected      ? 'X32:on'      : 'X32:off';
    const proclaim = s.proclaim.connected ? 'Proclaim:on' : 'Proclaim:off';
    send({ cmd: 'status', text: `v${version}  ${obs}  ${x32}  ${proclaim}` });
  });

  // Kill the tray process when the server exits
  process.on('exit', () => {
    if (!child.killed) send({ cmd: 'exit' });
  });
}

export = { startTray };
