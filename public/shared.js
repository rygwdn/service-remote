// shared.js — utilities shared between index.html and bus-mix.html

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
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((res) => { if (!res.ok) res.text().then((t) => console.error(`POST ${url} failed (${res.status}):`, t)); })
    .catch((err) => console.error(`POST ${url} error:`, err));
}

function toggleX32Mute(channel, type) { post('/api/x32/mute', { channel, type }); }

// Sends a fader POST, cancelling any in-flight request for the same key.
// Returns the fetch promise (resolves when the server responds).
// inflight: Map<key, AbortController> — shared per component instance.
function sendFader(inflight, key, url, body) {
  const prev = inflight.get(key);
  if (prev) prev.abort();
  const ctrl = new AbortController();
  inflight.set(key, ctrl);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })
    .then((res) => {
      inflight.delete(key);
      if (!res.ok) res.text().then((t) => console.error(`POST ${url} failed (${res.status}):`, t));
    })
    .catch((err) => {
      if (err.name !== 'AbortError') console.error(`POST ${url} error:`, err);
      // AbortError is expected when a newer drag value supersedes this one.
    });
}

// X32 vertical fader Alpine component — tracks touch so server updates don't jump the slider.
// touched stays true until the server responds (or the request is replaced by a newer one).
// Register this after Alpine is loaded: Alpine.data('x32Fader', x32FaderComponent)
function x32FaderComponent() {
  return {
    touched: false,
    _debounce: null,
    _inflight: new Map(),
    releaseSoon() {
      // touched clears only after all in-flight requests for this fader settle.
      // We check on a short poll rather than tracking each promise individually.
      clearTimeout(this._releaseTimer);
      this._releaseTimer = setInterval(() => {
        if (this._inflight.size === 0) {
          clearInterval(this._releaseTimer);
          this._releaseTimer = null;
          this.touched = false;
        }
      }, 50);
    },
    onFaderInput(ch, el) {
      clearTimeout(this._debounce);
      const value = parseFloat(el.value);
      this._debounce = setTimeout(() => {
        const key = `${ch.type}-${ch.index}`;
        sendFader(this._inflight, key, '/api/x32/fader', { channel: ch.index, type: ch.type, value });
      }, 50);
    },
  };
}

// Bus send fader Alpine component — same approach but posts to /api/x32/bus-send.
function busSendFaderComponent(busIndex) {
  return {
    touched: false,
    _debounce: null,
    _inflight: new Map(),
    releaseSoon() {
      clearTimeout(this._releaseTimer);
      this._releaseTimer = setInterval(() => {
        if (this._inflight.size === 0) {
          clearInterval(this._releaseTimer);
          this._releaseTimer = null;
          this.touched = false;
        }
      }, 50);
    },
    onFaderInput(ch, el) {
      clearTimeout(this._debounce);
      const value = parseFloat(el.value);
      this._debounce = setTimeout(() => {
        const key = `ch${ch.index}-bus${busIndex}`;
        sendFader(this._inflight, key, '/api/x32/bus-send', { channel: ch.index, busIndex, value });
      }, 50);
    },
    getBusSendLevel(ch) {
      const send = ch.busSends?.find((s) => s.busIndex === busIndex);
      return send?.level ?? 0;
    },
  };
}

// --- Levels WebSocket (direct DOM updates, bypasses Alpine) ---
let levelsWsConn;
let levelsReconnectDelay = 1000;

function connectLevelsWs() {
  if (levelsWsConn && levelsWsConn.readyState < WebSocket.CLOSING) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  levelsWsConn = new WebSocket(`${proto}://${location.host}/ws/levels`);

  levelsWsConn.onopen = () => { levelsReconnectDelay = 1000; };

  levelsWsConn.onmessage = (e) => {
    const { x32, obs } = JSON.parse(e.data);
    if (x32) {
      for (const [key, level] of Object.entries(x32)) {
        const els = document.querySelectorAll(`[data-level-key="${key}"]`);
        for (const el of els) {
          el.style.width = mulToDisplayPct(level).toFixed(1) + '%';
        }
      }
    }
    if (obs) {
      for (const [name, level] of Object.entries(obs)) {
        const els = document.querySelectorAll(`[data-level-obs="${CSS.escape(name)}"]`);
        for (const el of els) {
          el.style.width = mulToDisplayPct(level).toFixed(1) + '%';
        }
      }
    }
  };

  levelsWsConn.onclose = () => {
    if (document.hidden) return;
    setTimeout(connectLevelsWs, levelsReconnectDelay);
    levelsReconnectDelay = Math.min(levelsReconnectDelay * 2, 10000);
  };
}

// Registry of all managed WebSocket connections for visibility-change handling.
// Each entry: { getWs: () => ws, reconnect: () => void, resetDelay: () => void }
const _managedWs = [];

function registerManagedWs(entry) {
  _managedWs.push(entry);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const { getWs } of _managedWs) {
      getWs()?.close();
    }
  } else {
    for (const { resetDelay, reconnect } of _managedWs) {
      resetDelay();
      reconnect();
    }
  }
});

// Register the levels WS
registerManagedWs({
  getWs: () => levelsWsConn,
  reconnect: connectLevelsWs,
  resetDelay: () => { levelsReconnectDelay = 1000; },
});
