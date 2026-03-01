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
        value="${isFinite(src.volume) ? src.volume.toFixed(1) : -60}"
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

// --- Utility ---
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/'/g, "\\'");
}
