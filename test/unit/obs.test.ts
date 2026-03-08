import assert = require('node:assert/strict');

// Test the refreshLiveStatus logic: live flag and level reset when sources go offline.

describe('OBS extractObsPeak()', () => {
  // Pure function extracted from obs.ts InputVolumeMeters handler.
  // inputLevelsMul format per obs-websocket spec: [[magnitude, peak, inputPeak], ...]
  // Each inner array is one stereo channel pair. We want peak (index 1).
  function extractObsPeak(levels: number[][]): number {
    if (!levels || levels.length === 0) return 0;
    let peak = 0;
    for (const ch of levels) {
      const val = ch[1];
      if (val != null && val > peak) peak = val;
    }
    return peak;
  }

  test('returns 0 for empty levels array', () => {
    assert.equal(extractObsPeak([]), 0);
  });

  test('returns peak (index 1) from a single channel pair', () => {
    // [magnitude=0.1, peak=0.6, inputPeak=0.99]
    assert.equal(extractObsPeak([[0.1, 0.6, 0.99]]), 0.6);
  });

  test('returns max peak across multiple channel pairs', () => {
    assert.equal(extractObsPeak([[0.1, 0.4, 0.9], [0.2, 0.7, 0.95]]), 0.7);
  });

  test('does NOT use inputPeak (index 2) — regression for 100% bug', () => {
    // inputPeak (index 2) is typically near 1.0 for any active source.
    // Using it caused meters to always show ~100%.
    const levels = [[0.05, 0.3, 0.98]]; // inputPeak is 0.98 — should NOT be used
    const result = extractObsPeak(levels);
    assert.ok(result < 0.98, `expected < 0.98, got ${result} — likely using inputPeak`);
    assert.equal(result, 0.3);
  });

  test('returns 0 when all peaks are 0', () => {
    assert.equal(extractObsPeak([[0, 0, 0], [0, 0, 0]]), 0);
  });
});

describe('OBS InputVolumeMeters level rounding', () => {
  // Pure function mirroring the level-update logic in obs.ts InputVolumeMeters handler
  function applyLevelUpdates(
    sources: Array<{ name: string; level: number }>,
    updates: Record<string, number>
  ) {
    return sources.map((s) =>
      updates[s.name] != null ? { ...s, level: Math.round(updates[s.name] * 1000) / 1000 } : s
    );
  }

  test('level is rounded to 3 decimal places before storing', () => {
    const sources = [{ name: 'Mic 1', level: 0 }];
    // A float value with many decimal places (simulating post-fader peak noise)
    const result = applyLevelUpdates(sources, { 'Mic 1': 0.123456789 });
    assert.equal(result[0].level, 0.123, 'level should be rounded to 3 decimal places');
  });

  test('level 0.5 is stored as 0.5 unchanged', () => {
    const sources = [{ name: 'Desktop Audio', level: 0 }];
    const result = applyLevelUpdates(sources, { 'Desktop Audio': 0.5 });
    assert.equal(result[0].level, 0.5);
  });

  test('level 0.0 is stored as 0.0 unchanged', () => {
    const sources = [{ name: 'Mic 1', level: 0.5 }];
    const result = applyLevelUpdates(sources, { 'Mic 1': 0.0 });
    assert.equal(result[0].level, 0.0);
  });

  test('minor float noise after 3 decimal places is discarded', () => {
    // e.g. 0.7999999... should round to 0.8 not store full precision
    const sources = [{ name: 'Mic 1', level: 0 }];
    const result = applyLevelUpdates(sources, { 'Mic 1': 0.7999999 });
    assert.equal(result[0].level, 0.8);
  });

  test('sources not in updates are left unchanged', () => {
    const sources = [
      { name: 'Mic 1', level: 0.42 },
      { name: 'Desktop Audio', level: 0.1 },
    ];
    const result = applyLevelUpdates(sources, { 'Desktop Audio': 0.9 });
    assert.equal(result[0].level, 0.42, 'Mic 1 should not change');
    assert.equal(result[1].level, 0.9);
  });
});

describe('OBS InputVolumeChanged volume rounding', () => {
  // Pure function mirroring the volume-update logic in obs.ts InputVolumeChanged handler
  function mulToDb(mul: number): number {
    if (mul === 0) return -Infinity;
    return 20 * Math.log10(mul);
  }

  function applyVolumeUpdate(
    sources: Array<{ name: string; volume: number }>,
    inputName: string,
    inputVolumeMul: number
  ) {
    return sources.map((s) =>
      s.name === inputName
        ? { ...s, volume: Math.round(mulToDb(inputVolumeMul) * 1000) / 1000 }
        : s
    );
  }

  test('volume in dB is rounded to 3 decimal places', () => {
    const sources = [{ name: 'Mic 1', volume: 0 }];
    // mul=0.5 → dB = 20*log10(0.5) = -6.020599913... → rounds to -6.021
    const result = applyVolumeUpdate(sources, 'Mic 1', 0.5);
    assert.equal(result[0].volume, Math.round(mulToDb(0.5) * 1000) / 1000);
    const str = Math.abs(result[0].volume).toString();
    const decimals = str.includes('.') ? str.split('.')[1].length : 0;
    assert.ok(decimals <= 3, `expected at most 3 decimal places, got ${decimals}`);
  });

  test('volume for mul=1.0 (0 dB) is stored as 0', () => {
    const sources = [{ name: 'Desktop Audio', volume: -10 }];
    const result = applyVolumeUpdate(sources, 'Desktop Audio', 1.0);
    assert.equal(result[0].volume, 0);
  });

  test('volume for mul=0 (-Infinity dB) is stored as -Infinity', () => {
    const sources = [{ name: 'Mic 1', volume: -10 }];
    const result = applyVolumeUpdate(sources, 'Mic 1', 0);
    assert.equal(result[0].volume, -Infinity);
  });
});

describe('mulToDisplayPct()', () => {
  // Pure function mirroring the meter display conversion in app.js.
  // Converts a linear 0–1 amplitude multiplier to a 0–100 display percentage
  // using a dB scale mapped to [-60dB, 0dB].
  // Formula: clamp((20*log10(mul) + 60) / 60, 0, 1) * 100
  function mulToDisplayPct(mul: number): number {
    if (mul <= 0) return 0;
    const db = 20 * Math.log10(mul);
    return Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
  }

  test('0 (silence) → 0%', () => {
    assert.equal(mulToDisplayPct(0), 0);
  });

  test('1.0 (0 dBFS) → 100%', () => {
    assert.equal(mulToDisplayPct(1.0), 100);
  });

  test('-20 dBFS (mul≈0.1) → 67%', () => {
    // (20*log10(0.1) + 60) / 60 = (-20 + 60) / 60 = 40/60 ≈ 0.667
    const mul = Math.pow(10, -20 / 20); // 0.1
    const result = mulToDisplayPct(mul);
    assert.ok(Math.abs(result - 66.67) < 0.1, `expected ~66.7%, got ${result}`);
  });

  test('-60 dBFS (mul≈0.001) → 0%', () => {
    const mul = Math.pow(10, -60 / 20);
    const result = mulToDisplayPct(mul);
    assert.ok(Math.abs(result) < 0.1, `expected ~0%, got ${result}`);
  });

  test('values below -60 dBFS clamp to 0%', () => {
    const mul = Math.pow(10, -80 / 20);
    assert.equal(mulToDisplayPct(mul), 0);
  });

  test('values above 0 dBFS clamp to 100%', () => {
    assert.equal(mulToDisplayPct(2.0), 100); // +6 dBFS — clamp to 100%
  });
});

describe('OBS refreshLiveStatus logic', () => {
  function applyLiveStatus(
    prevSources: Array<{ name: string; live: boolean; level: number }>,
    liveSourceNames: Set<string>
  ) {
    return prevSources.map((s) => ({
      ...s,
      live: liveSourceNames.has(s.name),
      level: liveSourceNames.has(s.name) ? s.level : 0,
    }));
  }

  test('live flag is updated based on current scene sources', () => {
    const prev = [
      { name: 'Mic 1', live: true, level: 0.5 },
      { name: 'Desktop Audio', live: false, level: 0.0 },
    ];
    const result = applyLiveStatus(prev, new Set(['Desktop Audio']));
    assert.equal(result[0].live, false);
    assert.equal(result[1].live, true);
  });

  test('level is reset to 0 when a source goes offline', () => {
    const prev = [
      { name: 'Mic 1', live: true, level: 0.8 },
      { name: 'Desktop Audio', live: true, level: 0.3 },
    ];
    const result = applyLiveStatus(prev, new Set(['Desktop Audio']));
    assert.equal(result[0].level, 0, 'Mic 1 level should be reset to 0');
    assert.equal(result[1].level, 0.3, 'Desktop Audio level should be unchanged');
  });

  test('level of already-offline sources stays 0', () => {
    const prev = [
      { name: 'Mic 1', live: false, level: 0.0 },
    ];
    const result = applyLiveStatus(prev, new Set());
    assert.equal(result[0].level, 0);
    assert.equal(result[0].live, false);
  });
});
