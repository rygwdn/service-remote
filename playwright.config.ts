import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/ui',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    // baseURL is set per-test via the fixture
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
