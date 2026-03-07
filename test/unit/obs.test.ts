import assert = require('node:assert/strict');

// Test that the fade-out logic is correct when a source goes from live to not-live.
// We test the logic in isolation by simulating what refreshLiveStatus does.

describe('OBS refreshLiveStatus fade-out logic', () => {
  test('sources that go from live to not-live are faded out', async () => {
    const fadedOut: string[] = [];
    const monitorCleared: string[] = [];

    // Simulate the obs.call mock
    async function obsCall(method: string, params: { inputName: string; inputVolumeMul?: number; monitorType?: string }) {
      if (method === 'SetInputVolume' && params.inputVolumeMul === 0) {
        fadedOut.push(params.inputName);
      }
      if (method === 'SetInputAudioMonitorType' && params.monitorType === 'OBS_MONITORING_TYPE_NONE') {
        monitorCleared.push(params.inputName);
      }
    }

    const prevSources = [
      { name: 'Mic 1', volume: -10, muted: false, live: true, level: 0.5 },
      { name: 'Desk Mic', volume: -20, muted: false, live: false, level: 0.0 },
      { name: 'Desktop Audio', volume: -30, muted: false, live: true, level: 0.2 },
    ];

    // New scene: only Desktop Audio is live
    const liveSourceNames = new Set(['Desktop Audio']);

    const sources = prevSources.map((s) => ({ ...s, live: liveSourceNames.has(s.name) }));

    const fadingOut: Array<Promise<void>> = [];
    const nextSources = [...sources];
    for (let i = 0; i < prevSources.length; i++) {
      const prev = prevSources[i];
      const next = sources[i];
      if (prev.live && !next.live) {
        fadingOut.push(
          (async () => {
            await obsCall('SetInputVolume', { inputName: prev.name, inputVolumeMul: 0 });
            await obsCall('SetInputAudioMonitorType', { inputName: prev.name, monitorType: 'OBS_MONITORING_TYPE_NONE' });
          })()
        );
        nextSources[i] = { ...next, volume: -Infinity };
      }
    }
    await Promise.all(fadingOut);

    // Mic 1 was live, now not-live → faded out
    assert.ok(fadedOut.includes('Mic 1'), 'Mic 1 should be faded out');
    assert.ok(monitorCleared.includes('Mic 1'), 'Mic 1 monitor should be cleared');

    // Desk Mic was already not-live → not affected
    assert.ok(!fadedOut.includes('Desk Mic'), 'Desk Mic was already not-live, should not be faded');

    // Desktop Audio is still live → not faded
    assert.ok(!fadedOut.includes('Desktop Audio'), 'Desktop Audio is still live, should not be faded');

    // State: Mic 1 volume should be -Infinity
    assert.equal(nextSources[0].volume, -Infinity);
    // Desktop Audio volume unchanged
    assert.equal(nextSources[2].volume, -30);
  });

  test('sources that were already not-live are not faded again', async () => {
    const fadedOut: string[] = [];

    async function obsCall(method: string, params: { inputName: string; inputVolumeMul?: number }) {
      if (method === 'SetInputVolume' && params.inputVolumeMul === 0) {
        fadedOut.push(params.inputName);
      }
    }

    const prevSources = [
      { name: 'Mic 1', volume: -Infinity, muted: false, live: false, level: 0.0 },
    ];
    const liveSourceNames = new Set<string>(); // still not live

    const fadingOut: Array<Promise<void>> = [];
    const sources = prevSources.map((s) => ({ ...s, live: liveSourceNames.has(s.name) }));
    for (let i = 0; i < prevSources.length; i++) {
      if (prevSources[i].live && !sources[i].live) {
        fadingOut.push(obsCall('SetInputVolume', { inputName: prevSources[i].name, inputVolumeMul: 0 }));
      }
    }
    await Promise.all(fadingOut);

    assert.equal(fadedOut.length, 0, 'already-not-live source should not be faded again');
  });
});
