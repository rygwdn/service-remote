import { EventEmitter } from 'events';
import type { AppState, ChangeEvent } from './types';

class State extends EventEmitter {
  data: AppState;

  constructor() {
    super();
    this.data = {
      obs: {
        connected: false,
        currentScene: '',
        scenes: [],
        streaming: false,
        recording: false,
        audioSources: [],
      },
      x32: {
        connected: false,
        channels: [],
      },
      proclaim: {
        connected: false,
        onAir: false,
        currentItemId: null,
        currentItemTitle: null,
        currentItemType: null,
        slideIndex: null,
        serviceItems: [],
        slideRevisions: {},
        songLyrics: {},
      },
      ptz: {
        cameras: [],
      },
      youtube: {
        connected: false,
        viewerCount: null,
        broadcastId: null,
        broadcastTitle: null,
        broadcastStatus: null,
      },
    };
  }

  update<K extends keyof AppState>(section: K, patch: Partial<AppState[K]>): void {
    const current = this.data[section];
    // A patch only changes the section when one of its own fields differs.
    // Comparing the complete section would both serialize large state slices
    // and miss mutations that happened before this call.
    const changed = (Object.keys(patch) as Array<keyof AppState[K]>).some((key) =>
      !Object.is(current[key], patch[key]),
    );
    if (!changed) return;
    const next = { ...current, ...patch } as AppState[K];
    this.data[section] = next;
    this.emit('change', { section, state: this.data });
  }

  get(): AppState {
    return this.data;
  }

  on(event: 'change', listener: (ev: ChangeEvent) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once(event: 'change', listener: (ev: ChangeEvent) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }
}

const defaultState = new State();
export default defaultState;
export { State };
