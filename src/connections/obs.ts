import OBSWebSocket from 'obs-websocket-js';
import config from '../config';
import state from '../state';
import * as logger from '../logger';
import * as screenshotWs from '../screenshot-ws';
import * as levelsWs from '../levels-ws';
import { applyLiveStatus, dbToMul, extractObsPeak, mulToDb } from './obs-helpers';

const obs = new OBSWebSocket();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let screenshotTimer: ReturnType<typeof setTimeout> | null = null;
let screenshotInFlight = false;
let wantConnected = false;
let obsConnected = false;
let connectionGeneration = 0;
let connectInFlight = false;

const SCREENSHOT_INTERVAL_MS = 250;

function isCurrentGeneration(generation: number): boolean {
  return wantConnected && generation === connectionGeneration;
}

function isCurrentConnection(generation: number): boolean {
  return isCurrentGeneration(generation) && obsConnected;
}

async function captureScreenshot(generation: number): Promise<void> {
  screenshotInFlight = true;
  try {
    const currentScene = state.get().obs.currentScene;
    if (!currentScene || !isCurrentConnection(generation)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (obs as any).call('GetSourceScreenshot', {
      sourceName: currentScene,
      imageFormat: 'jpeg',
      imageWidth: 320,
      imageCompressionQuality: 50,
    });
    if (!isCurrentConnection(generation)) return;
    const b64 = (result.imageData as string).replace(/^data:image\/\w+;base64,/, '');
    screenshotWs.broadcast(Buffer.from(b64, 'base64'));
  } catch {
    // Ignore screenshot errors (e.g. scene not yet loaded or disconnect).
  } finally {
    screenshotInFlight = false;
    if (isCurrentConnection(generation)) {
      screenshotTimer = setTimeout(() => {
        screenshotTimer = null;
        void captureScreenshot(generation);
      }, SCREENSHOT_INTERVAL_MS);
    }
  }
}

function startScreenshotCapture(generation: number): void {
  stopScreenshotCapture();
  screenshotTimer = setTimeout(() => {
    screenshotTimer = null;
    if (!isCurrentConnection(generation)) return;
    if (screenshotInFlight) {
      screenshotTimer = setTimeout(() => {
        screenshotTimer = null;
        if (!isCurrentConnection(generation)) return;
        if (screenshotInFlight) {
          startScreenshotCapture(generation);
        } else {
          void captureScreenshot(generation);
        }
      }, 50);
      return;
    }
    void captureScreenshot(generation);
  }, 0);

}
function stopScreenshotCapture(): void {
  if (screenshotTimer) {
    clearTimeout(screenshotTimer);
    screenshotTimer = null;
  }
}

async function connect(): Promise<void> {
  wantConnected = true;
  if (obsConnected || connectInFlight) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connectInFlight = true;
  const generation = ++connectionGeneration;
  logger.log('[OBS] Attempting to connect to', config.obs.address);
  try {
    // 2047 = All standard events; 65536 = InputVolumeMeters (high-frequency, opt-in)
    await obs.connect(config.obs.address, config.obs.password || undefined, { eventSubscriptions: 2047 | 65536 });
    if (!isCurrentGeneration(generation)) {
      obs.disconnect();
      return;
    }
    obsConnected = true;
    logger.log('[OBS] Connected');
    state.update('obs', { connected: true });
    await refreshState(generation);
    if (isCurrentConnection(generation)) startScreenshotCapture(generation);
  } catch (err) {
    if (isCurrentGeneration(generation)) {
      obsConnected = false;
      logger.log('[OBS] Connection failed:', (err as Error).message);
      state.update('obs', { connected: false });
      scheduleReconnect();
    }
  } finally {
    connectInFlight = false;
    if (wantConnected && generation !== connectionGeneration && !obsConnected) scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!wantConnected || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, 5000);
}

obs.on('ConnectionClosed', () => {
  obsConnected = false;
  connectionGeneration++;
  logger.log('[OBS] Disconnected');
  stopScreenshotCapture();
  state.update('obs', { connected: false });
  if (wantConnected) scheduleReconnect();
});

obs.on('CurrentProgramSceneChanged', async ({ sceneName }) => {
  const generation = connectionGeneration;
  if (!isCurrentConnection(generation)) return;
  state.update('obs', { currentScene: sceneName });
  await refreshLiveStatus(sceneName, generation);
});

obs.on('SceneListChanged', async () => {
  const generation = connectionGeneration;
  if (!isCurrentConnection(generation)) return;
  try {
    const { scenes } = await obs.call('GetSceneList');
    if (!isCurrentConnection(generation)) return;
    state.update('obs', { scenes: scenes.map((s) => s.sceneName as string).reverse() });
  } catch (err) {
    if (isCurrentConnection(generation)) {
      logger.error('[OBS] Scene list refresh failed:', (err as Error).message);
    }
  }
});

obs.on('StreamStateChanged', ({ outputActive }) => {
  if (!obsConnected) return;
  state.update('obs', { streaming: outputActive });
});

obs.on('RecordStateChanged', ({ outputActive }) => {
  if (!obsConnected) return;
  state.update('obs', { recording: outputActive });
});

obs.on('InputVolumeChanged', ({ inputName, inputVolumeMul }) => {
  if (!obsConnected) return;
  const db = mulToDb(inputVolumeMul);
  const rounded = isFinite(db) ? Math.round(db * 1000) / 1000 : db;
  const sources = state.get().obs.audioSources.map((s) =>
    s.name === inputName ? { ...s, volume: rounded } : s
  );
  state.update('obs', { audioSources: sources });
});

obs.on('InputVolumeMeters', ({ inputs }) => {
  if (!obsConnected) return;

  const obsLevels: Record<string, number> = {};
  for (const input of inputs) {
    // inputLevelsMul format per obs-websocket spec: [[magnitude, peak, inputPeak], ...]
    // Use peak (index 1). inputPeak (index 2) is near 1.0 for any active source — do not use.
    const levels = input.inputLevelsMul as number[][];
    if (!levels || levels.length === 0) continue;
    obsLevels[input.inputName as string] = Math.round(extractObsPeak(levels) * 1000) / 1000;
  }
  // Broadcast level-only updates directly to /ws/levels — do NOT call state.update
  // so the main WebSocket doesn't re-render all Alpine x-for elements on every meter tick.
  levelsWs.broadcast({ x32: {}, obs: obsLevels });
});

obs.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
  if (!obsConnected) return;
  const sources = state.get().obs.audioSources.map((s) =>
    s.name === inputName ? { ...s, muted: inputMuted } : s
  );
  state.update('obs', { audioSources: sources });
});

obs.on('SceneItemEnableStateChanged', async () => {
  const generation = connectionGeneration;
  if (!isCurrentConnection(generation)) return;
  const currentScene = state.get().obs.currentScene;
  if (currentScene) {
    await refreshLiveStatus(currentScene, generation);
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

// Returns true if the source is hidden from the OBS audio mixer panel.
async function isSourceHiddenFromMixer(sourceName: string): Promise<boolean> {
  try {
    // GetSourcePrivateSettings is not in obs-websocket-js type definitions
    // (private settings API), so the call goes through an unchecked surface.
    const untypedCall = obs as unknown as { call(request: string, args?: Record<string, unknown>): Promise<unknown> };
    const result = await untypedCall.call('GetSourcePrivateSettings', { sourceName });
    const settings = (result as { sourcePrivateSettings?: Record<string, unknown> } | null)?.sourcePrivateSettings;
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

async function refreshLiveStatus(sceneName: string, generation = connectionGeneration): Promise<void> {
  try {
    const liveSourceNames = await getSceneSourceNames(sceneName);
    if (!isCurrentConnection(generation)) return;
    const prevSources = state.get().obs.audioSources;
    const sources = applyLiveStatus(prevSources, liveSourceNames);
    state.update('obs', { audioSources: sources });
  } catch (err) {
    if (isCurrentConnection(generation)) {
      logger.log('[OBS] Failed to refresh live status:', (err as Error).message);
    }
  }
}


async function refreshState(generation = connectionGeneration): Promise<void> {
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
    if (!isCurrentConnection(generation)) return;

    // Get audio sources, filtering out those hidden from the OBS audio mixer
    const { inputs } = await obs.call('GetInputList');
    if (!isCurrentConnection(generation)) return;
    const audioSources: Array<{ name: string; volume: number; muted: boolean; live: boolean; level: number }> = [];
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
          level: 0,
        });
      } catch {
        // Not all inputs have audio
      }
    }

    if (!isCurrentConnection(generation)) return;
    state.update('obs', {
      scenes,
      currentScene,
      streaming: streamStatus.outputActive,
      recording: recordStatus.outputActive,
      audioSources,
    });
  } catch (err) {
    if (isCurrentGeneration(generation)) {
      logger.log('[OBS] Failed to refresh state:', (err as Error).message);
    }
  }

}
function disconnect(): void {
  wantConnected = false;
  obsConnected = false;
  connectionGeneration++;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopScreenshotCapture();
  obs.disconnect();
}

const obsConnection = {
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
      imageWidth: 320,
      imageCompressionQuality: 50,
    });
    const b64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(b64, 'base64');
  },
};

export default obsConnection;
