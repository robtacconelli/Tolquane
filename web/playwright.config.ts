import { defineConfig, devices } from '@playwright/test';

// The shell has no server yet, so the e2e run serves the production build and the spec
// fails the /api calls itself; the offline banner is part of what the screenshots capture.
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4178',
    viewport: { width: 1440, height: 900 },
    // Screenshots of a moving target are neither stable nor reviewable, and base.css
    // already stops every animation under this preference.
    reducedMotion: 'reduce',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npx vite preview --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
