import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level tests (optional, `yarn e2e`). They drive the production build in real Chromium, so they
 * need the browser once: `yarn playwright install chromium`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: { command: 'yarn build && yarn preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: true, timeout: 120_000 },
});
