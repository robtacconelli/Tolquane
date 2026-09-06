import { defineConfig, devices } from '@playwright/test';
import {
  API_PORT,
  HOME_DIR,
  PREVIEW_PORT,
  python,
  REPO_DIR,
  seedWorkspace,
  WS_DIR,
} from './e2e/harness';

/*
 * One command, one suite: `npm run e2e` builds the frontend, writes a fresh workspace,
 * starts a real `tolquane web` on it and a `vite preview` proxying /api to that server,
 * and runs every journey against it. Nothing has to be running first and no spec skips;
 * the two specs about *not* having a server block /api in the browser instead.
 *
 * The workspace is written here rather than in a global setup because Playwright starts
 * the web servers before the global setup runs, and the server holds its database open
 * from the moment it starts. Playwright reads this file again in every worker process;
 * `seedWorkspace` and `port` are both written once and remembered in the environment the
 * workers inherit, so every process agrees on the ports and nobody wipes the workspace
 * halfway through a run.
 */
seedWorkspace();

const BASE_URL = `http://127.0.0.1:${String(PREVIEW_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    // Screenshots of a moving target are neither stable nor reviewable, and base.css
    // already stops every animation under this preference.
    reducedMotion: 'reduce',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The real thing: flows are files, a run is a child process, the socket is a socket.
      command: `${python()} -m tolquane web --no-browser --host 127.0.0.1 --port ${String(API_PORT)} --workspace ${WS_DIR}`,
      cwd: REPO_DIR,
      // The keys are cleared rather than inherited: the AI journey scripts the stream it
      // wants, and the one test about *not* having a key needs the server to have none.
      env: { TOLQUANE_HOME: HOME_DIR, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
      url: `http://127.0.0.1:${String(API_PORT)}/api/health`,
      reuseExistingServer: false,
      // SIGTERM so the supervisor gets to kill the runs it owns before it goes.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // The built app, exactly as the wheel ships it; TOLQUANE_API_PORT points its proxy
      // at the server above (see the `preview` block in vite.config.ts).
      command: `npm run build && npx vite preview --port ${String(PREVIEW_PORT)} --strictPort`,
      env: { TOLQUANE_API_PORT: String(API_PORT) },
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
