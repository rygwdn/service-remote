const OBSWebSocket = require('obs-websocket-js').default;
const config = require('../config');
const state = require('../state');

const obs = new OBSWebSocket();
let reconnectTimer = null;

async function connect() {
  clearTimeout(reconnectTimer);
  try {
    await obs.connect(config.obs.address, config.obs.password || undefined);
    console.log('[OBS] Connected');
    state.update('obs', { connected: true });
    await refreshState();
  } catch (err) {
    console.log('[OBS] Connection failed:', err.message);
    state.update('obs', { connected: false });
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5000);
}

obs.on('ConnectionClosed', () => {
  console.log('[OBS] Disconnected');
  state.update('obs', { connected: false });
  scheduleReconnect();
});

obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
  state.update('obs', { currentScene: sceneName });
});

obs.on('SceneListChanged', async () => {
  const { scenes } = await obs.call('GetSceneList');
  state.update('obs', { scenes: scenes.map((s) => s.sceneName).reverse() });
});

obs.on('StreamStateChanged', ({ outputActive }) => {
  state.update('obs', { streaming: outputActive });
});

obs.on('RecordStateChanged', ({ outputActive }) => {
  state.update('obs', { recording: outputActive });
});

obs.on('InputVolumeChanged', ({ inputName, inputVolumeMul }) => {
  const sources = state.get().obs.audioSources.map((s) =>
    s.name === inputName ? { ...s, volume: mulToDb(inputVolumeMul) } : s
  );
  state.update('obs', { audioSources: sources });
});

obs.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
  const sources = state.get().obs.audioSources.map((s) =>
    s.name === inputName ? { ...s, muted: inputMuted } : s
  );
  state.update('obs', { audioSources: sources });
});

async function refreshState() {
  try {
    const [sceneList, streamStatus, recordStatus] = await Promise.all([
      obs.call('GetSceneList'),
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
    ]);

    const scenes = sceneList.scenes.map((s) => s.sceneName).reverse();
    const currentScene = sceneList.currentProgramSceneName;

    // Get audio sources
    const { inputs } = await obs.call('GetInputList');
    const audioSources = [];
    for (const input of inputs) {
      try {
        const vol = await obs.call('GetInputVolume', {
          inputName: input.inputName,
        });
        const mute = await obs.call('GetInputMute', {
          inputName: input.inputName,
        });
        audioSources.push({
          name: input.inputName,
          volume: mulToDb(vol.inputVolumeMul),
          muted: mute.inputMuted,
        });
      } catch {
        // Not all inputs have audio
      }
    }

    state.update('obs', {
      scenes,
      currentScene,
      streaming: streamStatus.outputActive,
      recording: recordStatus.outputActive,
      audioSources,
    });
  } catch (err) {
    console.log('[OBS] Failed to refresh state:', err.message);
  }
}

function mulToDb(mul) {
  if (mul === 0) return -Infinity;
  return 20 * Math.log10(mul);
}

function dbToMul(db) {
  return Math.pow(10, db / 20);
}

module.exports = {
  connect,

  async setScene(sceneName) {
    await obs.call('SetCurrentProgramScene', {
      sceneName,
    });
  },

  async setInputVolume(inputName, volumeDb) {
    await obs.call('SetInputVolume', {
      inputName,
      inputVolumeMul: dbToMul(volumeDb),
    });
  },

  async toggleMute(inputName) {
    await obs.call('ToggleInputMute', { inputName });
  },

  async toggleStream() {
    await obs.call('ToggleStream');
  },

  async toggleRecord() {
    await obs.call('ToggleRecord');
  },
};
