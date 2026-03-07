import assert = require('node:assert/strict');

// Test the refreshLiveStatus logic: live flag and level reset when sources go offline.

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
