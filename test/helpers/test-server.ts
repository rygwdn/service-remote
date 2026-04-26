// Standalone Bun entry point for Playwright UI tests.
// Spawned as a subprocess; prints the port to stdout once ready.
import { createTestApp } from './app';

const { server } = createTestApp({ servePublic: true });
process.stdout.write(`${server.port}\n`);
