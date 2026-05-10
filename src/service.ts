import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as logger from './logger';

const SERVICE_NAME = 'ServiceRemote';
const SERVICE_DISPLAY = 'Service Remote';
const SERVICE_DESC = 'Church service AV control panel (OBS, X32, Proclaim)';

// C# source for the service host compiled to an exe at install time.
// Compiled once with Add-Type -OutputAssembly so SCM starts a native exe
// with no runtime compilation delay — eliminating the 1053 startup timeout.
const SERVICE_HOST_CS = `
using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

public class ServiceRemoteHost : ServiceBase {
    private Process _child;
    private readonly string _exePath;
    private readonly string _logPath;

    public ServiceRemoteHost(string exePath, string logPath) {
        ServiceName = "ServiceRemote";
        _exePath    = exePath;
        _logPath    = logPath;
    }

    private void Log(string msg) {
        try {
            var entry = "[" + DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss") + "] " + msg;
            File.AppendAllText(_logPath, entry + Environment.NewLine);
        } catch {}
    }

    protected override void OnStart(string[] args) {
        Log("OnStart: launching " + _exePath);
        try {
            var psi = new ProcessStartInfo(_exePath) {
                UseShellExecute = false,
                CreateNoWindow  = true,
            };
            _child = Process.Start(psi);
            Log("OnStart: child pid " + (_child != null ? _child.Id.ToString() : "null"));
        } catch (Exception ex) {
            Log("OnStart error: " + ex.Message);
            throw;
        }
    }

    protected override void OnStop() {
        Log("OnStop: killing child");
        try {
            if (_child != null && !_child.HasExited) {
                _child.Kill();
                _child.WaitForExit(5000);
            }
        } catch (Exception ex) {
            Log("OnStop error: " + ex.Message);
        }
        Log("OnStop: done");
    }

    public static void Main(string[] args) {
        if (args.Length < 2) return;
        ServiceBase.Run(new ServiceRemoteHost(args[0], args[1]));
    }
}
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

  const installDir    = getInstallDir();
  const installPath   = getInstallPath();
  const hostSrcPath   = path.join(installDir, 'service-host.cs');
  const hostExePath   = path.join(installDir, 'service-host.exe');
  const logPath       = getLogPath();

  // All writable without elevation (LOCALAPPDATA).
  // Copy/write before elevating so the running exe is never the install target.
  fs.mkdirSync(installDir, { recursive: true });
  appendLog(logPath, `--- install started (source: ${exePath}) ---`);
  appendLog(logPath, `Copying exe to ${installPath} …`);
  fs.copyFileSync(exePath, installPath);
  appendLog(logPath, 'Writing service-host.cs …');
  fs.writeFileSync(hostSrcPath, SERVICE_HOST_CS, 'utf8');
  appendLog(logPath, 'Files written. Requesting elevation …');

  const safeInstallPath = psEscape(installPath);
  const safeHostSrcPath = psEscape(hostSrcPath);
  const safeHostExePath = psEscape(hostExePath);
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

  // Compile the C# service host to a native exe, then register that directly.
  // Compiling at install time (not at service start) eliminates the Add-Type
  // runtime compilation delay that caused the SCM 1053 startup timeout.
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
$hostSrc = "${safeHostSrcPath}"
$hostExe = "${safeHostExePath}"
$log     = "${safeLogPath}"

# Compile the service host C# into a native exe (done once at install time,
# not on every service start — avoids the SCM 1053 startup timeout).
Write-Log "Compiling service-host.exe …"
try {
    Add-Type -Path $hostSrc -OutputAssembly $hostExe -OutputType ConsoleApplication -ReferencedAssemblies System.ServiceProcess 2>&1 | ForEach-Object { Write-Log $_ }
    Write-Log "Compiled OK → $hostExe"
} catch {
    Write-Log "Compile error: $_"
    Write-Host "ERROR: failed to compile service host. See $log"
    Start-Sleep -Seconds 5
    exit 1
}

$bin = '"' + $hostExe + '" "' + $exe + '" "' + $log + '"'

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
