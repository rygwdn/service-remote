import assert = require('node:assert/strict');

// Test the refreshLiveStatus logic: live flag and level reset when sources go offline.

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
