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
 */

import path = require('path');
import os = require('os');
import fs = require('fs');

// Top-level `return` is invalid in TS modules; wrap in IIFE:
(function () {
  // ── load embedded natives ────────────────────────────────────────────────────

  let natives: { systray?: { filename: string; version: string; content: Buffer } } | null = null;
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
      console.warn('[native-loader] Could not extract systray binary:', (err as Error).message);
      // systray already has a graceful fallback in tray.js.
    }
  }
})();
