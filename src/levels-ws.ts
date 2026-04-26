// levels-ws.ts — thin broadcast module for high-frequency meter data.
// The actual WebSocket server lives in ws.ts (unified Bun WS handler).
// x32.ts and obs.ts call broadcast() here; ws.ts wires in a receiver via setPublisher().

interface LevelsPayload {
  x32: Record<string, number>;
  obs: Record<string, number>;
}

type Publisher = (payload: LevelsPayload) => void;

let activePublisher: Publisher | null = null;

function setPublisher(pub: Publisher): void {
  activePublisher = pub;
}

function broadcast(levels: LevelsPayload): void {
  if (activePublisher) activePublisher(levels);
}

export { setPublisher, broadcast };
export type { LevelsPayload };
