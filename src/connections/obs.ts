import obsWebSocketJs = require('obs-websocket-js');
import config = require('../config');
import state = require('../state');
import logger = require('../logger');

const OBSWebSocket = obsWebSocketJs.default;

const obs = new OBSWebSocket();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wantConnected = false;

async function connect(): Promise<void> {
  wantConnected = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    await obs.connect(config.obs.address, config.obs.password || undefined);
    logger.log('[OBS] Connected');
    state.update('obs', { connected: true });
    await refreshState();
  } catch (err) {
    logger.log('[OBS] Connection failed:', (err as Error).message);
    state.update('obs', { connected: false });
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!wantConnected) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5000);
}

obs.on('ConnectionClosed', () => {
  logger.log('[OBS] Disconnected');
  state.update('obs', { connected: false });
  if (wantConnected) scheduleReconnect();
});

obs.on('CurrentProgramSceneChanged', async ({ sceneName }) => {
  state.update('obs', { currentScene: sceneName });
  await refreshLiveStatus(sceneName);
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

obs.on('SceneItemEnableStateChanged', async () => {
  const currentScene = state.get().obs.currentScene;
  if (currentScene) {
    await refreshLiveStatus(currentScene);
  }
});

// Recursively collects enabled source names from a scene or group into the given set
async function collectSourceNames(name: string, isGroup: boolean, names: Set<string>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const method = isGroup ? 'GetGroupSceneItemList' : 'GetSceneItemList';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { sceneItems } = await (obs as any).call(method, { sceneName: name });
  for (const item of sceneItems) {
    if (!item.sceneItemEnabled) continue;
    if (item.isGroup) {
      await collectSourceNames(item.sourceName as string, true, names);
    } else {
      names.add(item.sourceName as string);
    }
  }
}

// Returns source names that are enabled scene items in the given scene (including inside groups)
async function getSceneSourceNames(sceneName: string): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    await collectSourceNames(sceneName, false, names);
  } catch {
    // Return empty set on error
  }
  return names;
}

// Returns true if the source is hidden from the OBS audio mixer panel
async function isSourceHiddenFromMixer(sourceName: string): Promise<boolean> {
  try {
    // GetSourcePrivateSettings is not in obs-websocket-js type definitions,
    // so we use a runtime call with type assertion.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (obs as any).call('GetSourcePrivateSettings', { sourceName });
    const settings = (result?.sourcePrivateSettings ?? {}) as Record<string, unknown>;
    if (settings?.audioMixerHidden) {
      logger.log(`[OBS] Source "${sourceName}" is hidden from audio mixer`);
      return true;
    }
    return false;
  } catch (err) {
    logger.log(`[OBS] GetSourcePrivateSettings failed for "${sourceName}":`, (err as Error).message);
    return false;
  }
}

// Updates the live status of all audio sources based on the current scene's source list
async function refreshLiveStatus(sceneName: string): Promise<void> {
  try {
    const liveSourceNames = await getSceneSourceNames(sceneName);
    const sources = state.get().obs.audioSources.map((s) => ({
      ...s,
      live: liveSourceNames.has(s.name),
    }));
    state.update('obs', { audioSources: sources });
  } catch (err) {
    logger.log('[OBS] Failed to refresh live status:', (err as Error).message);
  }
}

async function refreshState(): Promise<void> {
  try {
    const [sceneList, streamStatus, recordStatus] = await Promise.all([
      obs.call('GetSceneList'),
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
    ]);

    const scenes = sceneList.scenes.map((s) => s.sceneName as string).reverse();
    const currentScene = sceneList.currentProgramSceneName as string;

    // Get the source names active in the current scene
    const liveSourceNames = await getSceneSourceNames(currentScene);

    // Get audio sources, filtering out those hidden from the OBS audio mixer
    const { inputs } = await obs.call('GetInputList');
    const audioSources: Array<{ name: string; volume: number; muted: boolean; live: boolean }> = [];
    for (const input of inputs) {
      try {
        const inputName = input.inputName as string;
        const [vol, mute, hidden] = await Promise.all([
          obs.call('GetInputVolume', { inputName }),
          obs.call('GetInputMute', { inputName }),
          isSourceHiddenFromMixer(inputName),
        ]);
        if (hidden) continue;
        audioSources.push({
          name: inputName,
          volume: mulToDb(vol.inputVolumeMul as number),
          muted: mute.inputMuted as boolean,
          live: liveSourceNames.has(inputName),
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
    logger.log('[OBS] Failed to refresh state:', (err as Error).message);
  }
}

function mulToDb(mul: number): number {
  if (mul === 0) return -Infinity;
  return 20 * Math.log10(mul);
}

function dbToMul(db: number): number {
  return Math.pow(10, db / 20);
}

function disconnect(): void {
  wantConnected = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  obs.disconnect();
}

export = {
  connect,
  disconnect,

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

  async getSceneScreenshot(sceneName: string): Promise<Buffer> {
    const result = await obs.call('GetSourceScreenshot', {
      sourceName: sceneName,
      imageFormat: 'jpeg',
      imageWidth: 480,
      imageCompressionQuality: 70,
    });
    const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(b64, 'base64');
  },
};
