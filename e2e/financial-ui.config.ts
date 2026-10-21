import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: 'financial-ui.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  outputDir: join(tmpdir(), 'va-financial-ui', 'results'),
  reporter: [['list'], ['json', { outputFile: join(tmpdir(), 'va-financial-ui', 'report.json') }]],
  use: { serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Every document/API request is fulfilled in-process; no server is started.
});
