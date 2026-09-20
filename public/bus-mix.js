// Bus mix page controller. Shared fader and WebSocket factories own lifecycle,
// throttling, reconnect, and visibility handling for this page.
const _busIndex = parseInt(new URLSearchParams(location.search).get('bus') || '0', 10);
let _busWsController = null;

function handleBusMessage(event) {
  if (!window.Alpine || typeof event.data !== 'string') return;

  let message;
  try {
    message = JSON.parse(event.data);
  } catch (_) {
    return;
  }

  const store = Alpine.store('bus');
  if (message.type === 'bus-state') {
    // Mixer connectivity comes from the X32 state carried by bus-state.  It is
    // deliberately independent from the transport connection below.
    store.connected = !!message.connected;
    store.busChannel = message.busChannel ?? null;
    store.channels = Array.isArray(message.channels) ? message.channels : [];
  } else if (message.type === 'levels') {
    handleLevelsMessage(message);
  }
}

function connectBusWs(busIndex) {
  if (_busWsController) return _busWsController;

  _busWsController = window.createManagedWebSocket({
    // Explicit subscriptions avoid receiving the full state snapshot on the
    // standalone bus page while retaining channel and bus meter updates.
    subscriptions: ['levels', `bus:${busIndex}`],
    onOpen: () => {
      if (window.Alpine) Alpine.store('bus').serverConnected = true;
    },
    onMessage: handleBusMessage,
    onClose: () => {
      if (window.Alpine) Alpine.store('bus').serverConnected = false;
    },
  });
  return _busWsController;
}

document.addEventListener('alpine:init', () => {
  Alpine.store('bus', {
    busIndex: _busIndex,
    // X32 mixer state and server transport state are intentionally separate.
    connected: false,
    serverConnected: false,
    busChannel: null,
    channels: [],
  });

  // These providers retain the existing Alpine names/DOM contracts.  Their
  // request lifecycle is implemented by createFaderComponent in shared.js.
  Alpine.data('x32FaderComponent', x32FaderComponent);
  Alpine.data('busSendFaderComponent', busSendFaderComponent);

  connectBusWs(_busIndex);
});
