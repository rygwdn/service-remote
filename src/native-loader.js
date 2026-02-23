'use strict';

/**
 * Native binary extractor — must be required before any module that uses
 * easymidi or systray.
 *
 * In a `bun build --compile` binary the native .node addon and the systray
 * Go binary are embedded as base64 inside src/embedded-natives.js.  This
 * module extracts them to a per-user cache directory on first run and then
 * patches Node/Bun's module machinery so the rest of the code loads them
 * transparently from there.
 *
 * When embedded-natives.js is absent (normal `bun dev` / `bun start`) this
 * module is a no-op: native modules are resolved from node_modules/ as usual.
 *
 * ── How the easymidi intercept works ────────────────────────────────────────
 *
 * pkg-prebuilds (used by @julusian/midi) locates the .node addon by calling
 * fs.existsSync / fs.statSync on a candidate path constructed from __dirname
 * (the build-machine path baked into the bundle).  In the compiled binary
 * that path no longer exists on disk, so we:
 *
 *   1. Patch fs.existsSync + fs.statSync to return truthy results for any
 *      path whose basename matches the embedded addon filename.
 *   2. Patch Module._extensions['.node'] so that when require() tries to
 *      dlopen that (non-existent) original path it loads our extracted copy
 *      instead.
 *
 * ── How the systray intercept works ─────────────────────────────────────────
 *
 * systray's getTrayBinPath() with copyDir:true checks whether the binary
 * already lives in ~/.cache/node-systray/{version}/ before trying to copy
 * it from node_modules.  We simply pre-extract to that exact location so
 * the existing code finds it without any patching.
 */

const Module = require('module');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

// ── load embedded natives ────────────────────────────────────────────────────

let natives = null;
try {
  natives = require('./embedded-natives');
} catch (_) {
  // Not a compiled binary (or pre-build step hasn't run yet) — nothing to do.
  return;
}

if (!natives || (!natives.midi && !natives.systray)) return;

const CACHE_DIR = path.join(os.homedir(), '.service-remote', 'natives');

// ── midi: extract .node addon ────────────────────────────────────────────────

if (natives.midi) {
  const { filename, content } = natives.midi;
  const extractedPath = path.join(CACHE_DIR, filename);

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (!fs.existsSync(extractedPath)) {
      fs.writeFileSync(extractedPath, content);
    }
  } catch (err) {
    console.warn('[native-loader] Could not extract midi addon:', err.message);
    // If extraction fails the graceful fallback in proclaim.js still applies.
    return;
  }

  // 1. Patch fs so pkg-prebuilds' candidate-path checks succeed.
  //    We only intercept paths whose final component matches the addon filename
  //    to minimise side-effects on the rest of the filesystem code.
  const realExistsSync = fs.existsSync.bind(fs);
  const realStatSync   = fs.statSync.bind(fs);

  fs.existsSync = function patchedExistsSync(p, ...rest) {
    if (typeof p === 'string' && path.basename(p) === filename) {
      return realExistsSync(extractedPath);
    }
    return realExistsSync(p, ...rest);
  };

  fs.statSync = function patchedStatSync(p, ...rest) {
    if (typeof p === 'string' && path.basename(p) === filename) {
      return realStatSync(extractedPath, ...rest);
    }
    return realStatSync(p, ...rest);
  };

  // 2. Patch Module._extensions['.node'] so the actual dlopen call loads
  //    our extracted file regardless of the (non-existent) source path.
  const realNodeExt = Module._extensions['.node'] || function (mod, fp) {
    process.dlopen(mod, path.resolve(fp));
  };

  Module._extensions['.node'] = function patchedNodeExt(mod, fp) {
    if (path.basename(fp) === filename) {
      fp = extractedPath;
    }
    realNodeExt(mod, fp);
  };
}

// ── systray: pre-extract Go binary to the expected cache location ─────────────

if (natives.systray) {
  const { filename, version, content } = natives.systray;
  const systrayCache = path.join(
    os.homedir(), '.cache', 'node-systray', version, filename
  );

  try {
    if (!fs.existsSync(systrayCache)) {
      fs.mkdirSync(path.dirname(systrayCache), { recursive: true });
      fs.writeFileSync(systrayCache, content);
      fs.chmodSync(systrayCache, 0o755);
    }
  } catch (err) {
    console.warn('[native-loader] Could not extract systray binary:', err.message);
    // systray already has a graceful fallback in tray.js.
  }
}
