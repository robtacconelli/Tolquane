import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/*
 * The Flows page against a real Tolquane server.
 *
 * Everything here is a file on disk -- creating, renaming and deleting a flow really
 * writes, moves and removes one -- so the workspace is a scratch directory and every
 * name this file makes starts with `e2e_`. Start the server first:
 *
 *   TOLQUANE_HOME=<scratch>/home .venv/bin/python -m tolquane web \
 *       --no-browser --port 8783 --workspace <scratch>/ws
 *
 * With no server on the port the tests skip rather than fail: the same page is covered
 * over a mocked fetch in `src/pages/FlowsPage.test.tsx`.
 */

const OUT = 'e2e/screenshots';
type Theme = 'dark' | 'light';
const SERVER = process.env.TOLQUANE_E2E_SERVER ?? 'http://127.0.0.1:8783';

let up = false;
let workspace = '';

test.beforeAll(async ({ request }) => {
  await mkdir(OUT, { recursive: true });
  try {
    const answer = await request.get(`${SERVER}/api/health`, { timeout: 3000 });
    up = answer.ok();
    if (up) workspace = ((await answer.json()) as { workspace: string }).workspace;
  } catch {
    up = false;
  }
});

test.beforeEach(() => {
  test.skip(!up, `no Tolquane server on ${SERVER}`);
});

async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    'tolquane.theme',
    theme,
  ] as const);
}

async function openFlows(page: Page): Promise<void> {
  await page.goto(`${SERVER}/flows`);
  await expect(page.getByRole('heading', { name: 'Flows', level: 2 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'hello' })).toBeVisible();
}

test.describe('the workspace list', () => {
  test('shows every flow with its folder, size and last run', async ({ page }) => {
    await useTheme(page, 'dark');
    await openFlows(page);

    for (const name of ['hello', 'word_count', 'som', 'moving_average', 'url_status']) {
      await expect(page.getByRole('link', { name })).toBeVisible();
    }
    // The subdirectory a flow lives in, and the workspace itself.
    await expect(page.getByText('reports/')).toBeVisible();
    await expect(page.getByText('Never run').first()).toBeVisible();
    await expect(page.getByTitle(workspace)).toBeVisible();
    await page.screenshot({ path: `${OUT}/dark-flows-list.png`, animations: 'disabled' });

    await useTheme(page, 'light');
    await openFlows(page);
    await page.screenshot({ path: `${OUT}/light-flows-list.png`, animations: 'disabled' });
  });

  test('filters the list', async ({ page }) => {
    await useTheme(page, 'dark');
    await openFlows(page);
    await page.getByLabel('Filter flows').fill('word');
    await expect(page.getByRole('link', { name: 'word_count' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'hello' })).toBeHidden();

    await page.getByLabel('Filter flows').fill('zzz');
    await expect(page.getByText(/No flow matches/)).toBeVisible();
  });

  test('opens a flow on the canvas', async ({ page }) => {
    await useTheme(page, 'dark');
    await openFlows(page);
    await page.getByRole('link', { name: 'word_count' }).click();
    await expect(page).toHaveURL(/\/flows\/word_count\.py$/);
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
  });

  test('makes a flow, renames it and deletes it', async ({ page }) => {
    await useTheme(page, 'dark');
    await openFlows(page);

    await page.getByRole('button', { name: 'New flow' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('e2e made here');
    await expect(dialog.getByText('e2e_made_here.py')).toBeVisible();
    await page.screenshot({ path: `${OUT}/dark-flows-new.png`, animations: 'disabled' });

    await dialog.getByRole('radio', { name: /Hello/ }).click();
    await dialog.getByRole('button', { name: 'Create flow' }).click();

    // The new file opens in the editor, with the template's blocks on the canvas.
    await expect(page).toHaveURL(/\/flows\/e2e_made_here\.py$/);
    await expect(page.locator('.react-flow__node').first()).toBeVisible();

    await openFlows(page);
    await expect(page.getByRole('link', { name: 'e2e_made_here' })).toBeVisible();

    await page.getByRole('button', { name: 'Rename e2e_made_here.py' }).click();
    const field = page.getByLabel('Path in the workspace');
    await field.fill('e2e_renamed.py');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByText('Renamed e2e_made_here.py to e2e_renamed.py.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'e2e_renamed' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete e2e_renamed.py' }).click();
    await expect(page.getByRole('dialog')).toContainText('Delete this flow?');
    await page.screenshot({ path: `${OUT}/dark-flows-delete.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'Delete flow' }).click();
    await expect(page.getByText('Deleted e2e_renamed.py.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'e2e_renamed' })).toBeHidden();
  });

  test('refuses a name the workspace already has', async ({ page }) => {
    await useTheme(page, 'dark');
    await openFlows(page);
    await page.getByRole('button', { name: 'New flow' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('hello');
    await expect(page.getByText('hello.py is already in the workspace.')).toBeVisible();
  });

  test('hands a described flow to the AI panel', async ({ page }) => {
    await useTheme(page, 'dark');
    await openFlows(page);

    await page.getByRole('button', { name: 'Build with AI' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('e2e described');
    await dialog
      .getByLabel('What should it do?')
      .fill('read urls.txt, fetch each with 8 workers, write the status to status.csv');
    await page.screenshot({ path: `${OUT}/dark-flows-describe.png`, animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Create and build' }).click();

    // The editor opens with the panel already asking, which without a key ends in the
    // server's own sentence about the key.
    await expect(page).toHaveURL(/\/flows\/e2e_described\.py$/);
    await expect(page.getByLabel('Ask the AI builder')).toBeVisible();
    await expect(
      page.getByText('read urls.txt, fetch each with 8 workers, write the status to status.csv'),
    ).toBeVisible();
    await expect(page.getByText(/ANTHROPIC_API_KEY/)).toBeVisible();

    // Clean up after the test, through the page itself.
    await openFlows(page);
    await page.getByRole('button', { name: 'Delete e2e_described.py' }).click();
    await page.getByRole('button', { name: 'Delete flow' }).click();
    await expect(page.getByText('Deleted e2e_described.py.')).toBeVisible();
  });
});
