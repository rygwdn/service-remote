# CLAUDE.md

Developer and agent reference for the `service-remote` project.

## Project overview

`service-remote` is a Node.js (Bun) web server that exposes a mobile-friendly control panel for church services. It bridges three systems:

- **Proclaim** (church presentation software) via a virtual MIDI port (`easymidi`)
- **OBS Studio** via the obs-websocket v5 protocol (`obs-websocket-js`)
- **Behringer X32** audio mixer via OSC over UDP (`osc-min` + Node `dgram`)

A single shared in-memory state object is kept up to date and broadcast to all connected browsers over WebSocket whenever it changes.

## Commands

```bash
bun start          # Start the server
bun dev            # Start with --watch (auto-restart on file changes)
bun test           # Run all tests
bun test:unit      # Run unit tests only (test/unit/)
bun test:e2e       # Run end-to-end tests only (test/e2e/)
```

No build step is required. Bun runs CommonJS files directly.

## Architecture

```
server.js
  ├── src/config.js          deep-merges config.default.json + config.json
  ├── src/state.js           in-memory state store; emits updates to ws.js
  ├── src/ws.js              WebSocket server; broadcasts state to browsers
  ├── src/routes.js          Express REST handlers (delegates to connections)
  └── src/connections/
        obs.js               OBS WebSocket client
        x32.js               X32 OSC/UDP client
        proclaim.js          Virtual MIDI port
```

### State

`src/state.js` exports `get()` and `update(section, patch)`. Every call to `update` merges the patch into `state[section]` and notifies registered listeners (used by `ws.js` to push updates to browsers). The state shape is:

```js
{
  obs: {
    connected: bool,
    scenes: string[],
    currentScene: string,
    streaming: bool,
    recording: bool,
    audioSources: [{ name, volume, muted }]
  },
  x32: {
    connected: bool,
    channels: [{ index, label, fader, muted }]
  },
  proclaim: {
    connected: bool
  }
}
```

### Configuration

`src/config.js` does a recursive deep-merge of `config.default.json` over `config.json` (user file, gitignored). Array values are replaced wholesale, not merged. The `merge` function is also exported for use in tests.

### Connections

Each connection module (`obs.js`, `x32.js`, `proclaim.js`) exports a `connect()` function called once at startup. They handle their own reconnection logic internally:

- **OBS**: reconnects every 5 s on failure/disconnect
- **X32**: sends `/xremote` keepalive every 8 s; reconnects after 5 s of no response
- **Proclaim**: one-shot — attempts to open a virtual MIDI port; logs a warning if MIDI is unavailable

### API routes

Defined in `src/routes.js`. All POST endpoints call the appropriate connection method and return `{ ok: true }` or `{ error: message }` with a 500 status.

- `POST /api/obs/scene` `{ scene }`
- `POST /api/obs/mute` `{ input }`
- `POST /api/obs/volume` `{ input, volumeDb }`
- `POST /api/obs/stream`
- `POST /api/obs/record`
- `POST /api/x32/fader` `{ channel, value }` (value 0–1)
- `POST /api/x32/mute` `{ channel }`
- `POST /api/proclaim/action` `{ action }`
- `GET /api/state` — returns the full current state

## Testing

Tests use Bun's built-in test runner (`bun:test`). No external test framework is needed.

- `test/unit/` — pure unit tests for `config.js`, `state.js`, and the `parseOscMessage` function in `x32.js`
- `test/e2e/` — integration tests that spin up the Express app via `supertest` and a real WebSocket server
- `test/helpers/` — shared utilities (e.g. mock connection factories)

When adding new features:
1. Unit-test any pure/stateless logic in `test/unit/`.
2. Add an API test in `test/e2e/api.test.js` for new routes.
3. Keep connection modules mockable — `routes.js` accepts `{ obs, x32, proclaim }` as an argument so tests can inject stubs.

## Key conventions

- CommonJS (`require`/`module.exports`) throughout — do not introduce ESM.
- No TypeScript. Keep plain JavaScript.
- Config is read-only at runtime; never mutate the exported config object.
- State updates must go through `state.update()` so WebSocket listeners are notified.
- X32 fader values are 0–1 (linear). OBS volume values are in dB.
