# Service Remote

A mobile-friendly web control panel for running church services. Control Proclaim (presentation software), OBS (streaming), and a Behringer X32 mixer from any device on your local network.

## Features

- **Proclaim** — send next/previous slide and item commands via a virtual MIDI port
- **OBS** — switch scenes, toggle audio mutes, adjust volumes, start/stop streaming and recording
- **Behringer X32** — control channel faders and mutes via OSC over UDP
- Real-time state sync to all connected browsers via WebSocket
- Mobile-optimised UI served from the same process

## Prerequisites

- [Bun](https://bun.sh) v1.0 or later
- For Proclaim control: a macOS or Windows machine with native MIDI support (Linux requires a MIDI kernel module)
- For OBS control: OBS Studio with the obs-websocket plugin enabled
- For X32 control: Behringer X32 reachable on the local network

## Installation

```bash
git clone <repo-url>
cd service-remote
bun install
```

## Configuration

Copy `config.default.json` to `config.json` and edit it to match your setup. Values in `config.json` are deep-merged over the defaults, so you only need to include the keys you want to change.

```bash
cp config.default.json config.json
```

Key settings:

| Key | Description |
|-----|-------------|
| `server.port` | Port the web server listens on (default `3000`) |
| `obs.address` | WebSocket URL for OBS (default `ws://localhost:4455`) |
| `obs.password` | obs-websocket password (leave empty if auth is disabled) |
| `x32.address` | IP address of the X32 mixer |
| `x32.port` | UDP port of the X32 (default `10023`) |
| `x32.channels` | Array of `{ index, label }` objects for channels to expose |
| `proclaim.midiPortName` | Name of the virtual MIDI port to create |
| `proclaim.actions` | MIDI CC/note-on definitions for each Proclaim action |

### Proclaim MIDI actions

Each action under `proclaim.actions` can be a CC message:

```json
{ "type": "cc", "channel": 0, "controller": 1, "value": 127 }
```

or a note-on (automatically followed by note-off after 100 ms):

```json
{ "type": "noteon", "channel": 0, "note": 60, "velocity": 127 }
```

The built-in actions are `nextSlide`, `prevSlide`, `nextItem`, and `prevItem`. In Proclaim, map those MIDI messages to the corresponding keyboard shortcuts.

## Running

```bash
# Production
bun start

# Development (auto-restarts on file changes)
bun dev
```

Open `http://localhost:3000` (or the configured port) on any device on the same network.

The server attempts to connect to OBS, X32, and Proclaim on startup and will automatically reconnect if a connection drops.

## API

All endpoints return JSON. State changes are also pushed to browsers via WebSocket.

### OBS

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/obs/scene` | `{ "scene": "Scene Name" }` | Switch to a scene |
| `POST` | `/api/obs/mute` | `{ "input": "Mic" }` | Toggle mute on an input |
| `POST` | `/api/obs/volume` | `{ "input": "Mic", "volumeDb": -10 }` | Set input volume (dB) |
| `POST` | `/api/obs/stream` | — | Toggle streaming |
| `POST` | `/api/obs/record` | — | Toggle recording |

### X32

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/x32/fader` | `{ "channel": 1, "value": 0.75 }` | Set fader level (0–1) |
| `POST` | `/api/x32/mute` | `{ "channel": 1 }` | Toggle channel mute |

### Proclaim

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/proclaim/action` | `{ "action": "nextSlide" }` | Send a configured MIDI action |

### State

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/state` | Full application state (used on initial page load) |

## Testing

```bash
# All tests
bun test

# Unit tests only
bun test:unit

# End-to-end tests only
bun test:e2e
```

## Project Structure

```
server.js            # Entry point — wires together Express, WebSocket, and connections
config.default.json  # Default configuration (do not edit; override via config.json)
src/
  config.js          # Loads and deep-merges config.default.json + config.json
  state.js           # Shared in-memory state, notifies WebSocket on changes
  routes.js          # Express route handlers
  ws.js              # WebSocket server — broadcasts state updates to browsers
  connections/
    obs.js           # OBS WebSocket connection and event handling
    x32.js           # Behringer X32 OSC/UDP connection and event handling
    proclaim.js      # Proclaim virtual MIDI port
public/
  index.html         # Single-page UI
  style.css          # UI styles
test/
  unit/              # Unit tests (config, state, X32 OSC parsing)
  e2e/               # End-to-end API and WebSocket tests
  helpers/           # Shared test utilities
```
