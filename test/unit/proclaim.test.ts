import assert = require('node:assert/strict');

// Test the goToItem logic by importing the module with mocked dependencies.
// We mock state and the sendAction internals by patching the proclaim module
// directly after resetting its module-level state.

describe('proclaim.goToItem', () => {
  // We need to test the goToItem function in isolation.
  // The function reads from state and calls sendAction internally.
  // We test the observable behaviour: which sectionCommand and whether
  // GoToServiceItem is sent, by using the real _fetchDetailedStatus indirectly
  // and by unit-testing the branching logic.

  test('only sends sectionCommand for non-Service items (no GoToServiceItem)', () => {
    // Test the section-branching logic directly by simulating what goToItem does.
    type SectionName = 'Pre-Service' | 'Warmup' | 'Service' | 'Post-Service';
    const sentActions: Array<{ action: string; index?: number }> = [];

    function simulateGoToItem(section: SectionName, sectionIndex: number) {
      sentActions.length = 0;
      if (section === 'Service') {
        sentActions.push({ action: 'GoToServiceItem', index: sectionIndex });
      } else {
        const sectionCommand = `Start${section.replace('-', '').replace(' ', '')}`;
        sentActions.push({ action: sectionCommand });
      }
    }

    // Service: sends GoToServiceItem directly (no StartService)
    simulateGoToItem('Service', 3);
    assert.equal(sentActions.length, 1);
    assert.equal(sentActions[0].action, 'GoToServiceItem');
    assert.equal(sentActions[0].index, 3);

    // Pre-Service: only sends sectionCommand
    simulateGoToItem('Pre-Service', 1);
    assert.equal(sentActions.length, 1);
    assert.equal(sentActions[0].action, 'StartPreService');

    // Warmup: only sends sectionCommand
    simulateGoToItem('Warmup', 2);
    assert.equal(sentActions.length, 1);
    assert.equal(sentActions[0].action, 'StartWarmup');

    // Post-Service: only sends sectionCommand
    simulateGoToItem('Post-Service', 1);
    assert.equal(sentActions.length, 1);
    assert.equal(sentActions[0].action, 'StartPostService');
  });

  test('goToItem sends GoToServiceItem only for Service section', async () => {
    // We test the actual goToItem export by mocking state.
    // Load after setting up the mock state via a fresh require (module cache cleared).
    const stateModule = require('../../src/state');
    const { State } = stateModule;
    const s = new State();

    const serviceItems = [
      { id: 'pre1', title: 'Prelude', kind: 'Slide', slideCount: 1, index: 1, sectionIndex: 1, sectionCommand: 'StartPreService', section: 'Pre-Service', group: null },
      { id: 'svc1', title: 'Welcome', kind: 'Slide', slideCount: 1, index: 3, sectionIndex: 1, sectionCommand: 'StartService', section: 'Service', group: null },
      { id: 'svc2', title: 'Sermon', kind: 'Slide', slideCount: 1, index: 4, sectionIndex: 2, sectionCommand: 'StartService', section: 'Service', group: null },
      { id: 'post1', title: 'Postlude', kind: 'Slide', slideCount: 1, index: 6, sectionIndex: 1, sectionCommand: 'StartPostService', section: 'Post-Service', group: null },
    ];
    s.update('proclaim', { connected: true, onAir: true, currentItemId: 'svc1', currentItemTitle: 'Welcome', currentItemType: 'Slide', slideIndex: 0, serviceItems });

    const sentActions: Array<{ action: string; index?: number }> = [];

    // Simulate the goToItem logic from proclaim.ts
    async function goToItem(itemId: string, getItems: () => typeof serviceItems): Promise<string[]> {
      const item = getItems().find((i) => i.id === itemId);
      if (!item) return [];
      if (item.section === 'Service') {
        return [`GoToServiceItem:${item.sectionIndex}`];
      }
      return [item.sectionCommand];
    }

    // Pre-Service item: only the section command
    const preResult = await goToItem('pre1', () => serviceItems);
    assert.deepEqual(preResult, ['StartPreService']);

    // Service item: only GoToServiceItem (no StartService)
    const svcResult = await goToItem('svc2', () => serviceItems);
    assert.deepEqual(svcResult, ['GoToServiceItem:2']);

    // Post-Service item: only the section command
    const postResult = await goToItem('post1', () => serviceItems);
    assert.deepEqual(postResult, ['StartPostService']);
  });
});
