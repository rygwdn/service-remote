import obsWebSocketJs = require('obs-websocket-js');
import config = require('../config');
import state = require('../state');

const OBSWebSocket = obsWebSocketJs.default;

const obs = new OBSWebSocket();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function connect(): Promise<void> {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    await obs.connect(config.obs.address, config.obs.password || undefined);
    console.log('[OBS] Connected');
    state.update('obs', { connected: true });
    await refreshState();
  } catch (err) {
    console.log('[OBS] Connection failed:', (err as Error).message);
    state.update('obs', { connected: false });
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
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
  state.update('obs', { scenes: scenes.map((s) => s.sceneName as string).reverse() });
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

async function refreshState(): Promise<void> {
  try {
    const [sceneList, streamStatus, recordStatus] = await Promise.all([
      obs.call('GetSceneList'),
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
    ]);

    const scenes = sceneList.scenes.map((s) => s.sceneName as string).reverse();
    const currentScene = sceneList.currentProgramSceneName as string;

    // Get audio sources
    const { inputs } = await obs.call('GetInputList');
    const audioSources: Array<{ name: string; volume: number; muted: boolean }> = [];
    for (const input of inputs) {
      try {
        const vol = await obs.call('GetInputVolume', {
          inputName: input.inputName as string,
        });
        const mute = await obs.call('GetInputMute', {
          inputName: input.inputName as string,
        });
        audioSources.push({
          name: input.inputName as string,
          volume: mulToDb(vol.inputVolumeMul as number),
          muted: mute.inputMuted as boolean,
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
    console.log('[OBS] Failed to refresh state:', (err as Error).message);
  }
}

function mulToDb(mul: number): number {
  if (mul === 0) return -Infinity;
  return 20 * Math.log10(mul);
}

function dbToMul(db: number): number {
  return Math.pow(10, db / 20);
}

export = {
  connect,

  async setScene(sceneName: string): Promise<void> {
    await obs.call('SetCurrentProgramScene', {
      sceneName,
    });
  },

  async setInputVolume(inputName: string, volumeDb: number): Promise<void> {
    await obs.call('SetInputVolume', {
      inputName,
      inputVolumeMul: dbToMul(volumeDb),
    });
  },

  async toggleMute(inputName: string): Promise<void> {
    await obs.call('ToggleInputMute', { inputName });
  },

  async toggleStream(): Promise<void> {
    await obs.call('ToggleStream');
  },

  async toggleRecord(): Promise<void> {
    await obs.call('ToggleRecord');
  },
};
