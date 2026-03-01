import events = require('events');
import type { AppState, ChangeEvent } from './types';

const { EventEmitter } = events;

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
      },
    };
  }

  update<K extends keyof AppState>(section: K, patch: Partial<AppState[K]>): void {
    this.data[section] = { ...this.data[section], ...patch } as AppState[K];
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
export = Object.assign(defaultState, { State });
