'use strict';

/**
 * Native binary extractor — must be required before any module that uses
 * systray.
 *
 * In a `bun build --compile` binary the systray Go binary is embedded as
 * base64 inside src/embedded-natives.js.  This module extracts it to a
 * per-user cache directory on first run so systray finds it transparently.
 *
 * When embedded-natives.js is absent (normal `bun dev` / `bun start`) this
 * module is a no-op: native modules are resolved from node_modules/ as usual.
 *
 * ── How the systray intercept works ─────────────────────────────────────────
 *
 * systray's getTrayBinPath() with copyDir:true checks whether the binary
 * already lives in ~/.cache/node-systray/{version}/ before trying to copy
 * it from node_modules.  We simply pre-extract to that exact location so
 * the existing code finds it without any patching.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

// ── load embedded natives ────────────────────────────────────────────────────

let natives = null;
try {
  natives = require('./embedded-natives');
} catch (_) {
  // Not a compiled binary (or pre-build step hasn't run yet) — nothing to do.
  return;
}

if (!natives || !natives.systray) return;

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
