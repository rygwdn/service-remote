import { test, expect } from './fixtures';

test.describe('Token entry', () => {
  test('hides the token form while connected', async ({ page }) => {
    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === true, { timeout: 5000 });
    await expect(page.locator('.token-form')).toBeHidden();
    await expect(page.locator('.disconnected-message:not(.token-form)')).toContainText('reconnecting');
  });

  test('shows a prefilled token form when authentication fails', async ({ page }) => {
    // Make the auth probe fail like an unauthenticated client would see.
    await page.route('**/api/state', (route) => route.fulfill({ status: 401, body: 'Unauthorized' }));
    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === true, { timeout: 5000 });
    await page.evaluate(() => {
      const w = window as unknown as { Alpine: { store: (name: string) => { serverConnected: boolean } }; __srCheckAuth: () => void };
      w.Alpine.store('ui').serverConnected = false;
      w.__srCheckAuth();
    });
    const input = page.locator('.token-form input');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('hbc123');
  });

  test('submits the entered token to the bootstrap URL', async ({ page }) => {
    await page.route('**/api/state', (route) => route.fulfill({ status: 401, body: 'Unauthorized' }));
    await page.waitForFunction(() => (window as any).Alpine.store('ui').serverConnected === true, { timeout: 5000 });
    await page.evaluate(() => {
      const w = window as unknown as { Alpine: { store: (name: string) => { serverConnected: boolean } }; __srCheckAuth: () => void };
      w.Alpine.store('ui').serverConnected = false;
      w.__srCheckAuth();
    });
    await page.locator('.token-form input').fill('my-token');
    await page.locator('.token-form button').click();
    await page.waitForURL(/token=my-token/, { timeout: 5000 });
    expect(new URL(page.url()).searchParams.get('token')).toBe('my-token');
  });
});
