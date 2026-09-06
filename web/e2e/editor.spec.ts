import { expect, test } from '@playwright/test';
import { FLOWS } from './harness';
import { openFlow, readFlow, shoot, useEditorLayout, useTheme, writeFlow } from './helpers';

/*
 * The canvas editor, on the flows the suite seeded, through the real server.
 *
 * Nothing here saves: every test edits the canvas and leaves the file alone, so the
 * flows stay as the workspace wrote them. The two that do write put the file back.
 */

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
  await useEditorLayout(page);
});

test('draws a farm flow, with its worker inside the container', async ({ page }) => {
  await openFlow(page, FLOWS.words);
  await expect(page.getByText('words farm').first()).toBeVisible();
  await expect(page.getByText('tq.farm · 2 workers').first()).toBeVisible();
  // The farm is a container holding its emitter, its worker and its collector.
  await expect(page.getByText('emitter').first()).toBeVisible();
  await expect(page.getByText('collector').first()).toBeVisible();
  await shoot(page, 'canvas-word-count');
});

test('draws a feedback loop', async ({ page }) => {
  await openFlow(page, FLOWS.stuck);
  await expect(page.getByText('loop').first()).toBeVisible();
  await shoot(page, 'canvas-feedback');
});

test('selects a farm, changes its workers and undoes that', async ({ page }) => {
  await openFlow(page, FLOWS.words);
  await page.getByText('words farm').first().click();
  await expect(page.getByLabel('How many')).toHaveValue('2');
  await shoot(page, 'properties-farm');

  await page.getByLabel('How many').fill('8');
  await expect(page.getByText('tq.farm · 8 workers').first()).toBeVisible();
  await expect(page.getByText('unsaved changes')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByText('tq.farm · 2 workers').first()).toBeVisible();
});

test('shows the problems a bad option makes, on the card and in the drawer', async ({ page }) => {
  await openFlow(page, FLOWS.words);
  await page.getByText('words farm').first().click();
  await page.getByLabel('Collect policy').selectOption('gather');
  await expect(page.getByText("collect='gather' pairs with emit='scatter'").first()).toBeVisible();
  await page.getByRole('tab', { name: /Problems/ }).click();
  await shoot(page, 'problems');
  // The card wears the same problem: a danger line, not a repainted card.
  await expect(page.locator('[data-severity="error"]').first()).toBeVisible();
});

test('tidies the layout and fits the view', async ({ page }) => {
  await openFlow(page, FLOWS.nested);
  await page.getByRole('button', { name: 'Tidy up' }).click();
  await page.waitForTimeout(500);
  await shoot(page, 'canvas-tidy');
  await expect(page.getByText('layout moved')).toBeVisible();
});

test('shows the expanded graph, and the palette goes quiet there', async ({ page }) => {
  await openFlow(page, FLOWS.words);
  await page.getByRole('group', { name: 'Canvas layer' }).getByText('Threads').click();
  await expect(page.getByText('words.emitter').first()).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, 'canvas-threads');
  await expect(page.getByRole('button', { name: 'Farm' })).toHaveAttribute('aria-disabled', 'true');
});

test('opens a file it cannot model read-only', async ({ page }) => {
  await page.goto(`/flows/${FLOWS.codeOnly}`);
  await expect(page.getByText(/cannot be modelled/).first()).toBeVisible();
  await expect(page.getByText('Read-only flow')).toBeVisible();
  await page.waitForTimeout(500);
  await shoot(page, 'code-only-flow');
});

test('deletes the selected block with the keyboard, and undoes that', async ({ page }) => {
  await openFlow(page, FLOWS.hello);
  await page.getByText('double farm').first().click();
  await expect(page.getByLabel('How many')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.getByText('double farm')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByText('double farm').first()).toBeVisible();
});

test('adds a block from the palette', async ({ page }) => {
  await openFlow(page, FLOWS.hello);
  await page.getByRole('button', { name: 'Farm' }).click();
  await expect(page.getByText('work farm').first()).toBeVisible();
  await shoot(page, 'palette-added');
});

test('folds the palette, the drawer and the panel away, and remembers it', async ({ page }) => {
  await openFlow(page, FLOWS.words);

  await page.getByRole('button', { name: 'Fold the block palette' }).click();
  await expect(page.getByRole('button', { name: 'Unfold the block palette' })).toBeVisible();
  await page.getByRole('button', { name: 'Fold the run drawer' }).click();
  await expect(page.getByRole('log', { name: 'Run output' })).toBeHidden();
  await page.getByRole('button', { name: 'Hide the side panel' }).click();
  await expect(page.getByText('Nothing selected')).toBeHidden();

  // A second visit finds it the way it was left. It is a second tab rather than a
  // reload because this file plants a known layout on every navigation of `page`, and
  // the point here is what the browser remembered, not what the spec asked for.
  const second = await page.context().newPage();
  await second.goto(`/flows/${FLOWS.words}`);
  await expect(second.locator('.react-flow__node').first()).toBeVisible();
  await expect(second.getByRole('button', { name: 'Unfold the block palette' })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Show the side panel' })).toBeVisible();

  // A tab is a request to see it: clicking one unfolds the drawer again.
  await second.getByRole('tab', { name: /Console/ }).click();
  await expect(second.getByText(/Nothing printed yet/)).toBeVisible();
  await second.close();
});

test('checks the flow on the server, and says what it found', async ({ page }) => {
  await openFlow(page, FLOWS.hello);
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The flow is sound' })).toBeVisible();
});

test('says which line stopped the file parsing, and keeps the text', async ({ page }) => {
  const original = await readFlow(FLOWS.average);
  try {
    await openFlow(page, FLOWS.average);
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    const file = page.locator('[aria-label="Flow source"] .cm-content');
    await file.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(original.replace('def readings():', 'def readings()'));

    await expect(page.getByText('The canvas cannot show this file')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: /Go to line/ })).toBeVisible();
    await expect(file).toContainText('def readings()');
    await shoot(page, 'code-does-not-parse');
  } finally {
    await writeFlow(FLOWS.average, original);
  }
});
