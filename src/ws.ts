import ws = require('ws');
import http = require('http');

const { WebSocketServer } = ws;

interface MeterControl {
  startMeterUpdates(): void;
  stopMeterUpdates(): void;
}

function setupWebSocket(server: http.Server, state: ReturnType<typeof require>, x32?: MeterControl): void {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket) => {
    // Send full state on connect
    socket.send(JSON.stringify({ type: 'state', data: state.get() }));

    // Start meter updates when the first client connects
    if (x32 && wss.clients.size === 1) {
      x32.startMeterUpdates();
    }

    socket.on('close', () => {
      if (!x32) return;
      // Stop meter updates when the last client disconnects.
      // The closing socket's readyState is CLOSED (3) at this point, so counting
      // OPEN sockets gives the number of clients that remain connected.
      let openCount = 0;
      for (const client of wss.clients) {
        if (client.readyState === 1 /* OPEN */) openCount++;
      }
      if (openCount === 0) {
        x32.stopMeterUpdates();
      }
    });
  });

  // Broadcast state changes to all connected browsers
  state.on('change', ({ section, state: fullState }: { section: string; state: unknown }) => {
    const msg = JSON.stringify({ type: 'state', data: fullState });
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try {
          client.send(msg);
        } catch {
          // Client disconnected between readyState check and send
        }
      }
    }
  });
}

export = { setupWebSocket };
