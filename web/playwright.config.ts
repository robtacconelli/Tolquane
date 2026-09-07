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
import {
  seedUsersWorkspaces,
  SERVER_TOKEN,
  TOKEN_HOME,
  TOKEN_PORT,
  TOKEN_URL,
  TOKEN_WS,
  USERS_HOME,
  USERS_PORT,
  USERS_URL,
  USERS_WS,
} from './e2e/users.harness';

/*
 * One command, one suite: `npm run e2e` builds the frontend, writes a fresh workspace,
 * starts a real `tolquane web` on it and a `vite preview` proxying /api to that server,
 * and runs every journey against it. Nothing has to be running first and no spec skips;
 * the two specs about *not* having a server block /api in the browser instead.
 *
 * Signing in needs servers of other kinds, so there are two more, in their own projects:
 * one with accounts (`users.spec.ts`) and one started with `--token` and nobody in it
 * (`auth.spec.ts`, which makes the first administrator and so runs last). Neither needs
 * a preview of its own -- `tolquane web` serves the build the entry above makes -- so
 * they cost two Python processes and about ten seconds.
 *
 * The workspace is written here rather than in a global setup because Playwright starts
 * the web servers before the global setup runs, and the server holds its database open
 * from the moment it starts. Playwright reads this file again in every worker process;
 * `seedWorkspace` and `port` are both written once and remembered in the environment the
 * workers inherit, so every process agrees on the ports and nobody wipes the workspace
 * halfway through a run.
 */
seedWorkspace();
/* The users feature needs servers that ask who you are; they are two more `tolquane web`
 * processes, seeded here for the same reason and served by themselves (see
 * `e2e/users.harness.ts`). */
seedUsersWorkspaces();

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
    viewport: { width: 1440, height: 900 },
    // Screenshots of a moving target are neither stable nor reviewable, and base.css
    // already stops every animation under this preference.
    reducedMotion: 'reduce',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], baseURL: BASE_URL },
      // The two specs about signing in run against their own servers, below.
      testIgnore: /(users|auth)\.spec\.ts$/,
    },
    {
      // A server with accounts: alice is an administrator, bob a member. `users.spec.ts`
      // signs in through the page, so it needs no token of its own.
      name: 'users',
      testMatch: /users\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: USERS_URL },
    },
    {
      // A server started with --token and no accounts: where the first administrator is
      // made. `auth.spec.ts` leaves it with one, so it runs last.
      name: 'token',
      testMatch: /auth\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: TOKEN_URL },
    },
  ],
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
      // CI builds first and sets TOLQUANE_E2E_PREBUILT, since a build on a two-core
      // runner alone can take longer than the readiness budget.
      command: `${process.env.TOLQUANE_E2E_PREBUILT ? '' : 'npm run build && '}npx vite preview --port ${String(PREVIEW_PORT)} --strictPort`,
      env: { TOLQUANE_API_PORT: String(API_PORT) },
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // The same server, with accounts, serving the build the entry above just made.
      command: `${python()} -m tolquane web --no-browser --host 127.0.0.1 --port ${String(USERS_PORT)} --workspace ${USERS_WS}`,
      cwd: REPO_DIR,
      env: { TOLQUANE_HOME: USERS_HOME, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
      url: `${USERS_URL}/api/health`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // And once more with --token and nobody in it. Its health route wants the token,
      // so the wait is on the page it serves without one.
      command: `${python()} -m tolquane web --no-browser --host 127.0.0.1 --port ${String(TOKEN_PORT)} --workspace ${TOKEN_WS} --token ${SERVER_TOKEN}`,
      cwd: REPO_DIR,
      env: { TOLQUANE_HOME: TOKEN_HOME, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
      url: `${TOKEN_URL}/`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
