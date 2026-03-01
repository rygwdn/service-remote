'use strict';

/**
 * Build script: produces a single self-contained executable in dist/.
 *
 * Steps:
 *   1. Embed public/ assets into src/embedded-public.js
 *   2. Embed native binaries into src/embedded-natives.js
 *   3. Run `bun build --compile` to bundle all JS + the Bun runtime
 *
 * The systray Go binary is base64-encoded into src/embedded-natives.js at
 * step 2.  At runtime, src/native-loader.js extracts it to a per-user cache
 * directory so it is found transparently.
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

// 2. Embed native binaries
console.log('\nStep 2: Embedding native binaries …');
run('bun scripts/embed-natives.js');

// 3. Compile
console.log('\nStep 3: Compiling single executable …');
fs.mkdirSync(dist, { recursive: true });

const exeName = 'service-remote' + (process.platform === 'win32' ? '.exe' : '');
const outfile = path.join(dist, exeName);

run(
  [
    'bun build',
    '--compile',
    '--minify',
    '--target=bun',
    'server.js',
    `--outfile=${outfile}`,
  ].join(' ')
);

console.log(`
Build complete → ${outfile}

Embedded:  all JS modules + public/ UI assets + Bun runtime
           + systray binary (current platform)
At runtime: native-loader.js extracts systray binary to ~/.cache/node-systray/
`);
