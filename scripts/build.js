'use strict';

/**
 * Build script: produces a single self-contained executable in dist/.
 *
 * Steps:
 *   1. Embed public/ assets into src/embedded-public.js
 *   2. Run `bun build --compile` to bundle all JS + the Bun runtime
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

function run(cmd) {
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

// 1. Embed public/ assets
console.log('Step 1: Embedding public/ assets …');
run('bun scripts/embed-public.js');

// 2. Compile
console.log('\nStep 2: Compiling single executable …');
fs.mkdirSync(dist, { recursive: true });

// Embed the git SHA so it's available at runtime without needing `git`
let gitSha = 'unknown';
try {
  gitSha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
} catch (_) {}
console.log(`  Git SHA: ${gitSha}`);

// Accept an explicit --target=<bun-target> argument, e.g. bun-windows-x64.
// Falls back to the native platform target.
const targetArg = process.argv.find((a) => a.startsWith('--target='));
const target = targetArg ? targetArg.slice('--target='.length) : 'bun';
const targetIsWindows = target.includes('windows') || (target === 'bun' && process.platform === 'win32');

const exeName = 'service-remote' + (targetIsWindows ? '.exe' : '');
const outfile = path.join(dist, exeName);

// --windows-hide-console suppresses the terminal window so the tray app runs
// silently in the background. Only supported when building natively on Windows.
const windowsFlags = (targetIsWindows && process.platform === 'win32') ? ['--windows-hide-console'] : [];

run(
  [
    'bun build',
    '--compile',
    '--minify',
    `--target=${target}`,
    ...windowsFlags,
    `--define 'process.env.GIT_SHA="${gitSha}"'`,
    'server.ts',
    `--outfile=${outfile}`,
  ].join(' ')
);

console.log(`\nBuild complete → ${outfile}`);
