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

module.exports = new State();
