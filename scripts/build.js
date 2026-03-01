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

const exeName = 'service-remote' + (process.platform === 'win32' ? '.exe' : '');
const outfile = path.join(dist, exeName);

run(
  [
    'bun build',
    '--compile',
    '--minify',
    '--target=bun',
    'server.ts',
    `--outfile=${outfile}`,
  ].join(' ')
);

console.log(`\nBuild complete → ${outfile}`);
