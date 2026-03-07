# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Developer and agent reference for the `service-remote` project.

## Project overview

`service-remote` is a Node.js (Bun) web server that exposes a mobile-friendly control panel for church services. It bridges three systems:

- **Proclaim** (church presentation software) via HTTP APIs (App Command API + Remote Control API)
- **OBS Studio** via the obs-websocket v5 protocol (`obs-websocket-js`)
- **Behringer X32** audio mixer via OSC over UDP (`node-osc`)

A single shared in-memory state object is kept up to date and broadcast to all connected browsers over WebSocket whenever it changes.

## Commands

```bash
bun start          # Start the server
bun dev            # Start with --watch (auto-restart on file changes)
bun test           # Run all tests
bun test:unit      # Run unit tests only (test/unit/)
bun test:e2e       # Run end-to-end tests only (test/e2e/)
bun run typecheck  # Type-check with tsc --noEmit
bun run lint       # Check for stray console.* calls
bun run build      # Build standalone binary via scripts/build.js
```

To run a single test file: `bun test test/unit/state.test.ts`

No build step is required for development. Bun runs TypeScript files directly.

## Architecture

```
server.ts
  ├── src/config.ts          deep-merges config.default.json + config.json
  ├── src/state.ts           in-memory state store; emits updates to ws.ts
  ├── src/ws.ts              WebSocket server; broadcasts state to browsers
  ├── src/routes.ts          Express REST handlers (delegates to connections)
  ├── src/logger.ts          In-memory log buffer + structured logging
  ├── src/discovery.ts       mDNS/network discovery helpers
  ├── src/tray.ts            System tray integration
  ├── src/types.ts           All shared TypeScript interfaces
  └── src/connections/
        obs.ts               OBS WebSocket client
        x32.ts               X32 OSC/UDP client
        proclaim.ts          Proclaim HTTP client (App Command + Remote Control APIs)
```

### State

`src/state.ts` exports `get()` and `update(section, patch)`. Every call to `update` merges the patch into `state[section]` and notifies registered listeners (used by `ws.ts` to push updates to browsers). See `src/types.ts` for the full `AppState` interface. Key shape:

```ts
{
  obs: {
    connected: boolean,
    scenes: string[],
    currentScene: string,
    streaming: boolean,
    recording: boolean,
    audioSources: [{ name, volume, muted, live }]
  },
  x32: {
    connected: boolean,
    channels: [{ index, type: 'ch'|'bus', label, fader, muted, level }]
  },
  proclaim: {
    connected: boolean,
    onAir: boolean,
    currentItemId: string | null,
    currentItemTitle: string | null,
    currentItemType: string | null,
    slideIndex: number | null,
    serviceItems: [{ id, title, kind, slideCount, index, section, group }]
  }
}
```

### Configuration

`src/config.ts` does a recursive deep-merge of `config.default.json` over `config.json` (user file, gitignored). Array values are replaced wholesale, not merged. The `merge` function is also exported for use in tests.

### Connections

Each connection module exports a `connect()` function called once at startup. They handle their own reconnection logic internally:

- **OBS**: reconnects every 5 s on failure/disconnect
- **X32**: sends `/xremote` keepalive every 8 s; reconnects after 5 s of no response
- **Proclaim**: HTTP polling; authenticates via App Command API and Remote Control API; reconnects on failure

### API routes

Defined in `src/routes.ts`. All POST endpoints call the appropriate connection method and return `{ ok: true }` or `{ error: message }` with a 500 status.

- `POST /api/obs/scene` `{ scene }`
- `POST /api/obs/mute` `{ input }`
- `POST /api/obs/volume` `{ input, volumeDb }`
- `POST /api/obs/stream`
- `POST /api/obs/record`
- `GET  /api/obs/screenshot` — returns JPEG of current scene
- `POST /api/x32/fader` `{ channel, value, type? }` (value 0–1; type defaults to `'ch'`)
- `POST /api/x32/mute` `{ channel, type? }`
- `POST /api/proclaim/action` `{ action, index? }`
- `GET  /api/proclaim/thumb` `?itemId=&slideIndex=&localRevision=`
- `GET  /api/state` — returns the full current state
- `GET  /api/logs` — returns recent in-memory log entries
- `GET  /api/config` — returns current connection config
- `POST /api/config` — updates and persists connection config

## Testing

Tests use Bun's built-in test runner (`bun:test`) for unit/e2e and Playwright for UI tests.

- `test/unit/` — pure unit tests for `config.ts`, `state.ts`, `x32.ts` (OSC parsing), `discovery.ts`
- `test/e2e/` — integration tests that spin up the Express app via `supertest` and a real WebSocket server
- `test/ui/` — Playwright browser tests; inject state via `setState()` fixture, interact with the UI, assert DOM
- `test/helpers/` — shared utilities (e.g. mock connection factories)

### TDD workflow

Write the failing test first, confirm it's red, then implement until green.

```bash
# Red → Green cycle
bun test test/unit/foo.test.ts          # unit — fast, run after every change
bun test test/e2e/api.test.ts           # e2e  — API routes / WebSocket
bunx playwright test test/ui/foo.test.ts --headed  # UI — browser tests
```

When adding new features:
1. Unit-test pure/stateless logic in `test/unit/`.
2. Add an API test in `test/e2e/api.test.ts` for new routes.
3. Add a UI test in `test/ui/` for any visible behaviour (use `setState()` to drive state).
4. Keep connection modules mockable — `routes.ts` accepts `{ obs, x32, proclaim }` as an argument so tests can inject stubs.

## Key conventions

- TypeScript throughout. Use `import X = require('y')` for runtime CJS imports; `import type { X }` for type-only imports.
- `tsconfig.json` uses `"module": "preserve"` + `"moduleResolution": "bundler"` — do not change these.
- Config is read-only at runtime; never mutate the exported config object.
- State updates must go through `state.update()` so WebSocket listeners are notified.
- X32 fader values are 0–1 (linear). OBS volume values are in dB.
- Use `logger` from `src/logger.ts` instead of `console.*` (the lint script enforces this).
