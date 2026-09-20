# CLAUDE.md

Developer and agent reference for `service-remote`.

## Project overview

`service-remote` is a Bun/TypeScript server and browser control panel for a church service. The runtime uses `Bun.serve` and the Web Platform `Request`/`Response` APIs; it does not use Express or `supertest`.

The five device/service integrations are:

- **OBS Studio** — `src/connections/obs.ts`, using `obs-websocket-js` v5.
- **Behringer X32** — `src/connections/x32.ts`, using OSC over UDP via `node-osc`.
- **Proclaim** — `src/connections/proclaim.ts` plus `src/connections/proclaimDb.ts`, using the App Command and Remote Control HTTP APIs and optional local presentation-database lyrics.
- **PTZ cameras** — `src/connections/ptz.ts`, using VISCA/IP over UDP.
- **YouTube Live** — `src/connections/youtube.ts`, using the YouTube Data API and OAuth credentials imported from OBS when available.

Supporting runtime modules include `src/state.ts` (shared in-memory state), `src/routes.ts` (Request/Response API handlers), `src/ws.ts` (Bun WebSocket topics and lifecycle), `src/levels-ws.ts` and `src/screenshot-ws.ts` (high-frequency publishers), `src/security.ts` (installation-token and host/origin boundary), `src/config.ts`, `src/logger.ts`, `src/discovery.ts`, `src/tray.ts`, `src/service.ts`, and `src/updater.ts`. `server.ts` wires these modules together and serves either `public/` assets or the compiled embedded assets from `src/embedded-public.ts`.

## Commands

```bash
bun start                    # Run server.ts
bun dev                      # Run server.ts with --watch
bun test                     # Unit + e2e Bun tests
bun test:unit                # test/unit/
bun test:e2e                 # test/e2e/
bun run test:ui              # All Playwright UI tests
bun run typecheck            # tsc --noEmit
bun run lint                 # Reject stray console.* calls
bun run check                # typecheck, lint, unit/e2e, and UI checks
bun run build                # scripts/build.ts: embed assets and bun build --compile
```

To run one Bun test file, use `bun test test/unit/state.test.ts`. To run one UI file, use `bunx playwright test test/ui/overview.test.ts`. Bun executes the `.ts` sources directly; no transpiled JavaScript source tree is maintained. The build script produces a self-contained executable in `dist/` and accepts an optional `--target=<bun-target>` argument.

## Runtime and request architecture

`server.ts` creates the security boundary, starts YouTube polling, and creates a `Bun.serve` instance. Its `fetch(req, server)` handler, in order:

1. Rejects disallowed `Host`/`Origin` values.
2. Handles a valid token-bootstrap query by redirecting to a clean URL and setting the HttpOnly cookie.
3. Strips the optional `SERVICE_REMOTE_BASE_PATH` for internal routing.
4. Requires the installation token for `/api/*` and `/ws`.
5. Upgrades `/ws` through `src/ws.ts`, dispatches API requests to the function returned by `setupRoutes()`, serves static/embedded assets, or returns 404.

`setupRoutes(connections, stateOverride?, configPathOverride?)` registers URLPattern-based handlers and returns a `Response`, a `Promise<Response>`, or `null` when the caller should try static files. JSON mutation handlers require `Content-Type: application/json`, reject unknown fields, validate values at runtime, and return JSON `{ ok: true }`/`{ error }` responses. Tests inject connection stubs through the `Connections` interfaces rather than copying production algorithms.

### Authentication bootstrap and boundary

On first start, `src/security.ts` generates a random installation token in `.service-remote-token` beside `config.json` (file mode `0600`). `SERVICE_REMOTE_TOKEN` may override the runtime token; a persistent token file is still ensured. The token is never part of normal logs or the returned configuration.

To bootstrap a browser, open the server URL with `?token=<installation-token>`. For a normal HTTP request, a valid token query is removed from the URL and the server responds with a redirect carrying an HttpOnly, `SameSite=Strict` (`Secure` on HTTPS) `service-remote-token` cookie. API requests may authenticate with that cookie, `Authorization: Bearer <token>`, or a token query. WebSocket clients cannot follow the bootstrap redirect, so the `/ws` upgrade must present the cookie, bearer header, or query token directly. `Host` must be localhost, the machine hostname, or a local interface address; an `Origin`, when present, must match the request authority. Keep the token out of logs, screenshots, and shared URLs after bootstrap.

## Shared state

`src/state.ts` exports a `State` class and the default state instance. Read with `get()` and publish changes with `update(section, patch)`; do not mutate nested objects already held by state. Updates emit a change event consumed by `src/ws.ts`. The current `AppState` in `src/types.ts` has these sections:

```ts
{
  obs: {
    connected: boolean; currentScene: string; scenes: string[];
    streaming: boolean; recording: boolean;
    audioSources: { name: string; volume: number; muted: boolean; live: boolean; level: number }[];
  };
  x32: {
    connected: boolean;
    channels: {
      index: number; type: 'ch'|'bus'|'main'|'mtx'; label: string;
      fader: number; muted: boolean; level: number; source: number;
      linkedToNext: boolean; spill: boolean; color: number;
      busSends?: { busIndex: number; level: number; on: boolean }[];
    }[];
  };
  proclaim: {
    connected: boolean; onAir: boolean; currentItemId: string | null;
    currentItemTitle: string | null; currentItemType: string | null;
    slideIndex: number | null; serviceItems: ServiceItem[];
    slideRevisions: Record<string, Record<string, string>>;
    songLyrics: Record<string, string[][]>;
  };
  ptz: { cameras: { name: string; connected: boolean; pan: number | null;
    tilt: number | null; zoom: number | null; presets: number[] }[] };
  youtube: { connected: boolean; viewerCount: number | null;
    broadcastId: string | null; broadcastTitle: string | null;
    broadcastStatus: 'ready'|'testing'|'live'|'complete' | null };
}
```

`ServiceItem` includes `id`, `title`, `kind`, `slideCount`, 1-based `index` and `sectionIndex`, `sectionCommand`, `section`, and nullable `group`. X32 and OBS levels are linear `0..1`; OBS volume commands use dB. The WebSocket `state` message deliberately omits high-frequency levels; `/ws` `levels` messages carry those separately, while `/api/state` returns the full current state.

## Configuration

`src/config.ts` deep-merges `config.default.json` with the optional gitignored `config.json`; objects merge recursively and arrays (including `ptz.cameras`, `ui.hiddenObs`, and `ui.hiddenX32`) replace wholesale. `config` is a mutable runtime object refreshed by `config.reload()` after a validated config write; callers must not mutate it directly. The current shape is:

```ts
{
  server: { port: number; openBrowser: boolean; allowedHosts: string[]; basePath: string; token: string };
  obs: { address: string; password: string; screenshotInterval: number };
  x32: { address: string; port: number };
  proclaim: { host: string; port: number; password: string;
    pollInterval: number; presentationDbPath: string };
  ptz: { cameras: {
    name: string; enabled: boolean; address: string; port: number;
    cameraId: number; numPresets: number; panStep: number; tiltStep: number;
    zoomStep: number; panRange: [number, number]; tiltRange: [number, number];
    zoomRange: [number, number];
  }[] };
  youtube: { apiKey?: string; broadcastId: string; pollInterval: number;
    oauth?: { clientId?: string; clientSecret?: string; refreshToken?: string } };
  ui: { hiddenObs: string[]; hiddenX32: string[] };
}
```

`GET /api/config` returns connection settings but only `passwordConfigured`, `apiKeyConfigured`, and OAuth `*Configured` flags for secrets. `POST /api/config` validates known keys, host/URL formats, ports, finite ranges, poll intervals, camera records, and OAuth structure; omitted or placeholder secret values preserve the existing secret. Never log or return secret values.

## Connection lifecycle

- **YouTube** starts once during server startup and polls with a completion-driven loop. It imports a usable access/refresh token from OBS `global.ini` when possible, falls back to configured OAuth/API-key credentials, aborts requests on disconnect, and ignores stale connection generations.
- **OBS, X32, Proclaim, and PTZ** start when the first WebSocket client opens (or a standalone bus topic needs X32) and stop after the configured no-client delay. The server owns this lifecycle through `setupWebSocket`; do not start duplicate loops in route handlers.
- **OBS** refreshes scene/audio state, captures screenshots, publishes meter levels, and reconnects after a 5-second failure/disconnect delay. Screenshot work is bounded to one in-flight request and generation-aware.
- **X32** uses one UDP socket, `/xremote` keepalive, liveness deadlines, bounded/coalesced writes, meter subscriptions, and reference-counted bus-send tracking. Disconnect clears timers, queues, and bus tracking.
- **Proclaim** authenticates separately to the App Command API (`ProclaimAuthToken`) and Remote Control API (`OnAirSessionId`/control connection), then runs presentation and status long-poll loops. Disconnect aborts the generation and invalidates stale results.
- **PTZ** maintains per-camera VISCA/IP sockets, reconnects cameras independently, polls positions, and supports go-to pan/tilt, zoom, focus, presets, and home commands.

## API and WebSocket contract

API routes are registered in `src/routes.ts`. All `/api/*` routes are behind the server authentication boundary described above.

- **OBS:** `POST /api/obs/scene` `{scene}`, `/api/obs/mute` `{input}`, `/api/obs/volume` `{input, volumeDb}`, `/api/obs/stream`, `/api/obs/record`; `GET /api/obs/screenshot` returns JPEG.
- **X32:** `POST /api/x32/fader` `{channel, value, type?}`; `/api/x32/mute` `{channel, type?}`; `/api/x32/spill` `{channel, type?, assigned}`; `/api/x32/bus-send` `{channel, busIndex, value}`. `type` is `ch`, `bus`, `main`, or `mtx` where applicable; fader/send values are `0..1`.
- **Proclaim:** `POST /api/proclaim/action` `{action, index?}`; `POST /api/proclaim/goto-item` `{itemId}`; `GET /api/proclaim/thumb?itemId=&slideIndex=&localRevision=` returns a cached/polled image.
- **PTZ:** `POST /api/ptz/pan-tilt` `{camera?, panDir, tiltDir, panSpeed?, tiltSpeed?}`; `/api/ptz/zoom` `{camera?, direction}`; `/api/ptz/focus` `{camera?, mode}`; `/api/ptz/preset` `{camera?, action, preset}`; `/api/ptz/home` `{camera?}`.
- **YouTube:** `POST /api/youtube/start`, `/api/youtube/stop`, `/api/youtube/import-obs-creds`; `GET /api/youtube/broadcasts`.
- **State and diagnostics:** `GET /api/state`, `GET /api/logs`, and redacted `GET /api/config`; `POST /api/config` persists validated connection settings.
- **UI/discovery:** `GET /api/ui/hidden`, `POST /api/ui/hidden`; `POST /api/discover/x32`, `/api/discover/obs`, `/api/discover/proclaim`.
- **Server helpers:** `GET /api/server/addresses`; `GET /api/server/qr?url=` returns an SVG QR code.

The WebSocket endpoint is `/ws`. The default topic is `state`; clients may request bounded `state`, `levels`, `screenshot`, and `bus:1` through `bus:16` topics in the URL or subscribe messages. Per-socket and bus-topic limits are enforced. State messages are `{type: 'state', data: AppState}`, level messages are high-frequency `{type: 'levels', ...}`, screenshots are binary JPEG frames, and bus messages are `bus-state` snapshots containing mixer connectivity, the selected bus, and assigned channels. Keep `levels`/screenshots off the state path to avoid unnecessary UI churn.

## Testing

Tests use Bun's `bun:test` runner and Playwright; there is no Express app or `supertest` layer.

- `test/unit/`: `config.test.ts`, `state.test.ts`, `security.test.ts`, `logger.test.ts`, `discovery.test.ts`, `obs.test.ts`, `obs-screenshot.test.ts`, `x32.test.ts`, `x32-pending-fader.test.ts`, `x32-pending-bus-send.test.ts`, `proclaim.test.ts`, `proclaimDb.test.ts`, `proclaimDbDb.test.ts`, `ptz.test.ts`, and `youtube.test.ts`. These cover production parsers, validation, state transitions, credentials, and controlled connection behavior.
- `test/e2e/`: `api.test.ts`, `ws.test.ts`, `levels-ws.test.ts`, `screenshot-ws.test.ts`, and `bus-ws.test.ts`. These exercise the real Bun `Request`/`Response` handlers and WebSocket server with injected production-module connections.
- `test/ui/`: Playwright coverage in `overview.test.ts`, `obs.test.ts`, `x32.test.ts`, `bus-mix.test.ts`, `proclaim.test.ts`, `songLyrics.test.ts`, `ptz.test.ts`, `youtube.test.ts`, and `visibility.test.ts`.
- `test/helpers/app.ts` builds an isolated Bun test server with a fresh `State`, injected `Connections` stubs, call recording, and optional public assets. `test/helpers/test-server.ts` starts that app for Playwright. `test/ui/fixtures.ts` embeds the pinned local Alpine runtime and exposes `setState()`/`serverUrl` fixtures.

### TDD workflow

Write a behavior-focused test before implementation, confirm the new test is red, implement the smallest production change, and make it green. Use `test/unit/` for pure logic and connection behavior, `test/e2e/` for API/WebSocket contracts, and `test/ui/` for visible browser behavior. For a route, add it to `setupRoutes()` and exercise it through a `Request` against the test app; inject the production connection interface rather than reimplementing an algorithm. For UI state, use the fixture's `setState()` and assert what a user can observe. Keep tests deterministic, isolated, and free of export/source-text/literal/no-throw tautologies.

## Workflow and CI

Before delivery, run the complete check contract:

```bash
bun run typecheck
bun run lint
bun test test/unit test/e2e
bun run test:ui
```

The equivalent local shortcut is `bun run check`. `.github/workflows/build.yml` runs typecheck, console lint, unit/e2e tests (with JUnit reporting), installs Playwright Chromium, and runs the UI suite. Its Windows job runs `bun run build`; the release job packages the executable and a SHA-256 sidecar. `.claude/hooks/stop.sh` runs the same typecheck, lint, unit/e2e, and UI gates before session completion. Set `SKIP_CHECKS=1` only when intentionally bypassing the stop hook (for example, an unavailable browser environment).

Tests should be committed alongside behavior changes. Use Conventional Commits (`<type>(<scope>): <imperative summary>`, subject at most 72 characters).

## Key conventions

- TypeScript throughout. Source and test filenames use `.ts`; use `import X = require('y')` for runtime CommonJS imports and `import type { X }` for type-only imports.
- `tsconfig.json` uses `"module": "preserve"` and `"moduleResolution": "bundler"`; do not change these casually.
- Keep `config` access read-only except through its supported reload path; never expose secrets.
- State updates go through `state.update()` so WebSocket listeners are notified; replace changed nested objects rather than mutating shared references.
- X32 fader/send values are linear `0..1`; OBS volume values are dB; PTZ coordinates use VISCA units.
- Use `logger` from `src/logger.ts` instead of `console.*`; the lint script enforces this.
- Preserve the existing TDD, injected-connection, and graceful connection-lifecycle patterns when adding routes, integrations, or tests.
