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

// Stable install location — %LOCALAPPDATA%\ServiceRemote\service-remote.exe.
// Writable without elevation; the running exe is never the install target so
// there is no file-lock conflict when upgrading.
function getInstallPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os().homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'ServiceRemote', 'service-remote.exe');
}

// Lazy import — os is only needed on Windows at runtime.
function os() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('os') as typeof import('os');
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

export function installService(exePath: string): void {
  logger.log(`[Service] Installing Windows service "${SERVICE_NAME}" …`);

  const installPath  = getInstallPath();
  const installDir   = path.dirname(installPath);
  const wrapperPath  = path.join(installDir, 'wrapper.ps1');

  // Both files are writable without elevation (LOCALAPPDATA).
  // Copy before elevating so the running exe is never the install target.
  logger.log(`[Service] Copying exe to ${installPath} …`);
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(exePath, installPath);
  fs.writeFileSync(wrapperPath, WRAPPER_PS1, 'utf8');
  logger.log('[Service] Files written.');

  const safeInstallPath = psEscape(installPath);
  const safeWrapperPath = psEscape(wrapperPath);

  // The service binPath runs PowerShell with the wrapper script.
  // PowerShell's inline C# handles the SCM handshake (SERVICE_RUNNING/STOPPED)
  // and launches the real exe as a child process.
  const script = `
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting administrator privileges …"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($MyInvocation.MyCommand.ScriptBlock.ToString()))
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    exit
}

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
    Write-Host "Service $name already exists — upgrading …"
    Write-Host "Stopping service …"
    & sc.exe stop $name 2>&1
    Start-Sleep -Seconds 3
    Write-Host "Updating service path …"
    & sc.exe config $name binPath= $bin start= auto DisplayName= $display 2>&1
} else {
    Write-Host "Creating service $name …"
    & sc.exe create $name binPath= $bin start= auto DisplayName= $display 2>&1
    & sc.exe description $name $desc 2>&1
}

Write-Host "Starting service …"
& sc.exe start $name 2>&1
Write-Host ""
Write-Host "Done. Service '$name' installed."
Write-Host "  exe:     $exe"
Write-Host "  wrapper: $wrapper"
Write-Host "To remove it: service-remote.exe --uninstall-service"
Start-Sleep -Seconds 2
`;

  runPs1(script);
}

export function uninstallService(): void {
  logger.log(`[Service] Uninstalling Windows service "${SERVICE_NAME}" …`);

  const script = `
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting administrator privileges …"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($MyInvocation.MyCommand.ScriptBlock.ToString()))
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    exit
}

$name = "${SERVICE_NAME}"
Write-Host "Stopping service $name …"
& sc.exe stop $name 2>&1
Start-Sleep -Seconds 2
Write-Host "Deleting service $name …"
& sc.exe delete $name 2>&1
Write-Host ""
Write-Host "Done. Service '$name' removed."
Start-Sleep -Seconds 2
`;

  runPs1(script);
}
