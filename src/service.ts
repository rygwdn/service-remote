import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as logger from './logger';

const SERVICE_NAME = 'ServiceRemote';
const SERVICE_DISPLAY = 'Service Remote';
const SERVICE_DESC = 'Church service AV control panel (OBS, X32, Proclaim)';

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

  const installPath = getInstallPath();
  const installDir  = path.dirname(installPath);

  // Copy the exe to its stable location before elevating — no file lock on the
  // destination yet, and LOCALAPPDATA is writable without admin rights.
  logger.log(`[Service] Copying exe to ${installPath} …`);
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(exePath, installPath);
  logger.log('[Service] Copy complete.');

  const safeInstallPath = psEscape(installPath);

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
$stable  = "${safeInstallPath}"
$bin     = '"' + $stable + '" --service'

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
Write-Host "Done. Service '$name' installed at:"
Write-Host "  $stable"
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
