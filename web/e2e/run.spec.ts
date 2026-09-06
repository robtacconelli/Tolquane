import { expect, test } from '@playwright/test';
import { FLOWS } from './harness';
import {
  drawerTab,
  openFlow,
  runButton,
  runSummary,
  shoot,
  THEMES,
  useEditorLayout,
  useTheme,
  waitForRun,
} from './helpers';

/*
 * Running a flow, for real.
 *
 * A run is a child process the supervisor owns and a WebSocket the browser reads, and
 * neither can be faked into telling the truth, so every run here is a real one against
 * the server the suite started. The flows come from the seeded workspace: one that takes
 * its time, one that raises on the third item, one whose loop can never drain.
 */

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
  await useEditorLayout(page);
});

test('runs a flow to done and shows its report', async ({ page }) => {
  await openFlow(page, FLOWS.hello);

  await page.getByRole('button', { name: 'Run options' }).click();
  await expect(page.getByRole('dialog', { name: 'Run options' })).toBeVisible();
  await shoot(page, 'run-popover');
  await page.keyboard.press('Escape');

  await runButton(page).click();
  await waitForRun(page, 'done');

  // Every card ends done, and the console has what the flow printed.
  await expect(page.locator('[data-state="done"]').first()).toBeVisible();
  await expect(page.getByRole('log', { name: 'Run output' })).toContainText('200');
  await shoot(page, 'run-done');

  await drawerTab(page, 'Report');
  await expect(page.getByRole('columnheader', { name: 'Busy %' })).toBeVisible();
  await expect(page.getByText('busiest').first()).toBeVisible();
  await shoot(page, 'run-report');
});

test('shows a run while it happens, and cancels it', async ({ page }) => {
  await openFlow(page, FLOWS.slow);
  await runButton(page).click();

  await waitForRun(page, 'running', 20_000);
  // A card turns running, and the counters move with it.
  await expect(page.locator('[data-state="running"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/\d+ items · \d+% busy/).first()).toBeVisible({ timeout: 15_000 });
  await expect(runSummary(page)).toContainText('Running');
  await shoot(page, 'run-running');

  await page.getByRole('button', { name: /^Cancel/ }).click();
  await waitForRun(page, 'cancelled');
  await expect(runSummary(page)).toContainText('Cancelled');
  await shoot(page, 'run-cancelled');
});

test('puts a failure on the card that raised it, with its traceback', async ({ page }) => {
  await openFlow(page, FLOWS.boom);
  await runButton(page).click();
  await waitForRun(page, 'failed');

  await expect(page.locator('[data-state="failed"]').first()).toBeVisible();
  await shoot(page, 'run-error');

  await drawerTab(page, 'Problems');
  const row = page.getByRole('button').filter({ hasText: 'cannot handle 3' }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText(/Traceback \(most recent call last\)/).first()).toBeVisible();
  await shoot(page, 'run-problems');
});

test('reports a deadlock rather than hanging', async ({ page }) => {
  await openFlow(page, FLOWS.stuck);
  await runButton(page).click();
  await waitForRun(page, 'deadlock');

  await drawerTab(page, 'Problems');
  await expect(page.getByText(/every node is waiting on another one/).first()).toBeVisible();
  await shoot(page, 'run-deadlock');
});

test('shows the items that crossed each edge', async ({ page }) => {
  await openFlow(page, FLOWS.words);
  await runButton(page).click();
  await waitForRun(page, 'done');

  await drawerTab(page, 'Taps');
  const edges = page.getByRole('listbox', { name: 'Edges' });
  await expect(edges).toBeVisible();
  await edges.getByRole('option').first().click();
  await expect(page.getByText('Last items')).toBeVisible();
  await shoot(page, 'run-taps');
});

test('runs from the command palette, and cancels from it', async ({ page }) => {
  await openFlow(page, FLOWS.slow);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('button', { name: 'Run this flow' }).click();
  await waitForRun(page, 'running', 20_000);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('button', { name: 'Cancel this run' }).click();
  await waitForRun(page, 'cancelled');
});

test('lists every run in the history, and opens one', async ({ page }) => {
  await page.goto('/runs');
  await expect(page.getByText('History', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: FLOWS.hello }).first()).toBeVisible();
  await shoot(page, 'runs-history');

  await page.getByRole('button', { name: FLOWS.hello }).first().click();
  await expect(page.getByRole('dialog', { name: /^Run \d+ · / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run it again' })).toBeVisible();
  await shoot(page, 'run-dialog');

  await page.getByRole('button', { name: 'Log' }).click();
  await shoot(page, 'run-dialog-log');
});

for (const theme of THEMES) {
  test(`the run overlay reads in the ${theme} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await openFlow(page, FLOWS.boom);
    await runButton(page).click();
    await waitForRun(page, 'failed');
    // A failed card, a selected card and a card with a problem have to stay apart.
    await page.getByText('check farm').first().click();
    await shoot(page, `run-states-${theme}`);
  });
}
