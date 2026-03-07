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
    if (tab.dataset.tab === 'settings') {
      loadConfig();
      loadLogs();
    }
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

function setX32Fader(channel, type, value) {
  post('/api/x32/fader', { channel, type, value });
}

function toggleX32Mute(channel, type) {
  post('/api/x32/mute', { channel, type });
}

// --- Fader visibility (show/hide toggles) ---
const editModeActive = { obs: false, x32: false };
const hidden = { obs: new Set(), x32: new Set() };

async function loadHiddenFromServer() {
  try {
    const res = await fetch('/api/ui/hidden');
    if (!res.ok) return;
    const data = await res.json();
    hidden.obs = new Set(data.hiddenObs || []);
    hidden.x32 = new Set(data.hiddenX32 || []);
    applyObsVisibility();
    applyX32Visibility();
    applyOverviewVisibility();
  } catch (_) {}
}

let saveHiddenTimer = null;
function saveHiddenToServer() {
  clearTimeout(saveHiddenTimer);
  saveHiddenTimer = setTimeout(async () => {
    try {
      await fetch('/api/ui/hidden', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiddenObs: [...hidden.obs], hiddenX32: [...hidden.x32] }),
      });
    } catch (_) {}
  }, 300);
}

function toggleEditMode(panel) {
  editModeActive[panel] = !editModeActive[panel];
  const btnId = panel === 'obs' ? 'obs-audio-edit-btn' : 'x32-edit-btn';
  const btn = document.getElementById(btnId);
  btn.classList.toggle('active', editModeActive[panel]);
  btn.textContent = editModeActive[panel] ? 'Done' : 'Edit';
  if (panel === 'obs') {
    document.getElementById('obs-audio').querySelectorAll('.fader-visibility-label').forEach((label) => {
      label.style.display = editModeActive.obs ? '' : 'none';
    });
    applyObsVisibility();
  } else {
    document.getElementById('x32-channels').querySelectorAll('.fader-visibility-label').forEach((label) => {
      label.style.display = editModeActive.x32 ? '' : 'none';
    });
    applyX32Visibility();
  }
}

function applyObsVisibility() {
  document.getElementById('obs-audio').querySelectorAll('.audio-source[data-name]').forEach((el) => {
    const isHidden = hidden.obs.has(el.dataset.name);
    el.style.display = (!editModeActive.obs && isHidden) ? 'none' : '';
  });
}

function applyX32Visibility() {
  document.getElementById('x32-channels').querySelectorAll('.channel-strip[data-key]').forEach((el) => {
    const isHidden = hidden.x32.has(el.dataset.key);
    const isUnpatched = el.dataset.unpatched === 'true';
    el.style.display = (!editModeActive.x32 && (isHidden || isUnpatched)) ? 'none' : '';
  });
}

function applyOverviewVisibility() {
  const obsAudioEl = document.getElementById('ov-obs-audio');
  if (obsAudioEl) {
    obsAudioEl.querySelectorAll('.ov-channel-row[data-name]').forEach((el) => {
      el.style.display = hidden.obs.has(el.dataset.name) ? 'none' : '';
    });
  }
  const chList = document.getElementById('ov-channels');
  if (chList) {
    chList.querySelectorAll('.ov-channel-row[data-key]').forEach((el) => {
      el.style.display = hidden.x32.has(el.dataset.key) ? 'none' : '';
    });
  }
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
  obs.scenes.forEach((name) => {
    let btn = grid.querySelector(`[data-scene="${CSS.escape(name)}"]`);
    if (!btn) {
      btn = document.createElement('button');
      btn.dataset.scene = name;
      btn.textContent = name;
      btn.addEventListener('click', () => setScene(name));
      grid.appendChild(btn);
    }
    btn.className = 'scene-btn' + (name === obs.currentScene ? ' active' : '');
  });
  const sceneNames = new Set(obs.scenes);
  grid.querySelectorAll('[data-scene]').forEach((el) => {
    if (!sceneNames.has(el.dataset.scene)) el.remove();
  });

  // Audio
  const audioEl = document.getElementById('obs-audio');
  obs.audioSources.forEach((src) => {
    let row = audioEl.querySelector(`.audio-source[data-name="${CSS.escape(src.name)}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'audio-source';
      row.dataset.name = src.name;
      row.innerHTML = `
        <span class="name"></span>
        <input type="range" min="-60" max="0" step="0.5">
        <button class="mute-btn"></button>
        <div class="obs-meter"><div class="obs-meter-fill"></div></div>
        <label class="fader-visibility-label" style="display:none"><input type="checkbox" class="fader-visibility-cb" checked> Show</label>`;
      const input = row.querySelector('input[type="range"]');
      input.addEventListener('input', () => setObsVolume(src.name, parseFloat(input.value)));
      const btn = row.querySelector('.mute-btn');
      btn.addEventListener('click', () => toggleObsMute(src.name));
      const cb = row.querySelector('.fader-visibility-cb');
      cb.addEventListener('change', () => {
        if (cb.checked) hidden.obs.delete(src.name); else hidden.obs.add(src.name);
        saveHiddenToServer();
        applyObsVisibility();
        applyOverviewVisibility();
      });
      audioEl.appendChild(row);
    }
    row.className = 'audio-source' + (src.live ? ' live' : '');
    row.querySelector('.name').textContent = src.name;
    const input = row.querySelector('input');
    input.value = src.volume != null && isFinite(src.volume) ? src.volume.toFixed(1) : -60;
    const btn = row.querySelector('.mute-btn');
    btn.className = 'mute-btn' + (src.muted ? ' muted' : '');
    btn.textContent = src.muted ? 'M' : '🔊';
    row.querySelector('.obs-meter-fill').style.width = (src.level * 100).toFixed(1) + '%';
    // Sync visibility checkbox
    const cb = row.querySelector('.fader-visibility-cb');
    cb.checked = !hidden.obs.has(src.name);
    const label = row.querySelector('.fader-visibility-label');
    label.style.display = editModeActive.obs ? '' : 'none';
  });
  // Remove rows for sources no longer present
  const srcNames = new Set(obs.audioSources.map((s) => s.name));
  audioEl.querySelectorAll('.audio-source[data-name]').forEach((el) => {
    if (!srcNames.has(el.dataset.name)) el.remove();
  });
  applyObsVisibility();

  // Stream/Record
  document.getElementById('obs-stream-btn').classList.toggle('active', obs.streaming);
  document.getElementById('obs-stream-btn').textContent = obs.streaming ? 'Streaming' : 'Stream';
  document.getElementById('obs-record-btn').classList.toggle('active', obs.recording);
  document.getElementById('obs-record-btn').textContent = obs.recording ? 'Recording' : 'Record';
}

// --- X32 rendering ---
let faderTouched = {};

function chKey(ch) {
  return `${ch.type}/${ch.index}`;
}

function renderX32(x32) {
  const grid = document.getElementById('x32-channels');

  // Build a map for quick lookup
  const chMap = new Map(x32.channels.map((ch) => [chKey(ch), ch]));

  // Track which strip keys are rendered this pass (odd key for pairs, own key otherwise)
  const renderedKeys = new Set();

  x32.channels.forEach((ch) => {
    // Even channel of a linked pair — rendered as part of the odd strip
    if (ch.index % 2 === 0) {
      const oddKey = `${ch.type}/${ch.index - 1}`;
      const oddCh = chMap.get(oddKey);
      if (oddCh && oddCh.linkedToNext) return;
    }

    const key = chKey(ch);
    const isPair = ch.linkedToNext;
    const evenCh = isPair ? chMap.get(`${ch.type}/${ch.index + 1}`) : null;
    renderedKeys.add(key);

    let strip = grid.querySelector(`.channel-strip[data-key="${key}"]`);
    const wasPair = strip ? strip.dataset.paired === 'true' : null;

    // Recreate strip if pair status changed
    if (strip && wasPair !== isPair) {
      strip.remove();
      strip = null;
    }

    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'channel-strip';
      strip.dataset.key = key;
      strip.dataset.paired = isPair ? 'true' : 'false';
      strip.innerHTML = isPair ? `
        <span class="ch-label"></span>
        <div class="fader-wrap">
          <input type="range" min="0" max="1" step="0.005">
          <div class="ch-meters-pair">
            <div class="ch-meter"><div class="ch-meter-fill"></div></div>
            <div class="ch-meter"><div class="ch-meter-fill"></div></div>
          </div>
        </div>
        <button class="ch-mute"></button>
        <label class="fader-visibility-label" style="display:none"><input type="checkbox" class="fader-visibility-cb" checked> Show</label>`
      : `
        <span class="ch-label"></span>
        <div class="fader-wrap">
          <input type="range" min="0" max="1" step="0.005">
          <div class="ch-meter"><div class="ch-meter-fill"></div></div>
        </div>
        <button class="ch-mute"></button>
        <label class="fader-visibility-label" style="display:none"><input type="checkbox" class="fader-visibility-cb" checked> Show</label>`;

      const input = strip.querySelector('input[type="range"]');
      input.addEventListener('input', () => handleFader(input, ch.index, ch.type));
      input.addEventListener('mousedown', () => { faderTouched[key] = true; });
      input.addEventListener('touchstart', () => { faderTouched[key] = true; }, { passive: true });
      input.addEventListener('mouseup', () => { setTimeout(() => { faderTouched[key] = false; }, 500); });
      input.addEventListener('touchend', () => { setTimeout(() => { faderTouched[key] = false; }, 500); });

      const btn = strip.querySelector('.ch-mute');
      btn.addEventListener('click', () => toggleX32Mute(ch.index, ch.type));

      const cb = strip.querySelector('.fader-visibility-cb');
      cb.addEventListener('change', () => {
        if (cb.checked) hidden.x32.delete(key); else hidden.x32.add(key);
        saveHiddenToServer();
        applyX32Visibility();
        applyOverviewVisibility();
      });

      grid.appendChild(strip);
    }

    // Label: "L / R" for pairs, plain label otherwise
    strip.querySelector('.ch-label').textContent = isPair && evenCh
      ? `${ch.label} / ${evenCh.label}`
      : ch.label;

    if (!faderTouched[key]) {
      strip.querySelector('input').value = ch.fader;
    }

    if (isPair && evenCh) {
      const fills = strip.querySelectorAll('.ch-meter-fill');
      fills[0].style.height = (ch.level * 100).toFixed(1) + '%';
      fills[1].style.height = (evenCh.level * 100).toFixed(1) + '%';
    } else {
      strip.querySelector('.ch-meter-fill').style.height = (ch.level * 100).toFixed(1) + '%';
    }

    const btn = strip.querySelector('.ch-mute');
    btn.className = 'ch-mute' + (ch.muted ? ' muted' : '');
    btn.textContent = ch.muted ? 'MUTED' : 'ON';

    // Auto-hide unpatched input channels (not in edit mode)
    strip.dataset.unpatched = (ch.type === 'ch' && ch.source === 0) ? 'true' : 'false';

    const cb = strip.querySelector('.fader-visibility-cb');
    cb.checked = !hidden.x32.has(key);
    const label = strip.querySelector('.fader-visibility-label');
    label.style.display = editModeActive.x32 ? '' : 'none';
  });

  // Remove strips for keys no longer rendered
  grid.querySelectorAll('.channel-strip[data-key]').forEach((el) => {
    if (!renderedKeys.has(el.dataset.key)) el.remove();
  });
  applyX32Visibility();
}

let faderDebounce = {};
function handleFader(el, channel, type) {
  const key = `${type}/${channel}`;
  clearTimeout(faderDebounce[key]);
  faderDebounce[key] = setTimeout(() => {
    setX32Fader(channel, type, parseFloat(el.value));
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
  // Retry up to 5 times with 500ms delay if image fails (e.g. 202 still rendering)
  let retries = 0;
  img.onerror = () => {
    if (retries++ < 5) setTimeout(() => { img.src = thumbUrl(itemId, slideIndex); }, 500);
  };
  img.src = thumbUrl(itemId, slideIndex);
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

  // Service item list — incremental update to preserve click events during state updates
  // Build the ordered list of elements we want
  const desiredElements = [];
  let currentSection = null;
  let currentGroup = null;
  for (const item of items) {
    if (item.section !== currentSection) {
      currentSection = item.section;
      currentGroup = null;
      desiredElements.push({ type: 'section', key: `section:${item.section}`, label: item.section });
    }
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      if (currentGroup) {
        desiredElements.push({ type: 'group', key: `group:${item.section}:${currentGroup}`, label: currentGroup });
      }
    }
    const isActive = item.id === p.currentItemId;
    let slideCountLabel = '';
    if (item.slideCount > 1) {
      if (isActive && p.slideIndex !== null) {
        slideCountLabel = `(${p.slideIndex + 1} of ${item.slideCount})`;
      } else {
        slideCountLabel = `(${item.slideCount} slides)`;
      }
    }
    desiredElements.push({ type: 'item', key: `item:${item.id}`, item, isActive, slideCountLabel });
  }

  // Sync DOM to desired elements
  const seen = new Set();
  desiredElements.forEach((def, i) => {
    seen.add(def.key);
    let el = itemsEl.querySelector(`[data-item-key="${CSS.escape(def.key)}"]`);
    if (!el) {
      if (def.type === 'section') {
        el = document.createElement('div');
        el.className = 'item-section-header';
        el.textContent = def.label;
      } else if (def.type === 'group') {
        el = document.createElement('div');
        el.className = 'item-group-header';
        el.textContent = def.label;
      } else {
        el = document.createElement('button');
        el.addEventListener('click', () => sendAction('GoToServiceItem', def.item.index));
      }
      el.dataset.itemKey = def.key;
      itemsEl.appendChild(el);
    }
    // Move to correct position if needed
    const children = Array.from(itemsEl.children);
    if (children[i] !== el) itemsEl.insertBefore(el, children[i] || null);
    // Update mutable state
    if (def.type === 'item') {
      el.className = 'item-btn' + (def.isActive ? ' active' : '') + (def.item.group ? ' item-grouped' : '');
      el.childNodes.forEach((n) => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
      el.querySelector('.item-slide-count')?.remove();
      el.appendChild(document.createTextNode(def.item.title || def.item.kind));
      if (def.slideCountLabel) {
        const span = document.createElement('span');
        span.className = 'item-slide-count';
        span.textContent = ' ' + def.slideCountLabel;
        el.appendChild(span);
      }
    }
  });
  // Remove stale elements
  itemsEl.querySelectorAll('[data-item-key]').forEach((el) => {
    if (!seen.has(el.dataset.itemKey)) el.remove();
  });
}

// --- Overview rendering ---
let screenshotInterval = null;
let lastObsScene = null;

function startScreenshotPolling() {
  stopScreenshotPolling();
  const interval = (currentConfig && currentConfig.obs && currentConfig.obs.screenshotInterval) || 1000;
  screenshotInterval = setInterval(refreshScreenshot, interval);
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

  // X32 compact channel list — fader bar + live level bar
  const chList = document.getElementById('ov-channels');
  s.x32.channels.forEach((ch) => {
    const key = chKey(ch);
    let row = chList.querySelector(`.ov-channel-row[data-key="${key}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'ov-channel-row';
      row.dataset.key = key;
      row.innerHTML = `
        <span class="ov-ch-label"></span>
        <div class="ov-bars">
          <div class="ov-fader-bar"><div class="ov-fader-fill"></div></div>
          <div class="ov-level-bar"><div class="ov-level-fill"></div></div>
        </div>`;
      chList.appendChild(row);
    }
    const muted = ch.muted;
    row.querySelector('.ov-ch-label').className = 'ov-ch-label' + (muted ? ' muted' : '');
    row.querySelector('.ov-ch-label').textContent = ch.label;
    row.querySelector('.ov-fader-fill').className = 'ov-fader-fill' + (muted ? ' muted' : '');
    row.querySelector('.ov-fader-fill').style.width = (ch.fader * 100).toFixed(1) + '%';
    row.querySelector('.ov-level-fill').style.width = (ch.level * 100).toFixed(1) + '%';
  });
  const chKeys = new Set(s.x32.channels.map(chKey));
  chList.querySelectorAll('.ov-channel-row[data-key]').forEach((el) => {
    if (!chKeys.has(el.dataset.key)) el.remove();
  });
  applyOverviewVisibility();

  // OBS audio — fader bar + live level bar
  const obsAudioEl = document.getElementById('ov-obs-audio');
  if (obsAudioEl) {
    s.obs.audioSources.forEach((src) => {
      let row = obsAudioEl.querySelector(`.ov-channel-row[data-name="${CSS.escape(src.name)}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'ov-channel-row';
        row.dataset.name = src.name;
        row.innerHTML = `
          <span class="ov-ch-label"></span>
          <div class="ov-bars">
            <div class="ov-fader-bar"><div class="ov-fader-fill"></div></div>
            <div class="ov-level-bar"><div class="ov-level-fill"></div></div>
          </div>`;
        obsAudioEl.appendChild(row);
      }
      const muted = src.muted;
      const vol = src.volume != null && isFinite(src.volume) ? src.volume : -60;
      row.querySelector('.ov-ch-label').className = 'ov-ch-label' + (muted ? ' muted' : '');
      row.querySelector('.ov-ch-label').textContent = src.name;
      row.querySelector('.ov-fader-fill').className = 'ov-fader-fill' + (muted ? ' muted' : '');
      row.querySelector('.ov-fader-fill').style.width = ((vol + 60) / 60 * 100).toFixed(1) + '%';
      row.querySelector('.ov-level-fill').style.width = (src.level * 100).toFixed(1) + '%';
    });
    const srcNames = new Set(s.obs.audioSources.map((s) => s.name));
    obsAudioEl.querySelectorAll('.ov-channel-row[data-name]').forEach((el) => {
      if (!srcNames.has(el.dataset.name)) el.remove();
    });
    applyOverviewVisibility();
  }
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
// --- Settings ---
let currentConfig = null;

startScreenshotPolling();

// Pre-populate settings form so values are ready if user opens settings directly
loadConfig();

// Load hidden fader preferences from server
loadHiddenFromServer();

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    currentConfig = await res.json();
    populateConfigForm(currentConfig);
  } catch (err) {
    const status = document.getElementById('settings-save-status');
    if (status) status.textContent = 'Failed to load config: ' + err.message;
  }
}

function populateConfigForm(cfg) {
  document.getElementById('cfg-obs-address').value = cfg.obs.address || '';
  document.getElementById('cfg-obs-password').value = cfg.obs.password || '';
  document.getElementById('cfg-obs-screenshot-interval').value = cfg.obs.screenshotInterval || 1000;
  document.getElementById('cfg-x32-address').value = cfg.x32.address || '';
  document.getElementById('cfg-x32-port').value = cfg.x32.port || '';
  document.getElementById('cfg-proclaim-host').value = cfg.proclaim.host || '';
  document.getElementById('cfg-proclaim-port').value = cfg.proclaim.port || '';
  document.getElementById('cfg-proclaim-password').value = cfg.proclaim.password || '';
  document.getElementById('cfg-proclaim-poll-interval').value = cfg.proclaim.pollInterval || 1000;
}

async function saveConfig() {
  const status = document.getElementById('settings-save-status');
  status.textContent = 'Saving…';
  try {
    const body = {
      obs: {
        address: document.getElementById('cfg-obs-address').value.trim(),
        password: document.getElementById('cfg-obs-password').value,
        screenshotInterval: parseInt(document.getElementById('cfg-obs-screenshot-interval').value) || 1000,
      },
      x32: {
        address: document.getElementById('cfg-x32-address').value.trim(),
        port: parseInt(document.getElementById('cfg-x32-port').value) || 10023,
      },
      proclaim: {
        host: document.getElementById('cfg-proclaim-host').value.trim(),
        port: parseInt(document.getElementById('cfg-proclaim-port').value) || 52195,
        password: document.getElementById('cfg-proclaim-password').value,
        pollInterval: parseInt(document.getElementById('cfg-proclaim-poll-interval').value) || 1000,
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

// --- Logs ---
async function loadLogs() {
  const el = document.getElementById('log-output');
  if (!el) return;
  try {
    const res = await fetch('/api/logs');
    const data = await res.json();
    renderLogs(data.logs || []);
  } catch (err) {
    el.textContent = 'Error loading logs: ' + err.message;
  }
}

function renderLogs(logs) {
  const el = document.getElementById('log-output');
  if (!el) return;
  if (!logs.length) {
    el.textContent = '(no log entries yet)';
    return;
  }
  el.innerHTML = logs.map((entry) => {
    const cls = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : 'log-info';
    const time = entry.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    return `<span class="${cls}">${escText(time)} ${escText(entry.msg)}</span>`;
  }).join('\n');
  el.scrollTop = el.scrollHeight;
}

function clearLogDisplay() {
  const el = document.getElementById('log-output');
  if (el) el.textContent = '';
}

function escText(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// --- Utility ---
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/'/g, "\\'");
}
