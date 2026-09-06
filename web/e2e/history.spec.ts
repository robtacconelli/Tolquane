import { expect, test, type Page } from '@playwright/test';
import { FLOWS } from './harness';
import {
  notice,
  openFlow,
  readFlow,
  shoot,
  THEMES,
  useEditorLayout,
  useTheme,
  writeFlow,
} from './helpers';

/*
 * The History tab against the real server and a real repository.
 *
 * `seedRepository` in harness.ts made the workspace a git repository with one commit, so
 * everything here is git doing its own work: the entries come from `git log`, the version
 * from `git show`, the commit from `git commit`, and the restore writes the old text back
 * over the file. Nothing is mocked.
 *
 * `hello.py` is the flow used throughout, and it is put back the way it was found; the
 * commits the journey makes stay in the repository, which is thrown away with the
 * workspace on the next run.
 */

const FLOW = FLOWS.hello;
const SEEDED = 'The flows this suite starts from';

let original = '';

test.beforeAll(async () => {
  original = await readFlow(FLOW);
});

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
  await useEditorLayout(page);
});

test.afterAll(async () => {
  await writeFlow(FLOW, original);
});

/** The panel itself, by the name it carries; the toolbar button opens it. */
function panel(page: Page) {
  return page.locator('[aria-label="History"]');
}

async function openHistory(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'History', exact: true }).first().click();
  await expect(panel(page)).toBeVisible();
}

test("lists the workspace repository's commits, with the head marked", async ({ page }) => {
  await openFlow(page, FLOW);
  await openHistory(page);

  const seeded = panel(page).getByRole('button', { name: new RegExp(SEEDED) });
  await expect(seeded).toBeVisible();
  await expect(seeded.getByText('head')).toBeVisible();
  // The author is the identity the harness committed with, not a git default.
  await expect(seeded.getByText('Tolquane e2e')).toBeVisible();
});

test.describe.serial('saving with a message, and coming back', () => {
  test('adds a version, named by the person who saved it', async ({ page }) => {
    await openFlow(page, FLOW);

    /* An edit the canvas can show, so the restore below is visible as well as readable.
     * It is made before the tab is opened: the properties and the history are the same
     * column, and only one of them is in it at a time. */
    await page.getByText('double farm').first().click();
    await page.getByLabel('How many').fill('8');
    await expect(page.getByText('tq.farm · 8 workers').first()).toBeVisible();

    await openHistory(page);
    await page.keyboard.press('ControlOrMeta+Shift+S');
    const dialog = page.getByRole('dialog', { name: 'Save with a message' });
    await dialog.getByLabel('Commit message').fill('Eight workers for hello');
    await dialog.getByRole('button', { name: 'Save and commit' }).click();

    /* The save generates the file in a child process before it writes and commits it, so
     * it is given room: on a loaded machine that is several seconds, and the notice takes
     * itself away four seconds after it appears. */
    await expect(notice(page, /Saved and committed as [0-9a-f]{7}/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      panel(page).getByRole('button', { name: /Eight workers for hello/ }),
    ).toBeVisible();
    // The commit took the change with it, so there is nothing uncommitted left.
    await expect(panel(page).getByText('Uncommitted changes')).toHaveCount(0);
    // The generator writes the workers positionally, and the file it wrote is committed.
    expect(await readFlow(FLOW)).toContain('tq.farm(double, 8, ordered=True)');
  });

  test('shows an old version and puts the file back to it', async ({ page }) => {
    await openFlow(page, FLOW);
    await openHistory(page);

    await panel(page)
      .getByRole('button', { name: new RegExp(SEEDED) })
      .click();
    const diff = panel(page).getByRole('table', { name: /Difference between/ });
    await expect(diff).toBeVisible();
    await expect(diff.getByText(/workers=4/)).toBeVisible();
    await expect(diff.getByText(/tq\.farm\(double, 8/)).toBeVisible();

    await panel(page).getByRole('button', { name: 'Restore this version' }).click();
    const confirm = page.getByRole('dialog', { name: 'Restore this version?' });
    await confirm.getByRole('button', { name: 'Restore', exact: true }).click();

    // The file on disk is the old one again, and it is not committed.
    await expect(panel(page).getByText(/Restored from [0-9a-f]{7}/)).toBeVisible();
    await expect(panel(page).getByText('Uncommitted changes')).toBeVisible();
    expect(await readFlow(FLOW)).toContain('workers=4');

    // And the canvas is looking at the flow that came back, not the one that was open.
    await expect(page.getByText('tq.farm · 4 workers').first()).toBeVisible();
    await expect(page.getByText('unsaved changes')).toHaveCount(0);
  });
});

/*
 * The gallery. It writes its own uncommitted change to the file first, so the two shots
 * show the tab with something to say: a file that differs from the last commit, and that
 * difference. The file is put back afterwards.
 */
test.describe('the gallery', () => {
  test.afterEach(async () => {
    await writeFlow(FLOW, original);
  });

  for (const theme of THEMES) {
    test(`the tab and a version, ${theme}`, async ({ page }) => {
      await writeFlow(FLOW, original.replace('workers=4', 'workers=6'));
      await useTheme(page, theme);
      await openFlow(page, FLOW);
      await openHistory(page);

      await expect(panel(page).getByText('Uncommitted changes')).toBeVisible();
      await shoot(page, `history-entries-${theme}`);

      await panel(page)
        .getByRole('button', { name: new RegExp(SEEDED) })
        .click();
      await expect(panel(page).getByRole('table', { name: /Difference between/ })).toBeVisible();
      await shoot(page, `history-diff-${theme}`);
    });
  }
});
