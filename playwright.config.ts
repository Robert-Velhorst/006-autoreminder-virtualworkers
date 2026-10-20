import { defineConfig, devices } from '@playwright/test';

const remoteE2E = Boolean(
  process.env.E2E_BASE_URL &&
  !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(process.env.E2E_BASE_URL),
);

/**
 * Playwright E2E Test Configuration
 * See https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  
  /* Run tests in files in parallel */
  fullyParallel: !remoteE2E,
  
  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,
  
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  
  /* Opt out of parallel tests on CI */
  // Public tunnels are intentionally verified serially. A full browser matrix
  // otherwise opens dozens of concurrent connections and can make the tunnel
  // itself appear unavailable even while the application is healthy.
  // Keep local browser matrices below the point where Chromium, Firefox, and
  // WebKit compete for the same desktop resources and leave the test runner
  // waiting on orphaned browser workers.
  workers: process.env.CI || remoteE2E ? 1 : 4,
  
  /* Reporter to use */
  reporter: [
    ['html'],
    ['json', { outputFile: 'test-results/results.json' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  
  /* Shared settings for all the projects below */
  use: {
    /* Base URL to use in actions like `await page.goto('/')` */
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3025',
    
    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',
    
    /* Screenshot on failure */
    screenshot: 'only-on-failure',
    
    /* Video on failure */
    video: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports */
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],

  // E2E runs against an explicitly started, isolated environment. Starting a
  // dev server here could make legacy write tests target the configured DB.
  webServer: undefined,
});
