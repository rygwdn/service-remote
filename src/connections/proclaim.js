const config = require('../config');
const state = require('../state');

let midi = null;
let output = null;

function connect() {
  try {
    // easymidi requires native MIDI support — gracefully handle if unavailable
    midi = require('easymidi');
    output = new midi.Output(config.proclaim.midiPortName, true);
    console.log(`[Proclaim] Virtual MIDI port created: "${config.proclaim.midiPortName}"`);
    state.update('proclaim', { connected: true });
  } catch (err) {
    console.log('[Proclaim] MIDI not available:', err.message);
    console.log('[Proclaim] Install system MIDI support or run on a machine with MIDI capability');
    state.update('proclaim', { connected: false });
  }
}

function sendAction(actionName) {
  const action = config.proclaim.actions[actionName];
  if (!action) {
    console.log(`[Proclaim] Unknown action: ${actionName}`);
    return false;
  }

  if (!output) {
    console.log('[Proclaim] MIDI not connected');
    return false;
  }

  if (action.type === 'cc') {
    output.send('cc', {
      controller: action.controller,
      value: action.value,
      channel: action.channel,
    });
  } else if (action.type === 'noteon') {
    output.send('noteon', {
      note: action.note,
      velocity: action.velocity || 127,
      channel: action.channel,
    });
    // Send note off after a short delay
    setTimeout(() => {
      output.send('noteoff', {
        note: action.note,
        velocity: 0,
        channel: action.channel,
      });
    }, 100);
  }

  console.log(`[Proclaim] Sent: ${actionName}`);
  return true;
}

module.exports = {
  connect,
  sendAction,
};
