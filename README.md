# Service Remote

Service Remote is a mobile-friendly control panel for church services. It runs as one Bun/TypeScript process and serves the UI, REST API, and WebSocket endpoint to devices on the local network.

The server integrates five systems:

- **Proclaim** — presentation control and live presentation state over Proclaim's HTTP App Command and Remote Control APIs.
- **OBS Studio** — scenes, audio, streaming, recording, and screenshots over obs-websocket v5.
- **Behringer X32** — faders, mutes, meters, spill, and bus sends over OSC/UDP.
- **PTZ cameras** — VISCA/IP camera movement, focus, zoom, presets, and home commands over UDP.
- **YouTube Live** — broadcast status, viewer counts, and start/stop controls using YouTube's API and OAuth credentials (with optional reuse of OBS credentials).

State from every integration is kept in one in-memory store and published to subscribed browsers over WebSocket. The UI is bundled into the same server; no separate web server is required.

## Requirements

- [Bun](https://bun.sh) 1.0 or newer
- Proclaim with its local HTTP APIs enabled (usually on the same computer)
- OBS Studio with obs-websocket v5 enabled, if OBS control is needed
- An X32 and/or VISCA/IP camera reachable from the server, if those integrations are needed
- YouTube API/OAuth access, if YouTube control is needed

Disabled or unavailable integrations remain disconnected; the control panel can still be used for the others.

## Installation

### Windows executable

The CI build produces a self-contained Windows executable. Download `service-remote.exe` from the [latest development release](https://github.com/rygwdn/service-remote/releases/download/dev/service-remote.exe), place it in an installation directory, and run it. The executable stores its configuration and token beside itself.

### From source

```bash
git clone <repo-url>
cd service-remote
bun install
```

`bun setup` is also available for installing dependencies and the Playwright Chromium browser used by UI checks.

## Configuration

Copy the defaults and edit only the values that differ in your installation:

```bash
cp config.default.json config.json
```

`config.json` is deep-merged over `config.default.json`; object properties can be overridden individually and arrays are replaced as a whole. Keep both files private because connection passwords and OAuth secrets are credentials.

| Key | Purpose |
| --- | --- |
| `server.port` | HTTP and WebSocket port (default `3000`) |
| `server.openBrowser` | Open the local control panel when starting the server |
| `server.allowedHosts` | Extra `Host` values accepted at the security boundary (e.g. a Tailscale funnel hostname); takes effect on restart |
| `server.basePath` | Optional URL subpath prefix (e.g. `/service`) for reverse-proxy hosting; `SERVICE_REMOTE_BASE_PATH` env overrides it |
| `server.token` | Optional installation-token override (secret; wins over `SERVICE_REMOTE_TOKEN` env and the generated token file, which is still maintained for recovery) |
| `obs.address` | OBS WebSocket URL (default `ws://localhost:4455`) |
| `obs.password` | OBS WebSocket password, if enabled |
| `obs.screenshotInterval` | Screenshot polling interval in milliseconds |
| `x32.address` / `x32.port` | X32 address and OSC port (default `10023`) |
| `proclaim.host` / `proclaim.port` | Proclaim HTTP host and port (defaults `127.0.0.1:52195`) |
| `proclaim.password` | Proclaim password used by both HTTP authentication flows |
| `proclaim.pollInterval` | Presentation polling interval in milliseconds |
| `proclaim.presentationDbPath` | Optional path to `PresentationManager.db` for SongLyrics text |
| `ptz.cameras` | Enabled camera addresses, VISCA IDs, presets, steps, and ranges |
| `youtube.broadcastId` | Broadcast controlled by the YouTube panel |
| `youtube.pollInterval` | YouTube status polling interval in milliseconds |
| `youtube.apiKey` | Optional legacy API-key fallback |
| `youtube.oauth` | Optional client ID, client secret, and refresh token |
| `ui.hiddenObs` / `ui.hiddenX32` | Per-installation hidden mixer controls |

The Settings panel can read and update the connection configuration through the API. Secret values are never returned by `GET /api/config`; it reports only whether each secret is configured.

### YouTube credentials from OBS

When OBS is installed and signed in to YouTube, the Settings panel can call `POST /api/youtube/import-obs-creds`. Service Remote reads the YouTube section of OBS's `global.ini` and imports a usable access token into memory. It does not need to persist that token. Configure explicit OAuth credentials when OBS is not available or when the OBS credentials cannot be imported.

## Authentication and token bootstrap

On first start, Service Remote creates a random installation token in `.service-remote-token` beside `config.json` (or beside the compiled executable). The file is created with owner-only permissions. Set `SERVICE_REMOTE_TOKEN` to use a supplied token; the persistent token file is still maintained for recovery if the environment override is later removed.

For the first browser visit, read the token from that file and open the control-panel URL with the token once:

```text
http://<server-host>:3000/?token=<installation-token>
```

The server validates the local `Host` and `Origin`, redirects to the URL without the query token, and sets an HttpOnly, SameSite cookie for the control panel. API clients can instead send `Authorization: Bearer <installation-token>`. WebSocket clients authenticate the upgrade directly (for example, with the token query parameter); HTTP redirects cannot authenticate a WebSocket upgrade. Do not put the token in shared screenshots, chat, or public URLs.

## Running

```bash
# Production/development server
bun start

# Watch and restart on source changes
bun dev
```

Open `http://localhost:3000` (or the configured port) on the server, or use one of the LAN addresses shown by the Settings panel. The process starts the YouTube poller and starts device connections when a WebSocket client connects. Connections reconnect after transient failures.

On Windows, the bundled executable supports service installation and removal:

```powershell
service-remote.exe --install-service
service-remote.exe --uninstall-service
```

## HTTP API

All API responses are JSON unless noted. API and WebSocket requests require the installation token. State updates are also pushed to subscribed WebSocket clients.

### OBS

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/obs/scene` | `{ "scene": "Scene Name" }` | Switch scene |
| POST | `/api/obs/mute` | `{ "input": "Mic" }` | Toggle input mute |
| POST | `/api/obs/volume` | `{ "input": "Mic", "volumeDb": -10 }` | Set input volume in dB |
| POST | `/api/obs/stream` | `{}` | Toggle streaming |
| POST | `/api/obs/record` | `{}` | Toggle recording |
| GET | `/api/obs/screenshot` | — | Current scene JPEG |

### X32

`type` is `ch` by default and may be `ch`, `bus`, `main`, or `mtx` where supported. Fader values are linear from `0` to `1`.

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/x32/fader` | `{ "channel": 1, "type": "ch", "value": 0.75 }` |
| POST | `/api/x32/mute` | `{ "channel": 1, "type": "ch" }` |
| POST | `/api/x32/spill` | `{ "channel": 1, "type": "ch", "assigned": true }` |
| POST | `/api/x32/bus-send` | `{ "channel": 1, "busIndex": 1, "value": 0.5 }` |

### Proclaim

Proclaim actions use the HTTP command names `PreviousSlide`, `NextSlide`, `GoOffAir`, `GoOnAir`, `VideoPause`, `VideoPlay`, `VideoRewind`, `VideoFastForward`, `VideoRestart`, `NextAudioItem`, `GoToSlide`, `GoToServiceItem`, `StartPreService`, `StartWarmUp`, `StartService`, and `StartPostService`. `GoToSlide` and `GoToServiceItem` require a one-based `index`.

| Method | Path | Body/Query | Result |
| --- | --- | --- | --- |
| POST | `/api/proclaim/action` | `{ "action": "NextSlide" }` (optional `index`) | Execute an App Command |
| POST | `/api/proclaim/goto-item` | `{ "itemId": "..." }` | Activate a service item |
| GET | `/api/proclaim/thumb` | `?itemId=...&slideIndex=...` | Slide image (PNG) |

Service state includes the current item, slide, on-air status, service items, local revisions, and optional song lyrics. Proclaim authentication uses `POST /appCommand/authenticate` for command actions and the `/onair/session` plus `/auth/control` flow for live state and slide data.

### PTZ cameras

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/ptz/pan-tilt` | `{ "camera": 0, "panDir": -1, "tiltDir": 0 }` |
| POST | `/api/ptz/zoom` | `{ "camera": 0, "direction": "in" }` |
| POST | `/api/ptz/focus` | `{ "camera": 0, "mode": "auto" }` |
| POST | `/api/ptz/preset` | `{ "camera": 0, "action": "recall", "preset": 1 }` |
| POST | `/api/ptz/home` | `{ "camera": 0 }` |

### YouTube Live

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/youtube/start` | `{}` | Start the configured broadcast |
| POST | `/api/youtube/stop` | `{}` | End the configured broadcast |
| POST | `/api/youtube/import-obs-creds` | `{}` | Import credentials/token from OBS |
| GET | `/api/youtube/broadcasts` | — | List active/upcoming broadcasts |

### State, settings, discovery, and server helpers

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/state` | Full state snapshot for all five integrations |
| GET | `/api/logs` | Recent structured log entries |
| GET | `/api/config` | Safe connection settings and secret-configured flags |
| POST | `/api/config` | Validate, persist, reload, and reconnect changed integrations |
| GET/POST | `/api/ui/hidden` | Read or save hidden OBS/X32 controls |
| POST | `/api/discover/x32` | Find an X32 on local broadcast networks |
| POST | `/api/discover/obs` | Check the local OBS WebSocket port |
| POST | `/api/discover/proclaim` | Check the local Proclaim HTTP port (`52195`) |
| GET | `/api/server/addresses` | Local URLs and server port |
| GET | `/api/server/qr?url=...` | QR code SVG for a server URL |

## WebSocket protocol

Connect to `/ws` after authenticating. Without a `topics` query parameter, a client receives the legacy `state` topic. Topics can be selected with `?topics=state,levels,screenshot,bus:1`; subscriptions are bounded by the server.

- `state` publishes `{ "type": "state", "data": ... }` snapshots without high-rate meter levels.
- `levels` publishes live OBS/X32 meter levels.
- `screenshot` publishes binary JPEG frames.
- `bus:1` through `bus:16` publish the selected bus state and connected channels.

A client can send `{ "type": "subscribe", "channels": ["levels", "bus:1"] }` or the corresponding `unsubscribe` message. Connections to the five device integrations are started while clients are present and are stopped after the disconnect grace period when no clients remain.

## Testing and checks

```bash
bun test                 # unit and end-to-end tests
bun run test:unit        # unit tests only
bun run test:e2e         # API and WebSocket tests
bun run test:ui          # Playwright browser tests
bun run typecheck        # TypeScript check
bun run lint             # reject stray console.* calls
bun run check            # all checks above
```

## Build and release

```bash
bun run build
```

The build embeds the `public/` assets and compiles `server.ts` into a self-contained executable under `dist/`. Pass a Bun target when cross-compiling, for example `bun run build -- --target=bun-windows-x64`. CI runs typecheck, console lint, unit/end-to-end tests, and Playwright UI tests before building the Windows executable. Pushes to the main branch publish the Windows zip, executable, and SHA-256 sidecar in the development release.

## Project structure

```text
server.ts                 Bun.serve entrypoint and lifecycle
config.default.json       Safe default configuration
src/config.ts             Deep-merge and reload configuration
src/state.ts              Shared in-memory state
src/routes.ts             Validated HTTP API handlers
src/ws.ts                 Bun WebSocket topics and connection lifecycle
src/security.ts           Host/origin checks and token authentication
src/connections/obs.ts    OBS WebSocket connection
src/connections/x32.ts    X32 OSC/UDP connection
src/connections/proclaim.ts Proclaim HTTP connection and polling
src/connections/ptz.ts    VISCA/IP camera connection
src/connections/youtube.ts YouTube API/OAuth connection
public/                   Embedded/static control-panel assets
test/unit/                Unit tests
test/e2e/                 API and WebSocket tests
test/ui/                  Playwright UI tests
```
