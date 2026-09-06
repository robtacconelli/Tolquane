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
 * The code view against the real server: text in, model out, code back, file on disk.
 *
 * This is the round trip the whole design rests on -- the Python file is the artifact and
 * the canvas is a view of it -- so nothing here is mocked. `word_count.py` is put back
 * the way it was found after every test.
 */

/* Two editors can be on screen at once, so each is addressed by what it is editing. */
const FILE = '[aria-label="Flow source"] .cm-content';
const body = (id: string): string => `[aria-label="Body of ${id}"] .cm-content`;
const card = (title: string): string => `[title="${title}"]`;
const FLOW = FLOWS.words;

let original = '';

test.beforeAll(async () => {
  original = await readFlow(FLOW);
});

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
  await useEditorLayout(page);
});

test.afterEach(async () => {
  await writeFlow(FLOW, original);
});

async function showCode(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page.locator(FILE)).toBeVisible();
}

async function showCanvas(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
}

/** Replace the whole file the way a person would: select everything, then type. */
async function rewrite(page: Page, text: string): Promise<void> {
  await page.locator(FILE).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

test('parses what is typed and moves the canvas with it', async ({ page }) => {
  await openFlow(page, FLOW);
  await showCode(page);
  await expect(page.getByText('Canvas in sync')).toBeVisible();
  await showCanvas(page);
  await expect(page.getByText('tq.farm · 2 workers')).toBeVisible();

  await showCode(page);
  await rewrite(page, original.replace('tq.farm(words, 2)', 'tq.farm(words, 4)'));
  await showCanvas(page);
  await expect(page.getByText('tq.farm · 4 workers')).toBeVisible({ timeout: 20_000 });
});

test('saves the text that was typed, exactly', async ({ page }) => {
  await openFlow(page, FLOW);
  await showCode(page);
  await rewrite(page, original.replace('tq.farm(words, 2)', 'tq.farm(words, 4)'));
  await page.keyboard.press('ControlOrMeta+s');
  await expect(notice(page, 'Saved')).toBeVisible();

  const written = await readFlow(FLOW);
  expect(written).toBe(original.replace('tq.farm(words, 2)', 'tq.farm(words, 4)'));
});

test('finds text in the file', async ({ page }) => {
  await openFlow(page, FLOW);
  await showCode(page);
  await page.locator(FILE).click();
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('textbox', { name: 'Find in this file' });
  await expect(find).toBeFocused();
  await find.fill('farm');
  await expect(page.locator('.cm-searchMatch').first()).toBeVisible();
  await expect(page.getByText('1 of 3')).toBeVisible();
  await shoot(page, 'code-search');
  await page.keyboard.press('Escape');
  await expect(find).toBeHidden();
});

test('writes a node body from the property panel into the file', async ({ page }) => {
  await openFlow(page, FLOW);
  await page.locator(card('words')).click();
  const editor = page.locator(body('words'));
  await expect(editor).toContainText('yield w.lower()');
  await shoot(page, 'code-panel');

  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('@tq.node\ndef words(line: str):\n    yield line.upper()\n');

  await showCode(page);
  await expect(page.locator(FILE)).toContainText('yield line.upper()', { timeout: 20_000 });
});

test('offers the difference when the file changed on disk, and keeps mine', async ({ page }) => {
  await openFlow(page, FLOW);
  await showCode(page);
  await rewrite(page, original.replace('tq.farm(words, 2)', 'tq.farm(words, 6)'));
  await writeFlow(FLOW, `${original}\n# somebody else was here\n`);
  await page.keyboard.press('ControlOrMeta+s');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('This file changed on disk')).toBeVisible();
  await expect(dialog.getByText('# somebody else was here')).toBeVisible();
  await expect(dialog.getByText('tq.farm(words, 6)')).toBeVisible();
  await shoot(page, 'code-diff');

  await dialog.getByRole('button', { name: 'Keep mine' }).click();
  await expect(dialog).toBeHidden();
  expect(await readFlow(FLOW)).toContain('tq.farm(words, 6)');
});

test('takes the version on disk when asked', async ({ page }) => {
  await openFlow(page, FLOW);
  await showCode(page);
  await rewrite(page, original.replace('tq.farm(words, 2)', 'tq.farm(words, 7)'));
  await writeFlow(FLOW, `${original}\n# theirs won\n`);
  await page.keyboard.press('ControlOrMeta+s');
  await page.getByRole('dialog').getByRole('button', { name: 'Take theirs' }).click();

  await expect(page.locator(FILE)).toContainText('# theirs won');
  expect(await readFlow(FLOW)).toContain('# theirs won');
});

for (const theme of THEMES) {
  test(`the code view reads in the ${theme} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await openFlow(page, FLOW);
    await showCode(page);
    await expect(page.getByText('Canvas in sync')).toBeVisible();
    // Clicking lands the cursor where the pointer was, which on a long first line means
    // a file scrolled sideways; the top of the file is what this shot is of.
    await page.locator(FILE).click();
    await page.keyboard.press('ControlOrMeta+Home');
    await shoot(page, `code-view-${theme}`);
  });
}
