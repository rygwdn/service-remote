const http = require('http');
const express = require('express');
const path = require('path');
const config = require('./src/config');
const state = require('./src/state');
const { setupWebSocket } = require('./src/ws');
const { setupRoutes } = require('./src/routes');
const obs = require('./src/connections/obs');
const x32 = require('./src/connections/x32');
const proclaim = require('./src/connections/proclaim');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

setupRoutes(app, { obs, x32, proclaim });
setupWebSocket(server, state);

obs.connect();
x32.connect();
proclaim.connect();

const port = config.server.port;
server.listen(port, () => {
  console.log(`Service Remote running at http://localhost:${port}`);
});
