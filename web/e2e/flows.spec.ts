import { rm } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { WS_DIR } from './harness';
import { flowFile, notice, shoot, useTheme } from './helpers';

/*
 * The workspace list, against the real server.
 *
 * Everything here is a file on disk -- creating, renaming and deleting a flow really
 * writes, moves and removes one -- so every name this file makes starts with `e2e_` and
 * is taken away again, and the seeded flows are only ever read.
 */

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
});

test.afterAll(async () => {
  for (const leftover of ['e2e_made_here.py', 'e2e_renamed.py', 'e2e_described.py']) {
    await rm(flowFile(leftover), { force: true });
  }
});

async function openFlows(page: Page): Promise<void> {
  await page.goto('/flows');
  await expect(page.getByRole('heading', { name: 'Flows', level: 2 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'hello' })).toBeVisible();
}

test('shows every flow with its folder, size and last run', async ({ page }) => {
  await openFlows(page);

  for (const name of ['hello', 'word_count', 'slow', 'moving_average', 'word_frequency']) {
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  }
  // The folder a flow lives in, and the workspace this server was started on.
  await expect(page.getByText('reports/')).toBeVisible();
  await expect(page.getByTitle(WS_DIR)).toBeVisible();
  await shoot(page, 'flows-list');
});

test('filters the list, and says so when nothing matches', async ({ page }) => {
  await openFlows(page);
  await page.getByLabel('Filter flows').fill('word');
  await expect(page.getByRole('link', { name: 'word_count' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'hello' })).toBeHidden();

  await page.getByLabel('Filter flows').fill('zzz');
  await expect(page.getByText(/No flow matches/)).toBeVisible();
});

test('opens a flow on the canvas', async ({ page }) => {
  await openFlows(page);
  await page.getByRole('link', { name: 'word_count' }).click();
  await expect(page).toHaveURL(/\/flows\/word_count\.py$/);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
});

test('makes a flow, renames it and deletes it', async ({ page }) => {
  await openFlows(page);

  await page.getByRole('button', { name: 'New flow' }).click();
  const dialog = page.getByRole('dialog', { name: 'New flow' });
  await dialog.getByLabel('Name').fill('e2e made here');
  await expect(dialog.getByText('e2e_made_here.py')).toBeVisible();
  await shoot(page, 'flows-new');

  await dialog.getByRole('radio', { name: /Hello/ }).click();
  await dialog.getByRole('button', { name: 'Create flow' }).click();

  // The new file opens in the editor, with the template's blocks on the canvas.
  await expect(page).toHaveURL(/\/flows\/e2e_made_here\.py$/);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();

  await openFlows(page);
  await expect(page.getByRole('link', { name: 'e2e_made_here' })).toBeVisible();

  await page.getByRole('button', { name: 'Rename e2e_made_here.py' }).click();
  await page.getByLabel('Path in the workspace').fill('e2e_renamed.py');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(notice(page, 'Renamed e2e_made_here.py to e2e_renamed.py.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'e2e_renamed' })).toBeVisible();

  await page.getByRole('button', { name: 'Delete e2e_renamed.py' }).click();
  await expect(page.getByRole('dialog')).toContainText('Delete this flow?');
  await shoot(page, 'flows-delete');
  await page.getByRole('button', { name: 'Delete flow' }).click();
  await expect(notice(page, 'Deleted e2e_renamed.py.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'e2e_renamed' })).toBeHidden();
});

test('refuses a name the workspace already has', async ({ page }) => {
  await openFlows(page);
  await page.getByRole('button', { name: 'New flow' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('hello');
  await expect(page.getByText('hello.py is already in the workspace.')).toBeVisible();
});

test('hands a described flow to the AI panel, which says which key is missing', async ({
  page,
}) => {
  await openFlows(page);

  await page.getByRole('button', { name: 'Build with AI' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('e2e described');
  await dialog
    .getByLabel('What should it do?')
    .fill('read urls.txt, fetch each with 8 workers, write the status to status.csv');
  await shoot(page, 'flows-describe');
  await dialog.getByRole('button', { name: 'Create and build' }).click();

  // The editor opens with the panel already asking, which without a key ends in the
  // server's own sentence about the key.
  await expect(page).toHaveURL(/\/flows\/e2e_described\.py$/);
  await expect(page.getByLabel('Ask the AI builder')).toBeVisible();
  await expect(
    page.getByText('read urls.txt, fetch each with 8 workers, write the status to status.csv'),
  ).toBeVisible();
  await expect(page.getByText(/ANTHROPIC_API_KEY/)).toBeVisible();
  await shoot(page, 'ai-no-key');

  // Clean up after the test, through the page itself.
  await openFlows(page);
  await page.getByRole('button', { name: 'Delete e2e_described.py' }).click();
  await page.getByRole('button', { name: 'Delete flow' }).click();
  await expect(notice(page, 'Deleted e2e_described.py.')).toBeVisible();
});
