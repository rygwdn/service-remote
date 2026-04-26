// screenshot-ws.ts — thin broadcast module for JPEG screenshot frames.
// The actual WebSocket server lives in ws.ts (unified Bun WS handler).
// obs.ts calls broadcast() here; ws.ts wires in a receiver via setPublisher().

type Publisher = (frame: Buffer) => void;

let activePublisher: Publisher | null = null;

function setPublisher(pub: Publisher): void {
  activePublisher = pub;
}

function broadcast(frame: Buffer): void {
  if (activePublisher) activePublisher(frame);
}

export { setPublisher, broadcast };
