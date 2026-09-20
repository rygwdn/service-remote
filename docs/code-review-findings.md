# Code Review Findings and Remediation Plan

## Scope

Static review of the Bun/TypeScript server, device connections, WebSocket protocol, browser UI, tests, CI, and operational documentation. Findings are ordered by implementation priority.

## Critical and high-priority findings

### 1. Unauthenticated cross-site control

`src/routes.ts` accepts mutation requests without authentication, content-type enforcement, or origin validation. `src/ws.ts` upgrades WebSockets without an origin or token check. A website opened by an operator can therefore use that browser's LAN access to control OBS, X32, Proclaim, PTZ, or YouTube.

Remediation:

- Generate and persist a random installation token.
- Require the token for API requests and WebSocket upgrades.
- Validate `Host` and `Origin` at the server boundary.
- Require `application/json` for JSON mutation routes.
- Include the token in generated control-panel URLs without exposing it through logs.

### 2. Secret disclosure

`GET /api/config` returns OBS and Proclaim passwords plus YouTube OAuth secrets. `GET /api/logs` is also unauthenticated, and logging has no credential-redaction pass.

Remediation:

- Make passwords, client secrets, and refresh tokens write-only.
- Return `passwordConfigured`-style flags instead of secret values.
- Protect diagnostic routes with the installation token.
- Redact authorization headers, tokens, and password-like values before storing logs.

### 3. X32 state updates mutate shared state in place

`src/connections/x32.ts` mutates channel objects already referenced by `State`. `State.update()` then compares the old and new section after the mutation and may suppress the change event. Fader, mute, label, color, and bus-send changes can consequently fail to reach clients.

`setFader()` also waits for the next global state event. Its own event may be suppressed, allowing the request to hang or resolve because an unrelated integration changed state.

Remediation:

- Replace changed channel and bus-send objects immutably.
- Return after the optimistic state update rather than waiting on a global event.
- Compare only patched fields in `State.update()` instead of serializing whole sections.

### 4. PTZ inquiry results never reach shared state

PTZ response handlers update private connection fields but do not publish decoded pan, tilt, and zoom positions to `state.ptz.cameras`.

Remediation: publish inquiry results through the existing camera-state update path.

### 5. Established X32 connections lack liveness detection

The initial `/info` exchange has a timeout, but an already-connected UDP mixer can disappear while `connected` remains true indefinitely.

Remediation: track the last valid mixer response, mark the connection unavailable after a deadline, close the stale socket, and reconnect.

## Security and validation findings

### 6. DNS rebinding and unrestricted hosts

The Bun server accepts arbitrary `Host` values. Combined with unauthenticated read and write routes, DNS rebinding can bypass the intended LAN boundary.

Remediation: allow only localhost and current LAN addresses/hostnames, and reject foreign WebSocket origins.

### 7. Persisted configuration is not runtime-validated

`POST /api/config` writes asserted request types directly to disk and restarts integrations. Invalid poll intervals, ports, camera objects, or OAuth structures can poison future starts or redirect integration traffic.

Remediation: validate known keys, primitive types, enums, finite numeric ranges, port ranges, and minimum poll intervals before persistence.

### 8. Device commands accept unvalidated runtime values

TypeScript assertions do not validate JSON. Non-finite fader/volume values, invalid channel indices, and unexpected type strings can reach OSC or OBS calls.

Remediation: use shared request validators for every command route and reject invalid input with HTTP 400.

### 9. OBS credential import accepts an arbitrary directory

The YouTube credential-import endpoint accepts a caller-supplied directory. On Windows, a UNC path can force outbound SMB authentication.

Remediation: remove the remote directory parameter and use only the platform-defined OBS configuration directory.

### 10. Proclaim thumbnail path values are not encoded

Thumbnail item and slide identifiers are interpolated into an upstream path. Encode the item identifier and require an integer slide index.

### 11. Updates are downloaded and executed without artifact verification

The updater writes downloaded bytes to disk and executes them. A displayed Git SHA is not a binary integrity check.

Remediation:

- Publish a SHA-256 digest or asymmetric signature with each artifact.
- Verify before writing/executing.
- Use a randomized temporary path.
- Restrict release-workflow privileges.

### 12. PowerShell escaping uses C-style rules

`src/service.ts` escapes backslashes and quotes as if PowerShell used C string rules. Paths containing interpolation characters can corrupt or inject the elevated script.

Remediation: use PowerShell single-quoted literals with doubled apostrophes, or pass paths through environment variables.

## Connection lifecycle and resource findings

### 13. Async polling can overlap and survive disconnects

Proclaim and YouTube use intervals around asynchronous network work. OBS screenshot capture can also start a new RPC every 250 ms while the previous request is unresolved.

Remediation:

- Use completion-driven timeout loops.
- Permit one in-flight operation per integration.
- Attach an `AbortController` to each connection generation.
- Abort on disconnect and ignore stale-generation results.
- Catch OBS scene-refresh failures inside the event handler.

### 14. X32 bus tracking leaks work

Explicit disconnect does not clear every bus tracking interval/refcount. Tracking many buses can enqueue reads faster than the configured outgoing drain rate, and WebSocket subscriptions accept arbitrary `bus:N` values.

Remediation:

- Validate bus indices and cap subscriptions per socket.
- Clear tracking intervals and refcounts on disconnect.
- Coalesce duplicate queued reads and bound the outgoing queue.

### 15. Logging blocks the event loop

The logger performs synchronous stat and append operations for each message.

Remediation: serialize writes through an asynchronous stream and track approximate size in memory for rotation.

## Browser and WebSocket findings

### 16. Alpine depends on an external CDN

Both control surfaces require jsDelivr. An isolated church LAN cannot initialize the UI without internet access.

Remediation: ship the pinned Alpine runtime with embedded public assets.

### 17. Failed fader requests remain permanently in flight

The shared fader sender cleans its in-flight entry only on success. A network error can leave the UI permanently touched and stop server-state reconciliation.

Remediation: clean up in `finally`, guarded by controller identity.

### 18. OBS fader writes are unbounded during drag

Every input event sends a request while server echoes can overwrite the active drag position.

Remediation: use a shared fader controller with bounded throttling, a trailing final write, sequencing/abort handling, and an explicit local drag value.

### 19. PTZ movement can survive pointer cancellation

Held controls do not handle `pointercancel` or lost pointer capture.

Remediation: capture the pointer and stop movement on every release/cancellation/teardown path.

### 20. Bus WebSocket state conflates server and mixer connectivity

`bus-state` omits X32 connectivity, and bus-only clients receive full state messages they ignore.

Remediation: include mixer connectivity in `bus-state` and make topic subscriptions explicit.

### 21. Browser state processing causes avoidable churn

The client replaces every Alpine state slice for each full snapshot, subscribes to screenshots while previews are hidden, lacks a half-open connection watchdog, and reads thumbnail revisions from an unregistered store.

Remediation:

- Preserve unchanged state section references.
- Subscribe to screenshots only on preview-bearing tabs.
- Reconnect after missed heartbeats.
- Read revisions from `Alpine.store('state').proclaim`.

### 22. Frontend duplication and accessibility debt

The bus page duplicates WebSocket management; two fader components duplicate lifecycle logic. Icon-only controls lack stable accessible names, zoom is disabled, some touch targets are too small, and several CSS selectors are dead.

Remediation:

- Extract one managed WebSocket controller and one configurable fader controller.
- Move the bus script out of inline HTML.
- Add accessible labels, restore browser zoom, and use at least 44 px touch targets.
- Remove confirmed unused CSS before component-level extraction.

## Test, CI, and documentation findings

### 23. Some tests reimplement production behavior

OBS and early Proclaim tests contain local copies of production algorithms. Several smoke tests assert exports, literals, or non-throw behavior rather than consumer-visible contracts.

Remediation: exercise production exports through injected protocol clients, retain regression tests for discovered failures, and remove tautological cases.

### 24. CI omits declared checks

The package-level `check` command includes typechecking and console linting, but CI runs tests without both gates.

Remediation: run the complete check contract in CI and keep the stop hook aligned.

### 25. Contributor and user documentation is stale

Current documentation still describes Express, supertest, JavaScript source files, MIDI-based Proclaim control, three integrations, and an incomplete API/state model.

Remediation: document the current Bun/TypeScript runtime, five integrations, current routes, state sections, tests, and build commands.

## Implementation order

1. Authentication, host/origin enforcement, secret redaction, and request validation.
2. X32 immutability/liveness and PTZ state propagation.
3. Cancellable connection loops and resource bounds.
4. Frontend offline operation, control lifecycle, and WebSocket contract fixes.
5. Regression tests, CI alignment, and documentation refresh.
6. Full unit/e2e, Playwright, typecheck, and lint verification.
