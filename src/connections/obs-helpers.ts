// Pure OBS conversion helpers. Kept separate from src/connections/obs.ts so
// tests can exercise them without importing the connection module, whose
// module body has import-time side effects (client construction, timers).

export function extractObsPeak(levels: number[][]): number {
  if (!levels || levels.length === 0) return 0;
  let peak = 0;
  for (const channel of levels) {
    const value = channel[1];
    if (value != null && value > peak) peak = value;
  }
  return peak;
}

export function applyLiveStatus<T extends { name: string; live: boolean; level: number }>(
  sources: T[],
  liveSourceNames: ReadonlySet<string>,
): T[] {
  return sources.map((source) => ({
    ...source,
    live: liveSourceNames.has(source.name),
    level: liveSourceNames.has(source.name) ? source.level : 0,
  }));
}

export function mulToDb(mul: number): number {
  if (mul === 0) return -Infinity;
  return 20 * Math.log10(mul);
}

export function dbToMul(db: number): number {
  return Math.pow(10, db / 20);
}