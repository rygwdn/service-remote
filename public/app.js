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
function sendAction(action) {
  post('/api/proclaim/action', { action });
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

// --- Utility ---
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/'/g, "\\'");
}
