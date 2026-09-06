import { mkdir } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';

/*
 * Running a flow, for real.
 *
 * Unlike the other journeys here, this one needs the Python server: a run is a child
 * process the supervisor owns and a WebSocket the browser reads, and neither can be
 * faked into telling the truth. Start one on a workspace holding the flows below and
 * point the preview server's proxy at it:
 *
 *     TOLQUANE_HOME=… .venv/bin/python -m tolquane web --no-browser --port 8782 \
 *         --workspace <ws>
 *     TOLQUANE_API_PORT=8782 npx playwright test run.spec.ts
 *
 * Without `TOLQUANE_API_PORT` the whole file is skipped, so `npm run e2e` stays green on
 * a machine that has no server.
 */

const OUT = 'e2e/screenshots';
const THEMES = ['dark', 'light'] as const;

const LIVE = Boolean(process.env.TOLQUANE_API_PORT);

/** The workspace these tests expect; see the file's header. */
const FLOWS = {
  hello: 'hello.py',
  slow: 'slow.py',
  boom: 'boom.py',
  stuck: 'stuck.py',
  words: 'word_count.py',
};

async function useTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    'tolquane.theme',
    theme,
  ] as const);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
}

/** The run's own state, at the end of the drawer's tab strip. */
function summary(page: Page): Locator {
  return page.locator('[role="tablist"][aria-label="Run output"] [data-status]');
}

function runButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Run', exact: true });
}

function cancelButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Cancel/ });
}

async function openFlow(page: Page, flow: string): Promise<void> {
  await page.goto(`/flows/${flow}`);
  await expect(page.getByText('Properties').first()).toBeVisible();
  // The toolbar says "saved" once the file is open and the canvas has it.
  await expect(page.getByText(/saved|layout moved|unsaved changes/).first()).toBeVisible();
  await expect(runButton(page)).toBeEnabled();
}

async function waitForStatus(page: Page, status: string, timeout = 25_000): Promise<void> {
  await expect(summary(page)).toHaveAttribute('data-status', status, { timeout });
}

async function tab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
}

test.describe('running a flow', () => {
  test.skip(!LIVE, 'needs a Tolquane server; set TOLQUANE_API_PORT');

  test.beforeAll(async () => {
    await mkdir(OUT, { recursive: true });
  });

  for (const theme of THEMES) {
    test.describe(`${theme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        await useTheme(page, theme);
      });

      test('runs a flow to done and shows its report', async ({ page }) => {
        await openFlow(page, FLOWS.hello);

        await page.getByRole('button', { name: 'Run options' }).click();
        await expect(page.getByRole('dialog', { name: 'Run options' })).toBeVisible();
        await shoot(page, `${theme}-run-popover`);
        await page.keyboard.press('Escape');

        await runButton(page).click();
        await waitForStatus(page, 'done');

        // Every card ends done, and the console has what the flow printed.
        await expect(page.locator('[data-state="done"]').first()).toBeVisible();
        await expect(page.getByRole('log', { name: 'Run output' })).toContainText('200');
        await shoot(page, `${theme}-run-done`);

        await tab(page, 'Report');
        await expect(page.getByRole('columnheader', { name: 'Busy %' })).toBeVisible();
        await expect(page.getByText('busiest').first()).toBeVisible();
        await shoot(page, `${theme}-run-report`);
      });

      test('shows a run while it happens, and cancels it', async ({ page }) => {
        await openFlow(page, FLOWS.slow);
        await runButton(page).click();

        await waitForStatus(page, 'running', 10_000);
        // A card turns running, and the counters move with it.
        await expect(page.locator('[data-state="running"]').first()).toBeVisible({
          timeout: 10_000,
        });
        await expect(page.getByText(/\d+ items · \d+% busy/).first()).toBeVisible({
          timeout: 10_000,
        });
        await expect(summary(page)).toContainText('Running');
        await shoot(page, `${theme}-run-running`);

        await cancelButton(page).click();
        await waitForStatus(page, 'cancelled');
        await expect(summary(page)).toContainText('Cancelled');
        await shoot(page, `${theme}-run-cancelled`);
      });

      test('puts a failure on the card that raised it', async ({ page }) => {
        await openFlow(page, FLOWS.boom);
        await runButton(page).click();
        await waitForStatus(page, 'failed');

        await expect(page.locator('[data-state="failed"]').first()).toBeVisible();
        await shoot(page, `${theme}-run-error`);

        await tab(page, 'Problems');
        await expect(page.getByText('cannot handle 3').first()).toBeVisible();
        await page.getByText('cannot handle 3').first().click();
        await expect(page.getByText(/Traceback \(most recent call last\)/).first()).toBeVisible();
        await shoot(page, `${theme}-run-problems`);
      });

      test('reports a deadlock rather than hanging', async ({ page }) => {
        await openFlow(page, FLOWS.stuck);
        await runButton(page).click();
        await waitForStatus(page, 'deadlock');

        await tab(page, 'Problems');
        await expect(page.getByText(/every node is waiting on another one/).first()).toBeVisible();
        await shoot(page, `${theme}-run-deadlock`);
      });

      test('shows the items that crossed each edge', async ({ page }) => {
        await openFlow(page, FLOWS.words);
        await runButton(page).click();
        await waitForStatus(page, 'done');

        await tab(page, 'Taps');
        await expect(page.getByRole('listbox', { name: 'Edges' })).toBeVisible();
        await expect(page.getByRole('option').first()).toBeVisible();
        await page.getByRole('option').first().click();
        await expect(page.getByText('Last items')).toBeVisible();
        await shoot(page, `${theme}-run-taps`);
      });

      test('keeps the samples of a flow', async ({ page }) => {
        // A sample stands in for the flow's source, which needs `build(source=None)`;
        // `hello.py` has only a `main()`, so this one is the flow with a build.
        await openFlow(page, FLOWS.slow);
        await page.getByRole('button', { name: 'Run options' }).click();
        await page.getByRole('button', { name: 'Manage samples' }).click();
        await expect(page.getByRole('dialog', { name: 'Samples' })).toBeVisible();
        await page.getByRole('button', { name: 'Add a sample' }).click();
        await page.getByLabel('Name').fill('three numbers');
        await page.getByLabel('Items').fill('1\n2\n3');
        await shoot(page, `${theme}-run-samples`);
        await page.getByRole('button', { name: 'Save samples' }).click();
        await expect(page.getByRole('dialog', { name: 'Samples' })).toBeHidden();

        // The sample is now on the run menu, and running with it works.
        await page.getByRole('button', { name: 'Run options' }).click();
        await page.getByLabel('Input').selectOption('three numbers');
        await page.keyboard.press('Escape');
        await runButton(page).click();
        await waitForStatus(page, 'done');
        await expect(page.getByRole('log', { name: 'Run output' })).toContainText('squared 9');
      });

      test('lists every run in the history', async ({ page }) => {
        await page.goto('/runs');
        await expect(page.getByText('History', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: FLOWS.hello }).first()).toBeVisible();
        await shoot(page, `${theme}-runs-history`);

        await page.getByRole('button', { name: FLOWS.hello }).first().click();
        await expect(page.getByRole('dialog', { name: /^Run \d+ · / })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Run it again' })).toBeVisible();
        await shoot(page, `${theme}-run-dialog`);

        await page.getByRole('button', { name: 'Log' }).click();
        await shoot(page, `${theme}-run-dialog-log`);
      });
    });
  }
});
