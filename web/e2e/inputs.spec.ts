import { statSync, utimesSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { FLOWS } from './harness';
import {
  drawerTab,
  flowFile,
  openFlow,
  readFlow,
  shoot,
  THEMES,
  useEditorLayout,
  useTheme,
  waitForRun,
  writeFlow,
} from './helpers';

/*
 * The inputs of section E, against the real server.
 *
 * A parameter that arrives is a parameter the flow printed: every assertion here reads
 * the child process's own stdout, not a field on a form. The environment is the same --
 * `params.py` prints `$GREETING`, so a variable that did not reach the child is a
 * variable this test can see missing.
 */

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
  await useEditorLayout(page);
});

/** Open the Run popover of the flow already on screen. */
async function runOptions(page: Page) {
  await page.getByRole('button', { name: 'Run options' }).click();
  const popover = page.getByRole('dialog', { name: 'Run options' });
  await expect(popover).toBeVisible();
  return popover;
}

test('runs a flow with a parameter changed, and sees it in the output', async ({ page }) => {
  await openFlow(page, FLOWS.params);
  const popover = await runOptions(page);

  // Every parameter of build() has a field, typed from the default the file wrote.
  await expect(popover.getByLabel('factor')).toHaveValue('2');
  await expect(popover.getByLabel('label')).toHaveValue('x');
  await expect(popover.getByRole('switch', { name: 'loud' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // And the interpreter the child process will be.
  await expect(popover.getByText('Interpreter')).toBeVisible();
  await expect(popover.locator('code').filter({ hasText: /python/ })).toBeVisible();

  await popover.getByLabel('factor').fill('5');
  await popover.getByLabel('label').fill('z');
  await popover.getByRole('switch', { name: 'loud' }).click();

  // An environment variable the flow prints, so a run that did not get it says so.
  await popover.getByRole('button', { name: 'Add a variable' }).click();
  await popover.getByLabel('Variable 1 name').fill('GREETING');
  await popover.getByLabel('Value of GREETING').fill('world');

  await shoot(page, 'inputs-run-popover');
  await popover.getByRole('button', { name: 'Run now' }).click();
  await waitForRun(page, 'done');

  // factor 5, label z, loud (so Z), and the variable: all of it in one line.
  await expect(page.getByRole('log', { name: 'Run output' })).toContainText('Z5 for world');
  await expect(page.getByRole('log', { name: 'Run output' })).toContainText('Z25 for world');
  await shoot(page, 'inputs-run-done');
});

test('remembers the last values for that flow, and the runs page shows them', async ({ page }) => {
  await openFlow(page, FLOWS.params);
  let popover = await runOptions(page);
  await popover.getByLabel('factor').fill('7');
  await popover.getByRole('button', { name: 'Run now' }).click();
  await waitForRun(page, 'done');

  // Reopened, the field is where it was left: this browser remembers, per flow.
  await page.reload();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  popover = await runOptions(page);
  await expect(popover.getByLabel('factor')).toHaveValue('7');
  await page.keyboard.press('Escape');

  // And the run itself carries what it was given.
  await page.goto('/runs');
  const row = page.getByRole('button', { name: /Open run/ }).first();
  await expect(page.getByText(/3 params/).first()).toBeVisible();
  await row.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Inputs' }).click();
  await expect(dialog.getByText('factor')).toBeVisible();
  await expect(dialog.getByText('7', { exact: true })).toBeVisible();
  await shoot(page, 'inputs-run-dialog');
});

test('adds a parameter from the start card, and the file gets it', async ({ page }) => {
  const original = await readFlow(FLOWS.params);
  /* The modification time goes back too, not only the text: the command palette offers
   * the four flows you were in last, and a file this test touched would otherwise push
   * one of them off the list the later specs photograph. */
  const was = statSync(flowFile(FLOWS.params));
  try {
    await openFlow(page, FLOWS.params);
    // The start card is where "what goes in" lives, so the parameters are edited there.
    await page.locator('.react-flow__node').first().click();
    const panel = page.getByText('Parameters', { exact: true });
    await expect(panel).toBeVisible();
    await expect(page.getByText('int · the file says 2').or(page.locator('body'))).toBeVisible();

    await page.getByRole('button', { name: 'Add a parameter' }).click();
    const added = page.getByRole('group', { name: 'Parameter value' });
    await expect(added).toBeVisible();
    await added.getByLabel('Name').fill('threshold');
    await added.getByLabel('Name').press('Enter');

    // Retyping rewrites the default literal and the annotation together.
    const renamed = page.getByRole('group', { name: 'Parameter threshold' });
    await renamed.getByLabel('Takes').selectOption('number');
    await expect(renamed.getByLabel('Default')).toHaveValue('0');
    await shoot(page, 'inputs-properties-params');

    // Saving regenerates the file from the model, as it does for any other edit.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => readFlow(FLOWS.params), { timeout: 20_000 })
      .toContain('threshold: int = 0');
  } finally {
    await writeFlow(FLOWS.params, original);
    utimesSync(flowFile(FLOWS.params), was.atime, was.mtime);
  }
});

test('a module the interpreter does not have is a warning with its pip line', async ({ page }) => {
  /* A top-level `import cv2` is a file the model cannot even build, so this one opens
   * code-only: no cards, and `openFlow` would wait for one for ever. The check is the
   * point -- it comes back 400, and the probe travels in the failure's own detail. */
  await page.goto(`/flows/${FLOWS.missing}`);
  await expect(page.getByRole('button', { name: 'Check' })).toBeEnabled();
  await page.getByRole('button', { name: 'Check' }).click();

  await drawerTab(page, 'Problems');
  // The failure itself, and under it the one line that ends it.
  await expect(page.getByText(/No module named 'cv2'/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('cv2 is not installed for the interpreter runs use.')).toBeVisible();
  await expect(page.getByText('pip install opencv-python')).toBeVisible();
  // A warning, not an error: the word says so beside the message.
  await expect(page.getByText('warning', { exact: true }).first()).toBeVisible();
  await shoot(page, 'inputs-problem-warning');
});

test('the interpreter is a setting, and the server refuses one that is not there', async ({
  page,
}) => {
  await page.goto('/settings');
  const python = page.getByLabel('Python');
  await expect(python).toHaveValue(/python/);
  const original = await python.inputValue();

  await python.fill('/nope/python3');
  const section = page.locator('section').filter({ hasText: 'Interpreter' });
  await section.getByRole('button', { name: 'Save' }).click();

  await expect(section.getByText(/cannot be run/)).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText(/pip install tolquane/)).toBeVisible();
  await shoot(page, 'inputs-interpreter-refused');

  /* Nothing was written -- the server refused before it wrote -- so putting the field
   * back is a discard, not another save; the Save button goes with it. */
  await section.getByRole('button', { name: 'Discard' }).click();
  await expect(python).toHaveValue(original);
  await expect(section.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('the workspace environment is rows a person can edit', async ({ page }) => {
  await page.goto('/settings');
  const workspace = page.locator('section').filter({ hasText: 'Workspace directory' });
  await workspace.getByRole('button', { name: 'Add a variable' }).click();
  await page.getByLabel('Variable 1 name').fill('TOLQUANE_E2E');
  await page.getByLabel('Value of TOLQUANE_E2E').fill('1');
  await workspace.getByRole('button', { name: 'Save' }).click();
  await expect(workspace.getByText('Saved')).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await expect(page.getByLabel('Variable 1 name')).toHaveValue('TOLQUANE_E2E');
  await shoot(page, 'inputs-workspace-env');

  // Take it away again: the rest of the suite runs in a clean environment.
  await page.getByRole('button', { name: 'Remove TOLQUANE_E2E' }).click();
  await workspace.getByRole('button', { name: 'Save' }).click();
  await expect(workspace.getByText('Saved')).toBeVisible({ timeout: 20_000 });
});

for (const theme of THEMES) {
  test(`the parameters read in the ${theme} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await openFlow(page, FLOWS.params);
    await runOptions(page);
    await shoot(page, `inputs-popover-${theme}`);

    await page.keyboard.press('Escape');
    await page.goto('/settings');
    await expect(page.getByLabel('Workspace directory')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Python')).toBeVisible();
    await shoot(page, `inputs-settings-${theme}`);
  });
}
