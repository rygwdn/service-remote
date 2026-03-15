import { test, expect } from './fixtures';

test.describe('Page Visibility handling', () => {
  test('closes WebSocket connections when tab becomes hidden', async ({ page }) => {
    // Wait for initial WebSocket connection to be established
    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === true, { timeout: 5000 });

    // Simulate the tab being hidden (e.g. backgrounded/throttled)
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // serverConnected should become false as the WebSocket is closed
    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === false, { timeout: 3000 });
  });

  test('reconnects WebSocket immediately when tab becomes visible', async ({ page }) => {
    // Wait for initial connection
    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === true, { timeout: 5000 });

    // Hide the tab
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === false, { timeout: 3000 });

    // Show the tab — should reconnect immediately without backoff delay
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === true, { timeout: 5000 });
  });

  test('does not reconnect while tab remains hidden', async ({ page }) => {
    // Wait for initial connection
    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === true, { timeout: 5000 });

    // Track how many WebSocket connections have been created since we hide
    await page.evaluate(() => {
      (window as any).__wsConnectCount = 0;
      const OriginalWebSocket = window.WebSocket;
      (window as any).WebSocket = function(...args: ConstructorParameters<typeof WebSocket>) {
        (window as any).__wsConnectCount++;
        return new OriginalWebSocket(...args);
      };
      (window as any).WebSocket.prototype = OriginalWebSocket.prototype;
      (window as any).WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
      (window as any).WebSocket.OPEN = OriginalWebSocket.OPEN;
      (window as any).WebSocket.CLOSING = OriginalWebSocket.CLOSING;
      (window as any).WebSocket.CLOSED = OriginalWebSocket.CLOSED;
    });

    // Hide the tab
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === false, { timeout: 3000 });

    // Wait longer than the normal reconnect delay (1000ms) to confirm no reconnect attempts happen
    await page.waitForTimeout(1500);

    const newConnections = await page.evaluate(() => (window as any).__wsConnectCount);
    expect(newConnections).toBe(0);
  });
});
