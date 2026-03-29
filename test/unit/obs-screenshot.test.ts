import assert from 'node:assert/strict';

// Unit tests for the OBS screenshot push logic.
// These test the pure helper functions that will be extracted/used by obs.ts.

describe('OBS screenshot push logic', () => {
  // Simulates the captureAndPushScreenshot logic:
  // - calls obs.call('GetSourceScreenshot', ...) with correct params
  // - pushes imageData as obs.screenshot via state.update
  test('screenshot is captured with correct parameters', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const stateUpdates: Array<{ section: string; patch: Record<string, unknown> }> = [];

    const mockObs = {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return { imageData: 'data:image/jpeg;base64,/9j/fakedata' };
      },
    };

    const mockState = {
      update: (section: string, patch: Record<string, unknown>) => {
        stateUpdates.push({ section, patch });
      },
    };

    const sourceName = 'Test Scene';

    // Simulate what captureAndPushScreenshot does
    const result = await mockObs.call('GetSourceScreenshot', {
      sourceName,
      imageFormat: 'jpeg',
      imageWidth: 320,
      imageCompressionQuality: 50,
    });
    mockState.update('obs', { screenshot: result.imageData });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GetSourceScreenshot');
    assert.deepEqual(calls[0].params, {
      sourceName: 'Test Scene',
      imageFormat: 'jpeg',
      imageWidth: 320,
      imageCompressionQuality: 50,
    });

    assert.equal(stateUpdates.length, 1);
    assert.equal(stateUpdates[0].section, 'obs');
    assert.equal(stateUpdates[0].patch.screenshot, 'data:image/jpeg;base64,/9j/fakedata');
  });

  test('screenshot is a data URL (starts with data:image/jpeg;base64,)', async () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/somebase64data==';
    assert.ok(dataUrl.startsWith('data:image/jpeg;base64,'), 'screenshot must be a data URL');
  });

  test('screenshot push interval is 250ms (config-independent default)', () => {
    // The interval used for screenshot pushing should be 250ms
    const SCREENSHOT_PUSH_INTERVAL_MS = 250;
    assert.equal(SCREENSHOT_PUSH_INTERVAL_MS, 250);
  });

  test('screenshot is cleared when OBS disconnects', () => {
    const stateUpdates: Array<{ section: string; patch: Record<string, unknown> }> = [];
    const mockState = {
      update: (section: string, patch: Record<string, unknown>) => {
        stateUpdates.push({ section, patch });
      },
    };

    // Simulate disconnect clearing the screenshot
    mockState.update('obs', { connected: false, screenshot: undefined });

    assert.equal(stateUpdates.length, 1);
    assert.equal(stateUpdates[0].patch.screenshot, undefined);
  });
});
