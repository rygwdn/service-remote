import ws = require('ws');
import http = require('http');

const { WebSocketServer } = ws;

function setupWebSocket(server: http.Server, state: ReturnType<typeof require>): void {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    // Send full state on connect
    ws.send(JSON.stringify({ type: 'state', data: state.get() }));
  });

  // Broadcast state changes to all connected browsers
  state.on('change', ({ section, state: fullState }: { section: string; state: unknown }) => {
    const msg = JSON.stringify({ type: 'state', data: fullState });
    for (const ws of wss.clients) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  });
}

export = { setupWebSocket };
