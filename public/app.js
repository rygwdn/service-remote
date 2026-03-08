// --- Alpine store + components ---
document.addEventListener('alpine:init', () => {

  // Main server state mirror
  Alpine.store('state', {
    obs: { connected: false, scenes: [], currentScene: '', streaming: false, recording: false, audioSources: [] },
    x32: { connected: false, channels: [] },
    proclaim: { connected: false, onAir: false, currentItemId: null, currentItemTitle: null, currentItemType: null, slideIndex: null, serviceItems: [] },
    ptz: { cameras: [] },
    youtube: { connected: false, viewerCount: null, broadcastTitle: null, broadcastId: null, broadcastStatus: null },
  });

  // UI state
  Alpine.store('ui', {
    tab: 'overview',
    editMode: { obs: false, x32: false },
    faderEnabled: { obs: false, x32: false },
    hidden: { obs: [] },
    serverConnected: false,

    setTab(tab) {
      this.tab = tab;
    },
    toggleEditMode(panel) {
      this.editMode[panel] = !this.editMode[panel];
    },
    toggleFaderEnabled(panel) {
      this.faderEnabled[panel] = !this.faderEnabled[panel];
    },
    isHiddenObs(name) { return this.hidden.obs.includes(name); },
    isHiddenX32(key) {
      // Main M/C (index 2) is always hidden — unused.
      // Main L/R (index 1) is always shown.
      // All other channels are shown only when assigned to DCA group 8 (ch.spill === true).
      const ch = Alpine.store('state').x32.channels.find(
        (c) => c.type + '/' + c.index === key
      );
      if (!ch) return true;
      if (ch.type === 'main') return ch.index === 2;
      return !ch.spill;
    },
  });

  // X32 vertical fader — tracks touch so server updates don't jump the slider
  Alpine.data('x32Fader', () => ({
    touched: false,
    _releaseTimer: null,
    releaseSoon() {
      clearTimeout(this._releaseTimer);
      this._releaseTimer = setTimeout(() => { this.touched = false; }, 500);
    },
    onFaderInput(ch, el) {
      const key = ch.type + '/' + ch.index;
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => {
        setX32Fader(ch.index, ch.type, parseFloat(el.value));
      }, 50);
    },
  }));

  // OBS audio row (placeholder — no special touch state needed for horizontal sliders)
  Alpine.data('obsFader', () => ({}));

  // Start WebSocket connections after stores are ready so onopen/onclose can
  // safely call Alpine.store() without racing against Alpine's own load.
  connectWs();

  // Settings panel state
  Alpine.data('settingsPanel', () => ({
    cfg: {
      obs: { address: '', password: '', screenshotInterval: 1000 },
      x32: { address: '', port: 10023 },
      proclaim: { host: '', port: 52195, password: '', pollInterval: 1000 },
      ptz: { cameras: [] },
      youtube: { broadcastId: '', pollInterval: 30000 },
    },
    discoverStatus: { obs: '', x32: '', proclaim: '' },
    saveStatus: '',
    importObsStatus: '',
    logs: [],
    serverAddresses: [],

    async init() {
      await this.loadConfig();
      await this.loadLogs();
      await this.loadServerAddresses();
    },

    async loadServerAddresses() {
      try {
        const res = await fetch('/api/server/addresses');
        const data = await res.json();
        this.serverAddresses = data.addresses ?? [];
      } catch (_) { /* non-critical */ }
    },

    async loadConfig() {
      const data = await fetchConfig();
      if (!data) { this.saveStatus = 'Failed to load config'; return; }
      this.cfg.obs.address             = data.obs?.address ?? '';
      this.cfg.obs.password            = data.obs?.password ?? '';
      this.cfg.obs.screenshotInterval  = data.obs?.screenshotInterval ?? 1000;
      this.cfg.x32.address             = data.x32?.address ?? '';
      this.cfg.x32.port                = data.x32?.port ?? 10023;
      this.cfg.proclaim.host           = data.proclaim?.host ?? '';
      this.cfg.proclaim.port           = data.proclaim?.port ?? 52195;
      this.cfg.proclaim.password       = data.proclaim?.password ?? '';
      this.cfg.proclaim.pollInterval   = data.proclaim?.pollInterval ?? 1000;
      this.cfg.ptz.cameras = (data.ptz?.cameras ?? []).map(c => ({
        name: c.name ?? 'Camera',
        enabled: c.enabled ?? false,
        address: c.address ?? '192.168.1.101',
        port: c.port ?? 52381,
        cameraId: c.cameraId ?? 1,
        numPresets: c.numPresets ?? 9,
      }));
      this.cfg.youtube.broadcastId               = data.youtube?.broadcastId ?? '';
      this.cfg.youtube.pollInterval              = data.youtube?.pollInterval ?? 30000;
    },

    async saveConfig() {
      this.saveStatus = 'Saving…';
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.cfg),
        });
        const data = await res.json();
        this.saveStatus = data.ok ? 'Saved!' : 'Error: ' + (data.error || 'unknown');
        if (data.ok) { currentConfig = this.cfg; }
      } catch (err) {
        this.saveStatus = 'Error: ' + err.message;
      }
      setTimeout(() => { this.saveStatus = ''; }, 3000);
    },

    async discoverObs() {
      this.discoverStatus.obs = 'Checking…';
      try {
        const res = await fetch('/api/discover/obs', { method: 'POST' });
        const data = await res.json();
        if (data.found) { this.cfg.obs.address = data.address; this.discoverStatus.obs = 'Found'; }
        else { this.discoverStatus.obs = 'Not found'; }
      } catch (_) { this.discoverStatus.obs = 'Error'; }
    },

    async discoverX32() {
      this.discoverStatus.x32 = 'Scanning…';
      try {
        const res = await fetch('/api/discover/x32', { method: 'POST' });
        const data = await res.json();
        if (data.found) { this.cfg.x32.address = data.address; this.discoverStatus.x32 = 'Found: ' + data.address; }
        else { this.discoverStatus.x32 = 'Not found'; }
      } catch (_) { this.discoverStatus.x32 = 'Error'; }
    },

    async discoverProclaim() {
      this.discoverStatus.proclaim = 'Checking…';
      try {
        const res = await fetch('/api/discover/proclaim', { method: 'POST' });
        const data = await res.json();
        if (data.found) {
          this.cfg.proclaim.host = data.address;
          this.cfg.proclaim.port = data.port;
          this.discoverStatus.proclaim = 'Found';
        } else { this.discoverStatus.proclaim = 'Not found'; }
      } catch (_) { this.discoverStatus.proclaim = 'Error'; }
    },

    youtubeBroadcasts: [],
    youtubeBroadcastsStatus: '',

    async findYouTubeBroadcasts() {
      this.youtubeBroadcastsStatus = 'Searching…';
      this.youtubeBroadcasts = [];
      try {
        const res = await fetch('/api/youtube/broadcasts');
        const data = await res.json();
        if (!res.ok) {
          this.youtubeBroadcastsStatus = 'Error: ' + (data.error || 'unknown');
          return;
        }
        this.youtubeBroadcasts = data.broadcasts ?? [];
        if (this.youtubeBroadcasts.length === 0) {
          this.youtubeBroadcastsStatus = 'No active or scheduled broadcasts found';
        } else {
          this.youtubeBroadcastsStatus = '';
        }
      } catch (err) {
        this.youtubeBroadcastsStatus = 'Error: ' + err.message;
      }
    },


    async loadLogs() {
      try {
        const res = await fetch('/api/logs');
        const data = await res.json();
        this.logs = data.logs || [];
        this.$nextTick(() => {
          if (this.$refs.logOutput) this.$refs.logOutput.scrollTop = this.$refs.logOutput.scrollHeight;
        });
      } catch (_) {}
    },
  }));
});

// --- WebSocket ---
let ws;
let reconnectDelay = 1000;

function connectWs() {
  // Don't create a new connection if one is already open or connecting
  if (ws && ws.readyState < WebSocket.CLOSING) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    if (window.Alpine) Alpine.store('ui').serverConnected = true;
  };

  ws.onmessage = (e) => {
    if (!window.Alpine) return;
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') {
      const store = Alpine.store('state');
      store.obs = msg.data.obs;
      store.x32 = msg.data.x32;
      store.proclaim = msg.data.proclaim;
      if (msg.data.ptz) store.ptz = msg.data.ptz;
      if (msg.data.youtube) store.youtube = msg.data.youtube;
    }
  };

  ws.onclose = () => {
    if (window.Alpine) Alpine.store('ui').serverConnected = false;
    // Don't schedule reconnect while the tab is hidden — visibilitychange will reconnect
    if (document.hidden) return;
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}


// --- Screenshot WebSocket ---
let screenshotWs;
let screenshotReconnectDelay = 1000;
let currentScreenshotUrl = null;

function connectScreenshotWs() {
  // Don't create a new connection if one is already open or connecting
  if (screenshotWs && screenshotWs.readyState < WebSocket.CLOSING) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  screenshotWs = new WebSocket(`${proto}://${location.host}/ws/screenshot`);
  screenshotWs.binaryType = 'blob';

  screenshotWs.onopen = () => { screenshotReconnectDelay = 1000; };

  screenshotWs.onmessage = (e) => {
    if (!(e.data instanceof Blob)) return;
    const newUrl = URL.createObjectURL(e.data);
    // Update both preview elements
    const p1 = document.getElementById('obs-preview');
    const p2 = document.getElementById('ov-obs-preview');
    if (p1) p1.src = newUrl;
    if (p2) p2.src = newUrl;
    // Revoke the previous object URL to avoid memory leaks
    if (currentScreenshotUrl) URL.revokeObjectURL(currentScreenshotUrl);
    currentScreenshotUrl = newUrl;
  };

  screenshotWs.onclose = () => {
    if (document.hidden) return;
    setTimeout(connectScreenshotWs, screenshotReconnectDelay);
    screenshotReconnectDelay = Math.min(screenshotReconnectDelay * 2, 10000);
  };
}

connectScreenshotWs();

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
// Returns '' when color is 0/8 so the type-based CSS class takes effect instead.
function x32ChStyle(ch) {
  const s = ch.color && X32_COLOR_STYLES[ch.color];
  if (!s) return '';
  return s.bg ? `border-color:${s.border};background:${s.bg};` : `border-color:${s.border};`;
}

// Returns an inline color style for an overview label. Empty when color is 0/8.
function x32LabelStyle(ch) {
  const s = ch.color && X32_COLOR_STYLES[ch.color];
  return s ? `color:${s.border};` : '';
}

// Sort X32 channels for display: main L/R first, then bus, then ch, then mtx.
const X32_TYPE_ORDER = { main: 0, bus: 1, ch: 2, mtx: 3 };
function sortedX32Channels(channels) {
  return [...channels].sort((a, b) => {
    const ta = X32_TYPE_ORDER[a.type] ?? 99;
    const tb = X32_TYPE_ORDER[b.type] ?? 99;
    if (ta !== tb) return ta - tb;
    return a.index - b.index;
  });
}

// Convert a linear 0–1 amplitude multiplier (as sent by OBS and X32) to a
// 0–100 display percentage using a dB scale mapped to [-60 dB, 0 dBFS].
// This gives perceptually useful meter widths: -20 dBFS ≈ 67%, silence = 0%.
function mulToDisplayPct(mul) {
  if (mul <= 0) return 0;
  const db = 20 * Math.log10(mul);
  return Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
}

// --- Levels WebSocket (direct DOM updates, bypasses Alpine) ---
let levelsWsConn;
let levelsReconnectDelay = 1000;

function connectLevelsWs() {
  // Don't create a new connection if one is already open or connecting
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

connectLevelsWs();

// --- Page Visibility: close WebSocket connections when the tab is hidden ---
// This prevents the browser from queuing stale events (screenshot frames, audio
// meter updates, state changes) that would all replay rapidly when the tab wakes.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Close all connections; their onclose handlers will skip the reconnect timer
    // when document.hidden is true, so no queuing happens.
    ws?.close();
    screenshotWs?.close();
    levelsWsConn?.close();
  } else {
    // Reset backoff delays and reconnect immediately when the tab becomes active.
    reconnectDelay = 1000;
    screenshotReconnectDelay = 1000;
    levelsReconnectDelay = 1000;
    connectWs();
    connectScreenshotWs();
    connectLevelsWs();
  }
});

// --- API helpers ---
function post(url, body) {
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((res) => { if (!res.ok) res.text().then((t) => console.error(`POST ${url} failed (${res.status}):`, t)); })
    .catch((err) => console.error(`POST ${url} error:`, err));
}

function sendAction(action, index) {
  const body = { action };
  if (index !== undefined) body.index = index;
  post('/api/proclaim/action', body);
}

function gotoItem(itemId) {
  post('/api/proclaim/goto-item', { itemId });
}

function startYouTubeBroadcast()        { post('/api/youtube/start', {}); }
function stopYouTubeBroadcast()         { post('/api/youtube/stop', {}); }
function setScene(scene)                { post('/api/obs/scene', { scene }); }
function toggleObsMute(input)           { post('/api/obs/mute', { input }); }
function setObsVolume(input, volumeDb)  { post('/api/obs/volume', { input, volumeDb }); }
function toggleStream()                 { post('/api/obs/stream', {}); }
function toggleRecord()                 { post('/api/obs/record', {}); }
function setX32Fader(channel, type, value) { post('/api/x32/fader', { channel, type, value }); }
function toggleX32Mute(channel, type)   { post('/api/x32/mute', { channel, type }); }

// --- PTZ ---
// Button repeat: fires immediately on press, then repeats after 350 ms delay at 200 ms intervals.
let _ptzRepeatTimer = null;
let _ptzRepeatInterval = null;

function ptzStartRepeat(action) {
  ptzStopRepeat();
  action();
  _ptzRepeatTimer = setTimeout(() => {
    _ptzRepeatInterval = setInterval(action, 200);
  }, 350);
}

function ptzStopRepeat() {
  clearTimeout(_ptzRepeatTimer);
  clearInterval(_ptzRepeatInterval);
  _ptzRepeatTimer = null;
  _ptzRepeatInterval = null;
}

function ptzPanTilt(camera, panDir, tiltDir, panSpeed, tiltSpeed) {
  post('/api/ptz/pan-tilt', { camera, panDir, tiltDir, panSpeed, tiltSpeed });
}
function ptzZoom(camera, direction)  { post('/api/ptz/zoom',    { camera, direction }); }
function ptzFocus(camera, mode)      { post('/api/ptz/focus',   { camera, mode }); }
function ptzPreset(camera, action, preset) { post('/api/ptz/preset', { camera, action, preset }); }
function ptzHome(camera)             { post('/api/ptz/home',    { camera }); }

// --- Fader visibility ---
function toggleHiddenObs(name, show) {
  const ui = Alpine.store('ui');
  if (show) ui.hidden.obs = ui.hidden.obs.filter((n) => n !== name);
  else if (!ui.hidden.obs.includes(name)) ui.hidden.obs.push(name);
  saveHiddenToServer();
}

function toggleHiddenX32(key, show) {
  // Optimistic update: reflect the change immediately in the local state so
  // the UI responds without waiting for the X32 to echo back the new DCA assignment.
  const ch = Alpine.store('state').x32.channels.find((c) => c.type + '/' + c.index === key);
  if (ch && ch.type !== 'main') ch.spill = show;

  // Persist the DCA 8 assignment change to the X32 via the server.
  const parts = key.split('/');
  const type = parts[0];
  const channel = parseInt(parts[1], 10);
  post('/api/x32/spill', { channel, type, assigned: show });
}

let saveHiddenTimer = null;
function saveHiddenToServer() {
  clearTimeout(saveHiddenTimer);
  saveHiddenTimer = setTimeout(async () => {
    const ui = Alpine.store('ui');
    try {
      await fetch('/api/ui/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiddenObs: ui.hidden.obs, hiddenX32: [] }),
      });
    } catch (_) {}
  }, 300);
}

async function loadHiddenFromServer() {
  try {
    const res = await fetch('/api/ui/hidden');
    if (!res.ok) return;
    const data = await res.json();
    const ui = Alpine.store('ui');
    ui.hidden.obs = data.hiddenObs || [];
    // X32 visibility is driven by channel.spill (received via WebSocket from the X32),
    // not stored in config.
  } catch (_) {}
}

let currentConfig = null;

// --- Template helpers (called from x-html / x-for expressions) ---

let thumbRevision = 0;

function thumbUrl(itemId, slideIndex) {
  const p = Alpine.store('proclaim');
  const localRevision = p?.slideRevisions?.[itemId]?.[String(slideIndex)] ?? thumbRevision;
  return `/api/proclaim/thumb?itemId=${encodeURIComponent(itemId)}&slideIndex=${encodeURIComponent(slideIndex)}&localRevision=${encodeURIComponent(localRevision)}`;
}

function thumbHtml(thumb) {
  if (!thumb || thumb.itemId == null || thumb.slideIndex == null) return '';
  const url = thumbUrl(thumb.itemId, thumb.slideIndex);
  // url is built entirely from encodeURIComponent values so it's safe to embed
  // in an attribute. Use escaped single-quotes so the attribute value stays valid.
  const escapedUrl = url.replace(/'/g, '%27');
  return `<img src="${escapedUrl}" onerror="this._r=(this._r||0);if(this._r++<5)setTimeout(()=>{this.src='${escapedUrl}&r='+this._r},500)">`;
}

function ovNowPlaying(p) {
  if (!p.onAir || !p.currentItemId) {
    return p.connected ? 'Not on air' : 'Disconnected';
  }
  const typeLabel = p.currentItemType ? `<span class="item-type">${esc(p.currentItemType)}</span> ` : '';
  const slideInfo = p.slideIndex !== null ? ` &mdash; Slide ${p.slideIndex + 1}` : '';
  return `${typeLabel}<strong>${esc(p.currentItemTitle || '')}</strong>${slideInfo}`;
}

function ovThumbs(p) {
  if (!p.onAir || !p.currentItemId) return { prev: null, current: null, next: null };

  const items = p.serviceItems || [];
  const currentItemIdx = items.findIndex((item) => item.id === p.currentItemId);
  const currentItem = items[currentItemIdx];
  const slideIndex = p.slideIndex !== null ? p.slideIndex : 0;

  let prev = null, next = null;

  if (currentItem) {
    if (slideIndex > 0) {
      prev = { itemId: p.currentItemId, slideIndex: slideIndex - 1 };
    } else if (currentItemIdx > 0) {
      const prevItem = items[currentItemIdx - 1];
      prev = { itemId: prevItem.id, slideIndex: Math.max(0, (prevItem.slideCount || 1) - 1) };
    }

    const slideCount = currentItem.slideCount || 1;
    if (slideIndex < slideCount - 1) {
      next = { itemId: p.currentItemId, slideIndex: slideIndex + 1 };
    } else if (currentItemIdx < items.length - 1) {
      next = { itemId: items[currentItemIdx + 1].id, slideIndex: 0 };
    }
  }

  return {
    prev,
    current: { itemId: p.currentItemId, slideIndex },
    next,
  };
}

function slideGridVisible(p) {
  if (!p.onAir || !p.currentItemId) return false;
  const items = p.serviceItems || [];
  const item = items.find((it) => it.id === p.currentItemId);
  return item && item.slideCount > 1;
}

function slideGridItems(p) {
  const items = p.serviceItems || [];
  const item = items.find((it) => it.id === p.currentItemId);
  if (!item || item.slideCount <= 1) return [];
  return Array.from({ length: item.slideCount }, (_, i) => i);
}

function flatServiceItems(p) {
  if (!p.onAir || !p.currentItemId) return [];
  const items = p.serviceItems || [];
  const result = [];
  let currentSection = null;
  let currentGroup = null;

  for (const item of items) {
    if (item.section !== currentSection) {
      currentSection = item.section;
      currentGroup = null;
      result.push({ type: 'section', key: 'section:' + item.section, label: item.section });
    }
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      if (currentGroup) {
        result.push({ type: 'group', key: 'group:' + item.section + ':' + currentGroup, label: currentGroup });
      }
    }
    const isActive = item.id === p.currentItemId;
    let slideCountLabel = '';
    if (item.slideCount > 1) {
      slideCountLabel = isActive && p.slideIndex !== null
        ? `(${p.slideIndex + 1} of ${item.slideCount})`
        : `(${item.slideCount} slides)`;
    }
    result.push({ type: 'item', key: 'item:' + item.id, item, isActive, slideCountLabel });
  }
  return result;
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Fetch config from server and store in currentConfig. Returns the data or null on failure.
async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return null;
    currentConfig = await res.json();
    return currentConfig;
  } catch (_) {
    return null;
  }
}

// --- Init ---
async function init() {
  await loadHiddenFromServer();
  await fetchConfig();
}

init();
