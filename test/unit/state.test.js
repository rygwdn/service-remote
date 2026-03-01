const assert = require('node:assert/strict');
const { State } = require('../../src/state');

describe('State', () => {
  test('get() returns the initial shape', () => {
    const s = new State();
    const data = s.get();
    assert.deepEqual(Object.keys(data).sort(), ['obs', 'proclaim', 'x32']);
    assert.equal(data.obs.connected, false);
    assert.deepEqual(data.obs.scenes, []);
    assert.equal(data.x32.connected, false);
    assert.deepEqual(data.x32.channels, []);
    assert.equal(data.proclaim.connected, false);
    assert.equal(data.proclaim.onAir, false);
    assert.equal(data.proclaim.currentItemId, null);
    assert.equal(data.proclaim.currentItemTitle, null);
    assert.equal(data.proclaim.currentItemType, null);
    assert.equal(data.proclaim.slideIndex, null);
    assert.deepEqual(data.proclaim.serviceItems, []);
  });

  test('update() merges a patch into the named section', () => {
    const s = new State();
    s.update('obs', { connected: true, currentScene: 'Camera 1' });
    const obs = s.get().obs;
    assert.equal(obs.connected, true);
    assert.equal(obs.currentScene, 'Camera 1');
    // Other obs fields are preserved
    assert.deepEqual(obs.scenes, []);
    assert.equal(obs.streaming, false);
  });

  test('update() does not affect other sections', () => {
    const s = new State();
    s.update('obs', { connected: true });
    assert.equal(s.get().x32.connected, false);
    assert.equal(s.get().proclaim.connected, false);
  });

  test('successive updates accumulate', () => {
    const s = new State();
    s.update('obs', { connected: true });
    s.update('obs', { currentScene: 'Main' });
    assert.equal(s.get().obs.connected, true);
    assert.equal(s.get().obs.currentScene, 'Main');
  });

  test('update() emits a change event with section and full state', (done) => {
    const s = new State();
    s.once('change', ({ section, state }) => {
      assert.equal(section, 'x32');
      assert.equal(state.x32.connected, true);
      // Full state is passed — other sections are present too
      assert.ok('obs' in state);
      done();
    });
    s.update('x32', { connected: true });
  });

  test('update() with array field replaces it entirely', () => {
    const s = new State();
    s.update('obs', { scenes: ['A', 'B'] });
    s.update('obs', { scenes: ['C'] });
    assert.deepEqual(s.get().obs.scenes, ['C']);
  });
});
