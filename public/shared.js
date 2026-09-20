// shared.js — utilities shared between index.html and bus-mix.html

// Derive the base path from the current page URL so all API calls and WebSocket
// connections work when the app is hosted under a subpath (e.g. /service/).
// location.pathname for /service/ → basePath = '/service'
// location.pathname for /        → basePath = ''
// Exposed as window.basePath so Alpine template expressions can reference it.
const basePath = window.basePath = (() => {
  const p = location.pathname.replace(/\/[^/]*$/, ''); // strip trailing filename/segment
  return p === '/' ? '' : p;
})();

// X32 scribble strip color index → { border, bg } tuned for the dark navy theme.
// Indices 0 and 8 (Off) return null — the type-based CSS class acts as fallback.
const X32_COLOR_STYLES = [
  null,                                     //  0: Off
  { border: '#c0392b', bg: '#1a0d0d' },     //  1: Red
  { border: '#27ae60', bg: '#0d1a10' },     //  2: Green
  { border: '#c89020', bg: '#1a160d' },     //  3: Yellow
  { border: '#2471a3', bg: '#0d1220' },     //  4: Blue
  { border: '#8e44ad', bg: '#160d1a' },     //  5: Magenta
  { border: '#17a589', bg: '#0d1a18' },     //  6: Cyan
  { border: '#6e7080', bg: null },          //  7: White
  null,                                     //  8: Off (bright)
  { border: '#e74c3c', bg: '#200e0e' },     //  9: Red bright
  { border: '#2ecc71', bg: '#0e2014' },     // 10: Green bright
  { border: '#f39c12', bg: '#201a0e' },     // 11: Yellow bright
  { border: '#3498db', bg: '#0e1428' },     // 12: Blue bright
  { border: '#9b59b6', bg: '#1c0e20' },     // 13: Magenta bright
  { border: '#1abc9c', bg: '#0e201e' },     // 14: Cyan bright
  { border: '#9090b0', bg: '#16161e' },     // 15: White bright
];

// Returns an inline style string for a channel strip based on its X32 color.
function x32ChStyle(ch) {
  const s = ch.color && X32_COLOR_STYLES[ch.color];
  if (!s) return '';
  return s.bg ? `border-color:${s.border};background:${s.bg};` : `border-color:${s.border};`;
}

// Returns an inline color style for an overview label.
function x32LabelStyle(ch) {
  const s = ch.color && X32_COLOR_STYLES[ch.color];
  return s ? `color:${s.border};` : '';
}

// Convert a linear 0–1 amplitude multiplier to a 0–100 display percentage using a dB scale.
function mulToDisplayPct(mul) {
  if (mul <= 0) return 0;
  const db = 20 * Math.log10(mul);
  return Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
}

// POST helper
function post(url, body) {
  const fullUrl = basePath + url;
  fetch(fullUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((res) => { if (!res.ok) res.text().then((t) => console.error(`POST ${fullUrl} failed (${res.status}):`, t)); })
    .catch((err) => console.error(`POST ${fullUrl} error:`, err));
}

function toggleX32Mute(channel, type) { post('/api/x32/mute', { channel, type }); }

// Sends a fader POST, cancelling only the previous request for the same key.
// The identity check in finally is important: an aborted request must not delete
// the controller for a newer request that replaced it.
function sendFader(inflight, key, url, body) {
  const previous = inflight.get(key);
  if (previous) previous.abort();
  const controller = new AbortController();
  inflight.set(key, controller);
  const fullUrl = basePath + url;
  return fetch(fullUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then((res) => {
      if (!res.ok) {
        return res.text().then((text) => {
          console.error(`POST ${fullUrl} failed (${res.status}):`, text);
          throw new Error(`POST ${fullUrl} failed (${res.status})`);
        });
      }
      return res;
    })
    .catch((err) => {
      if (err.name !== 'AbortError') console.error(`POST ${fullUrl} error:`, err);
      return undefined;
    })
    .finally(() => {
      if (inflight.get(key) === controller) inflight.delete(key);
    });
}

// All fader instances are registered by their stable key.  This lets the app
// reconcile a local drag against the next state snapshot without coupling the
// generic controller to either the X32 or OBS state shape.
const _managedFaders = new Map();

function _faderKey(options, source, args) {
  const key = typeof options.key === 'function' ? options.key(source, ...args) : options.key;
  return key == null ? null : String(key);
}

function _registerFader(instance, key) {
  if (key == null) return;
  let instances = _managedFaders.get(key);
  if (!instances) { instances = new Set(); _managedFaders.set(key, instances); }
  instances.add(instance);
}

function _unregisterFader(instance, key) {
  if (key == null) return;
  const instances = _managedFaders.get(key);
  if (!instances) return;
  instances.delete(instance);
  if (instances.size === 0) _managedFaders.delete(key);
}

function reconcileManagedFader(key, source, value) {
  const instances = _managedFaders.get(String(key));
  if (!instances) return;
  for (const instance of instances) instance.reconcile(source, value);
}

function findManagedFader(key) {
  const instances = _managedFaders.get(String(key));
  return instances ? instances.values().next().value : null;
}

// Build an Alpine data provider for a fader.  The returned function accepts the
// source object used by x-for (and optional extra arguments), so it can be used
// both as Alpine.data('name', provider) and directly from x-data="name(...)".
//
// Supported options:
//   key(source, ...args), url(source, value), buildBody(source, value, ...args)
//   getValue(source, ...args), applyLocal(source, value), min, max,
//   throttleMs (default 75), releaseOnWrite (default false)
function createFaderComponent(options = {}) {
  const config = {
    throttleMs: 75,
    min: -Infinity,
    max: Infinity,
    ...options,
  };

  return function managedFader(source, ...args) {
    const instance = {
      touched: false,
      value: undefined,
      _source: source,
      _args: args,
      _key: null,
      _pendingValue: null,
      _lastSentAt: 0,
      _writeTimer: null,
      _releaseTimer: null,
      _inflight: null,
      _sequence: 0,
      _releaseRequested: false,

      init() {
        this._setSource(source, args);
        const serverValue = this._readValue(source, args);
        if (serverValue !== undefined) this.value = serverValue;
      },

      _readValue(currentSource, currentArgs) {
        if (typeof config.getValue !== 'function') return undefined;
        const raw = config.getValue(currentSource, ...currentArgs);
        const number = Number(raw);
        return Number.isFinite(number) ? this._clamp(number) : undefined;
      },

      _clamp(raw) {
        const number = Number(raw);
        if (!Number.isFinite(number)) return null;
        return Math.max(config.min, Math.min(config.max, number));
      },

      _setSource(currentSource, currentArgs = this._args) {
        const nextKey = _faderKey(config, currentSource, currentArgs);
        if (nextKey !== this._key) {
          _unregisterFader(this, this._key);
          this._key = nextKey;
          _registerFader(this, this._key);
        }
        this._source = currentSource;
        this._args = currentArgs;
      },

      _scheduleWrite() {
        if (this._pendingValue === null || this._pendingValue === undefined) return;
        const elapsed = Date.now() - this._lastSentAt;
        const wait = Math.max(0, config.throttleMs - elapsed);
        clearTimeout(this._writeTimer);
        this._writeTimer = setTimeout(() => {
          this._writeTimer = null;
          this._flushWrite();
        }, wait);
      },

      _flushWrite() {
        if (this._pendingValue === null || this._pendingValue === undefined) return;
        const value = this._pendingValue;
        this._pendingValue = null;
        this._lastSentAt = Date.now();
        this._send(value);
        if (this._pendingValue !== null && this._pendingValue !== undefined) this._scheduleWrite();
      },

      _send(value) {
        if (this._inflight) this._inflight.controller.abort();
        const controller = new AbortController();
        const request = { controller, sequence: ++this._sequence, value };
        this._inflight = request;
        let requestPromise;
        try {
          const url = typeof config.url === 'function' ? config.url(this._source, value, ...this._args) : config.url;
          const body = typeof config.buildBody === 'function'
            ? config.buildBody(this._source, value, ...this._args)
            : { value };
          const fullUrl = basePath + url;
          requestPromise = fetch(fullUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          requestPromise = requestPromise.then((res) => {
            if (!res.ok) {
              return res.text().then((text) => {
                console.error(`POST ${fullUrl} failed (${res.status}):`, text);
                throw new Error(`POST ${fullUrl} failed (${res.status})`);
              });
            }
            return res;
          });
        } catch (err) {
          requestPromise = Promise.reject(err);
        }
        requestPromise
          .catch((err) => {
            if (err.name !== 'AbortError') console.error('POST fader error:', err);
          })
          .finally(() => {
            // A superseded request must not settle the current request.
            if (this._inflight !== request) return;
            this._inflight = null;
            if (this._pendingValue !== null && this._pendingValue !== undefined) {
              this._scheduleWrite();
            } else if (this._releaseRequested) {
              this.touched = false;
              this._releaseRequested = false;
            }
          });
      },

      setFaderValue(raw, currentSource = this._source, currentArgs = this._args) {
        const value = this._clamp(raw);
        if (value === null) return;
        this._setSource(currentSource, currentArgs);
        this.touched = true;
        this._releaseRequested = !!config.releaseOnWrite;
        this.value = value;
        if (typeof config.applyLocal === 'function') config.applyLocal(currentSource, value, ...currentArgs);
        this._pendingValue = value;
        this._scheduleWrite();
      },

      onFaderInput(currentSource, element) {
        this.setFaderValue(element?.value, currentSource);
      },

      releaseSoon() {
        this._releaseRequested = true;
        clearTimeout(this._releaseTimer);
        this._releaseTimer = setTimeout(() => {
          this._releaseTimer = null;
          if (this._pendingValue !== null && this._pendingValue !== undefined) this._scheduleWrite();
          else if (!this._inflight) {
            this.touched = false;
            this._releaseRequested = false;
          }
        }, 0);
      },

      reconcile(currentSource, serverValue) {
        this._setSource(currentSource, this._args);
        const value = this._clamp(serverValue);
        if (value === null) return;
        // While dragging, retain the operator's local value. Once the server
        // echoes that value, release can safely hand control back to Alpine.
        if (this.touched && this.value !== undefined) {
          if (typeof config.applyLocal === 'function' && Math.abs(this.value - value) >= 1e-9) {
            config.applyLocal(currentSource, this.value, ...this._args);
          }
          if (Math.abs(this.value - value) < 1e-9) {
            if (this._releaseRequested && this._pendingValue === null && !this._inflight) {
              this.touched = false;
              this._releaseRequested = false;
            }
          }
          return;
        }
        if (!this.touched && this._pendingValue === null && !this._inflight) this.value = value;
      },
      destroy() {
        clearTimeout(this._writeTimer);
        clearTimeout(this._releaseTimer);
        if (this._inflight) this._inflight.controller.abort();
        this._inflight = null;
        _unregisterFader(this, this._key);
      },
    };
    return instance;
  };
}

const _x32FaderFactory = createFaderComponent({
  key: (ch) => ch && `${ch.type}-${ch.index}`,
  url: '/api/x32/fader',
  min: 0,
  max: 1,
  getValue: (ch) => ch?.fader,
  buildBody: (ch, value) => ({ channel: ch.index, type: ch.type, value }),
});

// X32 vertical fader Alpine component — tracks touch so server updates don't jump the slider.
function x32FaderComponent(ch) { return _x32FaderFactory(ch); }

// Bus send fader Alpine component.  The bus page supplies busIndex as a
// closure and supplies the channel object on each input event.
function busSendFaderComponent(busIndex) {
  const factory = createFaderComponent({
    key: (ch) => ch && `ch${ch.index}-bus${busIndex}`,
    url: '/api/x32/bus-send',
    min: 0,
    max: 1,
    getValue: (ch) => ch?.busSends?.find((send) => send.busIndex === busIndex)?.level,
    buildBody: (ch, value) => ({ channel: ch.index, busIndex, value }),
  });
  const instance = factory(undefined);
  instance.getBusSendLevel = (ch) => ch?.busSends?.find((send) => send.busIndex === busIndex)?.level ?? 0;
  return instance;
}

window.createFaderComponent = createFaderComponent;
window.reconcileManagedFader = reconcileManagedFader;
window.findManagedFader = findManagedFader;

// Bus pages and older callers can continue using these names.
// Register this after Alpine is loaded: Alpine.data('x32Fader', x32FaderComponent)

// --- Levels message handler (called from the unified WS onmessage) ---
// Applies x32/obs level data directly to DOM without going through Alpine.
function handleLevelsMessage(payload) {
  const { x32, obs } = payload;
  if (x32) {
    for (const [key, level] of Object.entries(x32)) {
      const els = document.querySelectorAll(`[data-level-key="${key}"]`);
      for (const el of els) el.style.width = mulToDisplayPct(level).toFixed(1) + '%';
    }
  }
  if (obs) {
    for (const [name, level] of Object.entries(obs)) {
      const els = document.querySelectorAll(`[data-level-obs="${CSS.escape(name)}"]`);
      for (const el of els) el.style.width = mulToDisplayPct(level).toFixed(1) + '%';
    }
  }
}

// Registry of managed WebSockets. The original registerManagedWs API remains
// available for bus-mix.html until its inline connection is migrated.
const _managedWs = [];

function registerManagedWs(entry) {
  if (!_managedWs.includes(entry)) _managedWs.push(entry);
  return () => {
    const index = _managedWs.indexOf(entry);
    if (index >= 0) _managedWs.splice(index, 1);
  };
}

function createManagedWebSocket(options = {}) {
  const initialDelay = Math.max(0, options.reconnectInitialMs ?? options.reconnectInitial ?? 1000);
  const maxDelay = Math.max(initialDelay, options.reconnectMaxMs ?? options.reconnectMax ?? 10000);
  const heartbeatInterval = options.heartbeatIntervalMs ?? options.heartbeatInterval ?? 10000;
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? options.heartbeatTimeout
    ?? heartbeatInterval * (options.missedHeartbeats ?? 3);
  const topics = new Set(options.subscriptions ?? options.topics ?? []);
  let socket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let reconnectDelay = initialDelay;
  let lastMessageAt = 0;
  let generation = 0;
  let stopped = false;

  function wsUrl() {
    if (typeof options.url === 'function') return options.url([...topics]);
    if (options.url) return options.url;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = new URL(`${proto}://${location.host}${basePath}/ws`);
    if (topics.size > 0) url.searchParams.set('topics', [...topics].join(','));
    return url.toString();
  }

  function clearReconnect() {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function clearHeartbeat() {
    if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify(message)); } catch { /* close handler reconnects */ }
      return true;
    }
    return false;
  }

  function sendSubscriptions() {
    if (topics.size > 0) send({ type: 'subscribe', channels: [...topics] });
  }

  function startHeartbeat(currentSocket, currentGeneration) {
    clearHeartbeat();
    if (!(heartbeatInterval > 0) || !(heartbeatTimeout > 0)) return;
    lastMessageAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (socket !== currentSocket || generation !== currentGeneration) return;
      if (Date.now() - lastMessageAt >= heartbeatTimeout) {
        clearHeartbeat();
        // Do not wait for a half-open browser socket to deliver close. Invalidate
        // this generation, notify the consumer, and schedule the replacement now.
        socket = null;
        ++generation;
        try { currentSocket.close(); } catch { /* already closed */ }
        if (typeof options.onClose === 'function') options.onClose({ code: 1000, reason: 'heartbeat timeout' }, controller);
        scheduleReconnect();
      }
    }, heartbeatInterval);
  }

  function scheduleReconnect() {
    if (stopped || document.hidden || reconnectTimer !== null) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(maxDelay, reconnectDelay * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped || document.hidden) return;
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
    clearReconnect();
    const currentGeneration = ++generation;
    const currentSocket = socket = new WebSocket(wsUrl(), options.protocols);
    currentSocket.binaryType = 'blob';
    currentSocket.onopen = () => {
      if (socket !== currentSocket || generation !== currentGeneration) return;
      reconnectDelay = initialDelay;
      startHeartbeat(currentSocket, currentGeneration);
      sendSubscriptions();
      if (typeof options.onOpen === 'function') options.onOpen(currentSocket, controller);
    };
    currentSocket.onmessage = (event) => {
      if (socket !== currentSocket || generation !== currentGeneration) return;
      lastMessageAt = Date.now();
      if (typeof options.onMessage === 'function') options.onMessage(event, controller);
    };
    currentSocket.onerror = (event) => {
      if (socket === currentSocket && typeof options.onError === 'function') options.onError(event, controller);
    };
    currentSocket.onclose = (event) => {
      if (socket !== currentSocket || generation !== currentGeneration) return;
      socket = null;
      clearHeartbeat();
      if (typeof options.onClose === 'function') options.onClose(event, controller);
      scheduleReconnect();
    };
  }

  function close() {
    clearReconnect();
    clearHeartbeat();
    const currentSocket = socket;
    if (currentSocket) {
      socket = null;
      ++generation;
      try { currentSocket.close(); } catch { /* already closed */ }
    }
  }

  function subscribe(channels) {
    const added = [];
    for (const channel of (Array.isArray(channels) ? channels : [channels])) {
      if (typeof channel !== 'string' || topics.has(channel)) continue;
      topics.add(channel); added.push(channel);
    }
    if (added.length > 0) send({ type: 'subscribe', channels: added });
  }

  function unsubscribe(channels) {
    const removed = [];
    for (const channel of (Array.isArray(channels) ? channels : [channels])) {
      if (typeof channel !== 'string' || !topics.has(channel)) continue;
      topics.delete(channel); removed.push(channel);
    }
    if (removed.length > 0) send({ type: 'unsubscribe', channels: removed });
  }

  let controller;
  const entry = {
    getWs: () => socket,
    reconnect: () => { stopped = false; reconnectDelay = initialDelay; connect(); },
    resetDelay: () => { reconnectDelay = initialDelay; },
  };
  const unregister = registerManagedWs(entry);
  controller = {
    connect,
    close,
    send,
    subscribe,
    unsubscribe,
    teardown() {
      stopped = true;
      unregister();
      close();
      if (typeof options.onTeardown === 'function') options.onTeardown();
    },
    get socket() { return socket; },
    get subscriptions() { return [...topics]; },
  };

  if (options.autoConnect !== false) connect();
  return controller;
}

window.createManagedWebSocket = createManagedWebSocket;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const { getWs } of _managedWs) getWs()?.close();
  } else {
    for (const { resetDelay, reconnect } of _managedWs) {
      resetDelay();
      reconnect();
    }
  }
});
