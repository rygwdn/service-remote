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
    authRequired: false,
    tokenInput: 'hbc123',

    submitToken() {
      const value = this.tokenInput.trim();
      if (!value) return;
      window.location.assign(basePath + '/?token=' + encodeURIComponent(value));
    },

    setTab(tab) {
      this.tab = tab;
      updateScreenshotSubscription(tab);
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

  // X32 fader — shared controller preserves local drags while snapshots arrive.
  Alpine.data('x32Fader', x32FaderComponent);

  // OBS fader — the input binding calls setObsVolume; the shared instance is
  // looked up by source name and provides bounded, trailing writes.
  Alpine.data('obsFader', createFaderComponent({
    key: (src) => src && `obs/${src.name}`,
    url: '/api/obs/volume',
    min: -60,
    max: 0,
    getValue: (src) => src?.volume,
    applyLocal: (src, value) => { if (src) src.volume = value; },
    buildBody: (src, value) => ({ input: src.name, volumeDb: value }),
    releaseOnWrite: true,
  }));

  // Start after stores are ready so callbacks can safely update Alpine.
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
        const res = await fetch(basePath + '/api/server/addresses');
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
        const res = await fetch(basePath + '/api/config', {
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
        const res = await fetch(basePath + '/api/discover/obs', { method: 'POST' });
        const data = await res.json();
        if (data.found) { this.cfg.obs.address = data.address; this.discoverStatus.obs = 'Found'; }
        else { this.discoverStatus.obs = 'Not found'; }
      } catch (_) { this.discoverStatus.obs = 'Error'; }
    },

    async discoverX32() {
      this.discoverStatus.x32 = 'Scanning…';
      try {
        const res = await fetch(basePath + '/api/discover/x32', { method: 'POST' });
        const data = await res.json();
        if (data.found) { this.cfg.x32.address = data.address; this.discoverStatus.x32 = 'Found: ' + data.address; }
        else { this.discoverStatus.x32 = 'Not found'; }
      } catch (_) { this.discoverStatus.x32 = 'Error'; }
    },

    async discoverProclaim() {
      this.discoverStatus.proclaim = 'Checking…';
      try {
        const res = await fetch(basePath + '/api/discover/proclaim', { method: 'POST' });
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
        const res = await fetch(basePath + '/api/youtube/broadcasts');
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
        const res = await fetch(basePath + '/api/logs');
        const data = await res.json();
        this.logs = data.logs || [];
        this.$nextTick(() => {
          if (this.$refs.logOutput) this.$refs.logOutput.scrollTop = this.$refs.logOutput.scrollHeight;
        });
      } catch (_) {}
    },
  }));
});

// --- Unified WebSocket (/ws) ---
// State and levels are always needed. Screenshots are added only while a tab
// that displays a preview is active.
let ws = null;
let wsController = null;
let currentScreenshotUrl = null;

const PREVIEW_TABS = new Set(['overview', 'obs', 'camera']);

function updateScreenshotSubscription(tab = Alpine.store('ui')?.tab) {
  if (!wsController) return;
  if (PREVIEW_TABS.has(tab)) wsController.subscribe('screenshot');
  else wsController.unsubscribe('screenshot');
}

function sameStateValue(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => sameStateValue(item, b[i]));
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameStateValue(a[key], b[key]));
}

function applyStateSnapshot(data) {
  if (!window.Alpine || !data || typeof data !== 'object') return;
  const store = Alpine.store('state');
  for (const section of ['obs', 'x32', 'proclaim', 'ptz', 'youtube']) {
    if (!Object.prototype.hasOwnProperty.call(data, section)) continue;
    if (!sameStateValue(store[section], data[section])) store[section] = data[section];
  }

  // Let active faders retain their local value until the server echoes it.
  for (const ch of data.x32?.channels ?? []) {
    window.reconcileManagedFader?.(`${ch.type}-${ch.index}`, ch, ch.fader);
  }
  for (const source of data.obs?.audioSources ?? []) {
    window.reconcileManagedFader?.(`obs/${source.name}`, source, source.volume);
  }
}

function updateScreenshotFrame(data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/jpeg' });
  const newUrl = URL.createObjectURL(blob);
  const tab = Alpine.store('ui')?.tab;
  const ids = tab === 'overview' ? ['ov-obs-preview']
    : tab === 'obs' ? ['obs-preview']
      : tab === 'camera' ? ['ptz-obs-preview'] : [];
  if (ids.length === 0) {
    URL.revokeObjectURL(newUrl);
    return;
  }
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) element.src = newUrl;
  }
  if (currentScreenshotUrl) URL.revokeObjectURL(currentScreenshotUrl);
  currentScreenshotUrl = newUrl;
}

function connectWs() {
  if (wsController) {
    updateScreenshotSubscription();
    return wsController;
  }
  wsController = createManagedWebSocket({
    subscriptions: ['state', 'levels'],
    // Three missed ten-second server heartbeats is long enough to avoid
    // reconnecting during a busy render or a short mobile background pause.
    heartbeatIntervalMs: 10000,
    missedHeartbeats: 3,
    onOpen: (socket) => {
      ws = socket;
      if (window.Alpine) {
        Alpine.store('ui').serverConnected = true;
        Alpine.store('ui').authRequired = false;
      }
      updateScreenshotSubscription();
    },
    onMessage: (event) => {
      if (event.data instanceof Blob || event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
        updateScreenshotFrame(event.data);
        return;
      }
      if (typeof event.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.type === 'state') applyStateSnapshot(msg.data);
      else if (msg.type === 'levels') handleLevelsMessage(msg);
    },
    onClose: () => {
      ws = null;
      if (window.Alpine) Alpine.store('ui').serverConnected = false;
      checkAuth();
      if (currentScreenshotUrl) {
        URL.revokeObjectURL(currentScreenshotUrl);
        currentScreenshotUrl = null;
      }
    },
  });
  updateScreenshotSubscription();
  return wsController;
}

// Probe the API to distinguish "server unreachable" from "not authenticated".
// Exposed for tests.
function checkAuth() {
  fetch(basePath + '/api/state')
    .then((res) => {
      if (window.Alpine && !Alpine.store('ui').serverConnected) Alpine.store('ui').authRequired = res.status === 401;
    })
    .catch(() => {});
}
window.__srCheckAuth = checkAuth;
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

// --- API helpers ---
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
function setObsVolume(input, volumeDb) {
  const fader = window.findManagedFader?.(`obs/${input}`);
  if (fader) fader.setFaderValue(volumeDb);
  else post('/api/obs/volume', { input, volumeDb });
}
function setScene(scene)                { post('/api/obs/scene', { scene }); }
function toggleObsMute(input)           { post('/api/obs/mute', { input }); }
function toggleStream()                 { post('/api/obs/stream', {}); }
function toggleRecord()                 { post('/api/obs/record', {}); }

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
      await fetch(basePath + '/api/ui/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiddenObs: ui.hidden.obs, hiddenX32: [] }),
      });
    } catch (_) {}
  }, 300);
}

async function loadHiddenFromServer() {
  try {
    const res = await fetch(basePath + '/api/ui/hidden');
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


function thumbUrl(itemId, slideIndex) {
  const p = Alpine.store('state')?.proclaim;
  const localRevision = p?.slideRevisions?.[itemId]?.[String(slideIndex)] ?? 0;
  return `${basePath}/api/proclaim/thumb?itemId=${encodeURIComponent(itemId)}&slideIndex=${encodeURIComponent(slideIndex)}&localRevision=${encodeURIComponent(localRevision)}`;
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

function songLyricsSlides(p) {
  if (!p.onAir || !p.currentItemId) return [];
  if (p.currentItemType !== 'SongLyrics') return [];
  const slides = p.songLyrics?.[p.currentItemId];
  if (!slides || slides.length === 0) return [];
  return slides;
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
    const res = await fetch(basePath + '/api/config');
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
