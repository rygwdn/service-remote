const EventEmitter = require('events');

class State extends EventEmitter {
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

  update(section, patch) {
    this.data[section] = { ...this.data[section], ...patch };
    this.emit('change', { section, state: this.data });
  }

  get() {
    return this.data;
  }
}

const defaultState = new State();
module.exports = defaultState;
module.exports.State = State;
