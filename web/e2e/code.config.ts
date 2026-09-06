import { defineConfig, devices } from '@playwright/test';

/*
 * The code journey needs a real `tolquane web` behind `/api`, which the shared config
 * does not start: it serves the build and lets the specs answer the routes themselves.
 * This config is the same run pointed at a server of its own --
 *
 *     TOLQUANE_HOME=/tmp/... python -m tolquane web --no-browser --port 8781 \
 *         --workspace /tmp/.../ws
 *     TOLQUANE_API_PORT=8781 npx playwright test --config e2e/code.config.ts
 *
 * -- on ports of its own, so it can run beside another preview. Without a server the
 * spec skips itself rather than failing the suite.
 */

const API_PORT = process.env.TOLQUANE_API_PORT ?? '8765';
const PORT = Number(process.env.TOLQUANE_PREVIEW_PORT ?? 4188);

export default defineConfig({
  testDir: '.',
  testMatch: 'code.spec.ts',
  outputDir: '../test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite preview --port ${String(PORT)} --strictPort`,
    // Relative to this file, which is not where the vite config is.
    cwd: '..',
    url: `http://127.0.0.1:${String(PORT)}`,
    env: { TOLQUANE_API_PORT: API_PORT },
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
