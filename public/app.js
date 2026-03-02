// --- WebSocket connection ---
let ws;
let reconnectDelay = 1000;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') {
      renderState(msg.data);
    }
  };

  ws.onclose = () => {
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

connectWs();

// --- Tab switching ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'settings') loadConfig();
  });
});

// --- API helpers ---
function post(url, body) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --- Actions ---
function sendAction(action, index) {
  const body = { action };
  if (index !== undefined) body.index = index;
  post('/api/proclaim/action', body);
}

function setScene(scene) {
  post('/api/obs/scene', { scene });
}

function toggleObsMute(input) {
  post('/api/obs/mute', { input });
}

function setObsVolume(input, volumeDb) {
  post('/api/obs/volume', { input, volumeDb });
}

function toggleStream() {
  post('/api/obs/stream', {});
}

function toggleRecord() {
  post('/api/obs/record', {});
}

function setX32Fader(channel, value) {
  post('/api/x32/fader', { channel, value });
}

function toggleX32Mute(channel) {
  post('/api/x32/mute', { channel });
}

// --- Render state ---
function renderState(s) {
  // Connection dots
  setDot('dot-obs', s.obs.connected);
  setDot('dot-x32', s.x32.connected);
  setDot('dot-proclaim', s.proclaim.connected);

  renderObs(s.obs);
  renderX32(s.x32);
  renderProclaim(s.proclaim);
  renderOverview(s);
}

function setDot(id, connected) {
  const el = document.getElementById(id);
  el.classList.toggle('connected', connected);
}

// --- OBS rendering ---
function renderObs(obs) {
  // Scenes
  const grid = document.getElementById('obs-scenes');
  grid.innerHTML = obs.scenes
    .map(
      (name) =>
        `<button class="scene-btn${name === obs.currentScene ? ' active' : ''}" onclick="setScene('${esc(name)}')">${esc(name)}</button>`
    )
    .join('');

  // Audio
  const audioEl = document.getElementById('obs-audio');
  audioEl.innerHTML = obs.audioSources
    .map(
      (src) => `
    <div class="audio-source">
      <span class="name">${esc(src.name)}</span>
      <input type="range" min="-60" max="0" step="0.5"
        value="${src.volume != null && isFinite(src.volume) ? src.volume.toFixed(1) : -60}"
        oninput="setObsVolume('${esc(src.name)}', parseFloat(this.value))">
      <button class="mute-btn${src.muted ? ' muted' : ''}" onclick="toggleObsMute('${esc(src.name)}')">
        ${src.muted ? 'M' : '\u{1f50a}'}
      </button>
    </div>`
    )
    .join('');

  // Stream/Record
  document.getElementById('obs-stream-btn').classList.toggle('active', obs.streaming);
  document.getElementById('obs-stream-btn').textContent = obs.streaming ? 'Streaming' : 'Stream';
  document.getElementById('obs-record-btn').classList.toggle('active', obs.recording);
  document.getElementById('obs-record-btn').textContent = obs.recording ? 'Recording' : 'Record';
}

// --- X32 rendering ---
let faderTouched = {};

function renderX32(x32) {
  const grid = document.getElementById('x32-channels');
  grid.innerHTML = x32.channels
    .map(
      (ch) => `
    <div class="channel-strip">
      <span class="ch-label">${esc(ch.label)}</span>
      <div class="fader-wrap">
        <input type="range" min="0" max="1" step="0.005"
          value="${ch.fader}"
          data-ch="${ch.index}"
          oninput="handleFader(this, ${ch.index})"
          ontouchstart="faderTouched[${ch.index}]=true"
          ontouchend="setTimeout(()=>faderTouched[${ch.index}]=false, 500)"
          onmousedown="faderTouched[${ch.index}]=true"
          onmouseup="setTimeout(()=>faderTouched[${ch.index}]=false, 500)">
      </div>
      <button class="ch-mute${ch.muted ? ' muted' : ''}" onclick="toggleX32Mute(${ch.index})">
        ${ch.muted ? 'MUTED' : 'ON'}
      </button>
    </div>`
    )
    .join('');

  // Restore fader positions for currently-touched faders
  // (don't override the user's drag with server state)
}

let faderDebounce = {};
function handleFader(el, channel) {
  clearTimeout(faderDebounce[channel]);
  faderDebounce[channel] = setTimeout(() => {
    setX32Fader(channel, parseFloat(el.value));
  }, 50);
}

// --- Proclaim rendering ---
let thumbRevision = 0;

function thumbUrl(itemId, slideIndex) {
  return `/api/proclaim/thumb?itemId=${encodeURIComponent(itemId)}&slideIndex=${encodeURIComponent(slideIndex)}&localRevision=${thumbRevision}`;
}

function setThumb(el, itemId, slideIndex) {
  if (itemId === null || itemId === undefined || slideIndex === null || slideIndex === undefined) {
    el.innerHTML = '';
    return;
  }
  const img = document.createElement('img');
  img.src = thumbUrl(itemId, slideIndex);
  // Retry up to 3 times with 300ms delay if 202 (still rendering)
  let retries = 0;
  function tryLoad() {
    img.onerror = () => {
      if (retries++ < 3) setTimeout(tryLoad, 300);
    };
  }
  tryLoad();
  el.innerHTML = '';
  el.appendChild(img);
}

function renderProclaim(p) {
  const nowPlaying = document.getElementById('proclaim-now-playing');
  const itemsEl = document.getElementById('proclaim-items');

  if (!p.onAir || !p.currentItemId) {
    nowPlaying.textContent = p.connected ? 'Not on air' : 'Disconnected';
    document.getElementById('proclaim-thumb-prev').innerHTML = '';
    document.getElementById('proclaim-thumb-current').innerHTML = '';
    document.getElementById('proclaim-thumb-next').innerHTML = '';
    itemsEl.innerHTML = '';
    return;
  }

  // Now playing
  const typeLabel = p.currentItemType ? `<span class="item-type">${esc(p.currentItemType)}</span> ` : '';
  const slideInfo = p.slideIndex !== null ? ` &mdash; Slide ${p.slideIndex + 1}` : '';
  nowPlaying.innerHTML = `${typeLabel}<strong>${esc(p.currentItemTitle || '')}</strong>${slideInfo}`;

  // Thumbnails: find current item's slide neighbours
  const items = p.serviceItems || [];
  const currentItemIdx = items.findIndex((item) => item.id === p.currentItemId);
  const currentItem = items[currentItemIdx];
  const slideIndex = p.slideIndex !== null ? p.slideIndex : 0;

  let prevItemId = null, prevSlideIndex = null;
  let nextItemId = null, nextSlideIndex = null;

  if (currentItem) {
    if (slideIndex > 0) {
      prevItemId = p.currentItemId;
      prevSlideIndex = slideIndex - 1;
    } else if (currentItemIdx > 0) {
      const prevItem = items[currentItemIdx - 1];
      prevItemId = prevItem.id;
      prevSlideIndex = Math.max(0, (prevItem.slideCount || 1) - 1);
    }

    const slideCount = currentItem.slideCount || 1;
    if (slideIndex < slideCount - 1) {
      nextItemId = p.currentItemId;
      nextSlideIndex = slideIndex + 1;
    } else if (currentItemIdx < items.length - 1) {
      nextItemId = items[currentItemIdx + 1].id;
      nextSlideIndex = 0;
    }
  }

  setThumb(document.getElementById('proclaim-thumb-prev'), prevItemId, prevSlideIndex);
  setThumb(document.getElementById('proclaim-thumb-current'), p.currentItemId, slideIndex);
  setThumb(document.getElementById('proclaim-thumb-next'), nextItemId, nextSlideIndex);

  // Service item list — find position in full (unfiltered) list for GoToServiceItem
  // We pass 1-based index into the filtered list (Proclaim uses 1-based)
  itemsEl.innerHTML = items
    .map((item, i) => {
      const isActive = item.id === p.currentItemId;
      return `<button class="item-btn${isActive ? ' active' : ''}" onclick="sendAction('GoToServiceItem', ${i + 1})">${esc(item.title || item.kind)}</button>`;
    })
    .join('');
}

// --- Overview rendering ---
let screenshotInterval = null;
let lastObsScene = null;

function startScreenshotPolling() {
  if (screenshotInterval) return;
  screenshotInterval = setInterval(refreshScreenshot, 2000);
  refreshScreenshot();
}

function stopScreenshotPolling() {
  clearInterval(screenshotInterval);
  screenshotInterval = null;
}

function refreshScreenshot() {
  const url = '/api/obs/screenshot?' + Date.now();
  const ov = document.getElementById('ov-obs-preview');
  if (ov) ov.src = url;
  const obs = document.getElementById('obs-preview');
  if (obs) obs.src = url;
}

function renderOverview(s) {
  // Proclaim thumbnails and now-playing
  renderOverviewProclaim(s.proclaim);

  // OBS: current scene label + stream/record status pills
  const sceneEl = document.getElementById('ov-current-scene');
  if (sceneEl) sceneEl.textContent = s.obs.currentScene || '';

  const statusRow = document.getElementById('ov-stream-status');
  if (statusRow) {
    const pills = [];
    if (s.obs.streaming) pills.push('<span class="ov-status-pill active">LIVE</span>');
    if (s.obs.recording) pills.push('<span class="ov-status-pill active">REC</span>');
    statusRow.innerHTML = pills.join('');
  }

  // Scene changed — refresh screenshot sooner
  if (s.obs.currentScene !== lastObsScene) {
    lastObsScene = s.obs.currentScene;
    refreshScreenshot();
  }

  // X32 compact channel list — read-only fader bars + muted label
  const chList = document.getElementById('ov-channels');
  chList.innerHTML = s.x32.channels
    .map(
      (ch) => `
    <div class="ov-channel-row">
      <span class="ov-ch-label${ch.muted ? ' muted' : ''}">${esc(ch.label)}</span>
      <div class="ov-fader-bar">
        <div class="ov-fader-fill${ch.muted ? ' muted' : ''}" style="width:${(ch.fader * 100).toFixed(1)}%"></div>
      </div>
    </div>`
    )
    .join('');
}

function renderOverviewProclaim(p) {
  const nowPlaying = document.getElementById('ov-now-playing');
  if (!p.onAir || !p.currentItemId) {
    nowPlaying.textContent = p.connected ? 'Not on air' : 'Disconnected';
    document.getElementById('ov-thumb-prev').innerHTML = '';
    document.getElementById('ov-thumb-current').innerHTML = '';
    document.getElementById('ov-thumb-next').innerHTML = '';
    return;
  }

  const typeLabel = p.currentItemType ? `<span class="item-type">${esc(p.currentItemType)}</span> ` : '';
  const slideInfo = p.slideIndex !== null ? ` &mdash; Slide ${p.slideIndex + 1}` : '';
  nowPlaying.innerHTML = `${typeLabel}<strong>${esc(p.currentItemTitle || '')}</strong>${slideInfo}`;

  const items = p.serviceItems || [];
  const currentItemIdx = items.findIndex((item) => item.id === p.currentItemId);
  const currentItem = items[currentItemIdx];
  const slideIndex = p.slideIndex !== null ? p.slideIndex : 0;

  let prevItemId = null, prevSlideIndex = null;
  let nextItemId = null, nextSlideIndex = null;

  if (currentItem) {
    if (slideIndex > 0) {
      prevItemId = p.currentItemId;
      prevSlideIndex = slideIndex - 1;
    } else if (currentItemIdx > 0) {
      const prevItem = items[currentItemIdx - 1];
      prevItemId = prevItem.id;
      prevSlideIndex = Math.max(0, (prevItem.slideCount || 1) - 1);
    }

    const slideCount = currentItem.slideCount || 1;
    if (slideIndex < slideCount - 1) {
      nextItemId = p.currentItemId;
      nextSlideIndex = slideIndex + 1;
    } else if (currentItemIdx < items.length - 1) {
      nextItemId = items[currentItemIdx + 1].id;
      nextSlideIndex = 0;
    }
  }

  setThumb(document.getElementById('ov-thumb-prev'), prevItemId, prevSlideIndex);
  setThumb(document.getElementById('ov-thumb-current'), p.currentItemId, slideIndex);
  setThumb(document.getElementById('ov-thumb-next'), nextItemId, nextSlideIndex);
}

// Start/stop screenshot polling based on which tab is visible
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.dataset.tab === 'overview' || tab.dataset.tab === 'obs') {
      startScreenshotPolling();
    } else {
      stopScreenshotPolling();
    }
  });
});

// Overview is the default tab, so start polling immediately
startScreenshotPolling();

// --- Settings ---
let currentConfig = null;

async function loadConfig() {
  const res = await fetch('/api/config');
  currentConfig = await res.json();
  populateConfigForm(currentConfig);
}

function populateConfigForm(cfg) {
  document.getElementById('cfg-obs-address').value = cfg.obs.address || '';
  document.getElementById('cfg-obs-password').value = cfg.obs.password || '';
  document.getElementById('cfg-x32-address').value = cfg.x32.address || '';
  document.getElementById('cfg-x32-port').value = cfg.x32.port || '';
  document.getElementById('cfg-proclaim-host').value = cfg.proclaim.host || '';
  document.getElementById('cfg-proclaim-port').value = cfg.proclaim.port || '';
  document.getElementById('cfg-proclaim-password').value = cfg.proclaim.password || '';
  renderX32ChannelEditor(cfg.x32.channels || []);
}

function renderX32ChannelEditor(channels) {
  const container = document.getElementById('cfg-x32-channels');
  container.innerHTML = channels.map((ch, i) => `
    <div class="channel-row">
      <input type="number" class="ch-index-input" value="${ch.index}" min="1" max="32" data-i="${i}" placeholder="#" oninput="updateX32Channel(${i}, 'index', parseInt(this.value))">
      <input type="text" class="ch-label-input" value="${esc(ch.label)}" data-i="${i}" placeholder="Label" oninput="updateX32Channel(${i}, 'label', this.value)">
      <button class="btn" onclick="removeX32Channel(${i})">&#10005;</button>
    </div>
  `).join('');
}

function updateX32Channel(i, key, value) {
  if (!currentConfig) return;
  currentConfig.x32.channels[i][key] = value;
}

function addX32Channel() {
  if (!currentConfig) return;
  const maxIndex = currentConfig.x32.channels.reduce((m, ch) => Math.max(m, ch.index), 0);
  currentConfig.x32.channels.push({ index: maxIndex + 1, label: '' });
  renderX32ChannelEditor(currentConfig.x32.channels);
}

function removeX32Channel(i) {
  if (!currentConfig) return;
  currentConfig.x32.channels.splice(i, 1);
  renderX32ChannelEditor(currentConfig.x32.channels);
}

async function saveConfig() {
  const status = document.getElementById('settings-save-status');
  status.textContent = 'Saving…';
  try {
    const body = {
      obs: {
        address: document.getElementById('cfg-obs-address').value.trim(),
        password: document.getElementById('cfg-obs-password').value,
      },
      x32: {
        address: document.getElementById('cfg-x32-address').value.trim(),
        port: parseInt(document.getElementById('cfg-x32-port').value) || 10023,
        channels: currentConfig ? currentConfig.x32.channels : [],
      },
      proclaim: {
        host: document.getElementById('cfg-proclaim-host').value.trim(),
        port: parseInt(document.getElementById('cfg-proclaim-port').value) || 52195,
        password: document.getElementById('cfg-proclaim-password').value,
      },
    };
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = 'Saved!';
    } else {
      status.textContent = 'Error: ' + (data.error || 'unknown');
    }
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
}

async function discoverX32() {
  const status = document.getElementById('discover-x32-status');
  status.textContent = 'Scanning…';
  try {
    const res = await fetch('/api/discover/x32', { method: 'POST' });
    const data = await res.json();
    if (data.found) {
      document.getElementById('cfg-x32-address').value = data.address;
      status.textContent = 'Found: ' + data.address;
    } else {
      status.textContent = 'Not found';
    }
  } catch (err) {
    status.textContent = 'Error';
  }
}

async function discoverObs() {
  const status = document.getElementById('discover-obs-status');
  status.textContent = 'Checking…';
  try {
    const res = await fetch('/api/discover/obs', { method: 'POST' });
    const data = await res.json();
    if (data.found) {
      document.getElementById('cfg-obs-address').value = data.address;
      status.textContent = 'Found';
    } else {
      status.textContent = 'Not found';
    }
  } catch (err) {
    status.textContent = 'Error';
  }
}

async function discoverProclaim() {
  const status = document.getElementById('discover-proclaim-status');
  status.textContent = 'Checking…';
  try {
    const res = await fetch('/api/discover/proclaim', { method: 'POST' });
    const data = await res.json();
    if (data.found) {
      document.getElementById('cfg-proclaim-host').value = data.address;
      document.getElementById('cfg-proclaim-port').value = data.port;
      status.textContent = 'Found';
    } else {
      status.textContent = 'Not found';
    }
  } catch (err) {
    status.textContent = 'Error';
  }
}

// --- Utility ---
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/'/g, "\\'");
}
