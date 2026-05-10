import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as logger from './logger';

const SERVICE_NAME = 'ServiceRemote';
const SERVICE_DISPLAY = 'Service Remote';
const SERVICE_DESC = 'Church service AV control panel (OBS, X32, Proclaim)';

// PowerShell wrapper that handles the SCM handshake via inline C#.
// Registered as the service binPath so SCM gets a proper SERVICE_RUNNING signal.
// The actual exe is passed as the first argument and launched as a child process.
// SCM stop → child is killed → SERVICE_STOPPED signalled.
const WRAPPER_PS1 = `
param([string]$ExePath)

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.ServiceProcess;
using System.Threading;

public class ServiceRemoteHost : ServiceBase {
    private Process _child;
    private string  _exePath;

    public ServiceRemoteHost(string exePath) {
        ServiceName = "ServiceRemote";
        _exePath    = exePath;
    }

    protected override void OnStart(string[] args) {
        var psi = new ProcessStartInfo(_exePath) {
            UseShellExecute        = false,
            CreateNoWindow         = true,
        };
        _child = Process.Start(psi);
    }

    protected override void OnStop() {
        try {
            if (_child != null && !_child.HasExited) {
                _child.Kill();
                _child.WaitForExit(5000);
            }
        } catch {}
    }

    public static void Main(string[] exePath) {
        ServiceBase.Run(new ServiceRemoteHost(exePath[0]));
    }
}
'@ -ReferencedAssemblies System.ServiceProcess

[ServiceRemoteHost]::Main(@($ExePath))
`;

// Stable install location — %LOCALAPPDATA%\ServiceRemote\
function getInstallDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os().homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'ServiceRemote');
}

function getInstallPath(): string {
  return path.join(getInstallDir(), 'service-remote.exe');
}

function getLogPath(): string {
  return path.join(getInstallDir(), 'install.log');
}

// Lazy import — os is only needed on Windows at runtime.
function os() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('os') as typeof import('os');
}

function appendLog(logPath: string, message: string): void {
  const ts = new Date().toISOString();
  fs.appendFileSync(logPath, `[${ts}] ${message}\n`, 'utf8');
}

export function handleServiceArgs(): 'install' | 'uninstall' | null {
  const args = process.argv.slice(2);
  if (args.includes('--install-service')) return 'install';
  if (args.includes('--uninstall-service')) return 'uninstall';
  return null;
}

function runPs1(script: string): void {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded,
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
}

// Escape a Windows path for embedding in a PowerShell double-quoted string.
function psEscape(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function installService(exePath: string, port = 3000): void {
  logger.log(`[Service] Installing Windows service "${SERVICE_NAME}" …`);

  const installDir   = getInstallDir();
  const installPath  = getInstallPath();
  const wrapperPath  = path.join(installDir, 'wrapper.ps1');
  const logPath      = getLogPath();

  // Both files are writable without elevation (LOCALAPPDATA).
  // Copy before elevating so the running exe is never the install target.
  fs.mkdirSync(installDir, { recursive: true });
  appendLog(logPath, `--- install started (source: ${exePath}) ---`);
  appendLog(logPath, `Copying exe to ${installPath} …`);
  fs.copyFileSync(exePath, installPath);
  appendLog(logPath, 'Writing wrapper.ps1 …');
  fs.writeFileSync(wrapperPath, WRAPPER_PS1, 'utf8');
  appendLog(logPath, 'Files written. Requesting elevation …');

  const safeInstallPath = psEscape(installPath);
  const safeWrapperPath = psEscape(wrapperPath);
  const safeLogPath     = psEscape(logPath);

  // Helper embedded in the script so both the non-elevated and elevated
  // instances can write timestamped entries to the same log file.
  const logFn = `
function Write-Log {
    param([string]$msg)
    $ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    $entry = "[$ts] $msg"
    Write-Host $entry
    Add-Content -Path "${safeLogPath}" -Value $entry -Encoding UTF8
}
`;

  // The service binPath runs PowerShell with the wrapper script.
  // PowerShell's inline C# handles the SCM handshake (SERVICE_RUNNING/STOPPED)
  // and launches the real exe as a child process.
  const script = `
${logFn}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Log "Not elevated — relaunching with administrator privileges …"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($MyInvocation.MyCommand.ScriptBlock.ToString()))
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    exit
}

Write-Log "Running as administrator."

$name    = "${SERVICE_NAME}"
$display = "${SERVICE_DISPLAY}"
$desc    = "${SERVICE_DESC}"
$exe     = "${safeInstallPath}"
$wrapper = "${safeWrapperPath}"
$ps      = (Get-Command powershell.exe).Source
$bin     = '"' + $ps + '" -NonInteractive -ExecutionPolicy Bypass -File "' + $wrapper + '" -ExePath "' + $exe + '"'

$existing = & sc.exe query $name 2>&1
$exists = $LASTEXITCODE -eq 0

if ($exists) {
    Write-Log "Service $name already exists — upgrading …"
    Write-Log "Stopping service …"
    $out = & sc.exe stop $name 2>&1; Write-Log ($out -join ' ')
    Start-Sleep -Seconds 3
    Write-Log "Updating service binPath …"
    $out = & sc.exe config $name binPath= $bin start= auto DisplayName= $display 2>&1; Write-Log ($out -join ' ')
} else {
    Write-Log "Creating service $name …"
    $out = & sc.exe create $name binPath= $bin start= auto DisplayName= $display 2>&1; Write-Log ($out -join ' ')
    $out = & sc.exe description $name $desc 2>&1; Write-Log ($out -join ' ')
}

Write-Log "Starting service …"
$out = & sc.exe start $name 2>&1; Write-Log ($out -join ' ')

# Wait up to 15 s for the service to reach Running state
$waited = 0
do {
    Start-Sleep -Seconds 1
    $waited++
    $status = (Get-Service -Name $name -ErrorAction SilentlyContinue).Status
} while ($status -ne 'Running' -and $waited -lt 15)

$finalStatus = (Get-Service -Name $name -ErrorAction SilentlyContinue).Status
Write-Log "Service status: $finalStatus"

# Discover the LAN address to show the URL
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169)' } | Select-Object -First 1).IPAddress
$url = if ($ip) { "http://$($ip):${port}" } else { "http://localhost:${port}" }
Write-Log "Control panel URL: $url"
Write-Log "Install log: ${safeLogPath}"
Write-Log "--- install complete ---"

# Open a visible summary window so the user sees the result even though
# the original (non-elevated) console is gone.
$summary = @"
==============================================
  Service Remote — install complete
==============================================
  Status : $finalStatus
  URL    : $url
  Log    : ${safeLogPath}

  To uninstall: service-remote.exe --uninstall-service
==============================================
"@
Write-Host ""
Write-Host $summary
Start-Sleep -Seconds 8
`;

  runPs1(script);
}

export function uninstallService(): void {
  logger.log(`[Service] Uninstalling Windows service "${SERVICE_NAME}" …`);

  const logPath     = getLogPath();
  const safeLogPath = psEscape(logPath);

  const logFn = `
function Write-Log {
    param([string]$msg)
    $ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    $entry = "[$ts] $msg"
    Write-Host $entry
    Add-Content -Path "${safeLogPath}" -Value $entry -Encoding UTF8
}
`;

  const script = `
${logFn}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Log "Not elevated — relaunching with administrator privileges …"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($MyInvocation.MyCommand.ScriptBlock.ToString()))
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    exit
}

Write-Log "Running as administrator."
$name = "${SERVICE_NAME}"
Write-Log "Stopping service $name …"
$out = & sc.exe stop $name 2>&1; Write-Log ($out -join ' ')
Start-Sleep -Seconds 2
Write-Log "Deleting service $name …"
$out = & sc.exe delete $name 2>&1; Write-Log ($out -join ' ')
Write-Log "--- uninstall complete ---"
Write-Host ""
Write-Host "Done. Service '$name' removed."
Write-Host "Log: ${safeLogPath}"
Start-Sleep -Seconds 3
`;

  runPs1(script);
}
