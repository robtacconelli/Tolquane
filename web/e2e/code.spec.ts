import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/*
 * The code view against the real server.
 *
 * Unlike the other journeys this one does not mock `/api`: a running `tolquane web` on
 * TOLQUANE_API_PORT holds the workspace, so the round trip that matters here -- text in,
 * model out, code back, file on disk -- is the real one. The spec puts `word_count.py`
 * back the way it found it after every test.
 */

const OUT = 'e2e/screenshots';
/* Two editors can be on screen at once, so each is addressed by what it is editing. */
const FILE = '[aria-label="Flow source"] .cm-content';
const body = (id: string): string => `[aria-label="Body of ${id}"] .cm-content`;
/** A block card on the canvas, by the title it carries. */
const card = (title: string): string => `[title="${title}"]`;
const FLOW = 'word_count.py';
const THEMES = ['dark', 'light'] as const;

let workspace = '';
let original = '';
/** False when nothing is answering `/api`: then the journey skips instead of failing. */
let serving = false;
/** True when the flow had to be put in the workspace, so it can be taken out again. */
let borrowed = false;

function file(): string {
  return join(workspace, FLOW);
}

test.beforeAll(async ({ request }) => {
  await mkdir(OUT, { recursive: true });
  try {
    const health = await request.get('/api/health');
    if (!health.ok()) return;
    workspace = ((await health.json()) as { workspace: string }).workspace;
  } catch {
    return;
  }
  const example = join('..', 'examples', FLOW);
  original = await readFile(example, 'utf8');
  const inWorkspace = await readFile(file(), 'utf8').catch(() => null);
  if (inWorkspace === null) borrowed = true;
  else original = inWorkspace;
  await writeFile(file(), original, 'utf8');
  serving = true;
});

test.beforeEach(() => {
  test.skip(!serving, 'this journey needs a real tolquane web server behind /api');
});

test.afterEach(async () => {
  if (serving) await writeFile(file(), original, 'utf8');
});

test.afterAll(async () => {
  if (serving && borrowed) await rm(file(), { force: true });
});

async function useTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    'tolquane.theme',
    theme,
  ] as const);
}

async function openFlow(page: Page): Promise<void> {
  await page.goto(`/flows/${FLOW}`);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
}

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

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
}

test.describe('the code view', () => {
  test('parses what is typed and moves the canvas with it', async ({ page }) => {
    await openFlow(page);
    await showCode(page);
    await expect(page.getByText('Canvas in sync')).toBeVisible();
    // The editor only renders the lines in view, so the file itself is read on the canvas.
    await showCanvas(page);
    await expect(page.getByText('tq.farm · 2 workers')).toBeVisible();

    await showCode(page);
    await rewrite(page, original.replace('tq.farm(words, 2)', 'tq.farm(words, 4)'));
    await showCanvas(page);
    await expect(page.getByText('tq.farm · 4 workers')).toBeVisible({ timeout: 20_000 });
  });

  test('saves the text that was typed, exactly', async ({ page }) => {
    await openFlow(page);
    await showCode(page);
    await rewrite(page, original.replace('tq.farm(words, 2)', 'tq.farm(words, 4)'));
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByText('Saved')).toBeVisible();

    const written = await readFile(file(), 'utf8');
    expect(written).toContain('tq.farm(words, 4)');
    expect(written).toBe(original.replace('tq.farm(words, 2)', 'tq.farm(words, 4)'));
  });

  test('keeps the text when it stops parsing, and says which line', async ({ page }) => {
    await openFlow(page);
    await showCode(page);
    const broken = original.replace('def words(line: str):', 'def words(line: str)');
    await rewrite(page, broken);

    await expect(page.getByText('The canvas cannot show this file')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/the file does not parse/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Go to line/ })).toBeVisible();
    await expect(page.locator(FILE)).toContainText('def words(line: str)');
    await expect(page.getByText('Canvas read-only')).toBeVisible();
  });

  test('finds text in the file', async ({ page }) => {
    await openFlow(page);
    await showCode(page);
    await page.locator(FILE).click();
    await page.keyboard.press('ControlOrMeta+f');
    const find = page.getByRole('textbox', { name: 'Find in this file' });
    await expect(find).toBeFocused();
    await find.fill('farm');
    await expect(page.locator('.cm-searchMatch').first()).toBeVisible();
    await expect(page.getByText('1 of 3')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(find).toBeHidden();
  });

  test('writes a node body from the property panel into the file', async ({ page }) => {
    await openFlow(page);
    await page.locator(card('words')).click();
    const editor = page.locator(body('words'));
    await expect(editor).toContainText('yield w.lower()');

    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('@tq.node\ndef words(line: str):\n    yield line.upper()\n');

    await showCode(page);
    await expect(page.locator(FILE)).toContainText('yield line.upper()', { timeout: 20_000 });
  });

  test('offers the difference when the file changed on disk', async ({ page }) => {
    await openFlow(page);
    await showCode(page);
    await rewrite(page, original.replace('tq.farm(words, 2)', 'tq.farm(words, 6)'));
    await writeFile(file(), `${original}\n# somebody else was here\n`, 'utf8');
    await page.keyboard.press('ControlOrMeta+s');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('This file changed on disk')).toBeVisible();
    await expect(dialog.getByText('# somebody else was here')).toBeVisible();
    await expect(dialog.getByText('tq.farm(words, 6)')).toBeVisible();

    await dialog.getByRole('button', { name: 'Keep mine' }).click();
    await expect(dialog).toBeHidden();
    expect(await readFile(file(), 'utf8')).toContain('tq.farm(words, 6)');
  });

  test('takes the version on disk when asked', async ({ page }) => {
    await openFlow(page);
    await showCode(page);
    await rewrite(page, original.replace('tq.farm(words, 2)', 'tq.farm(words, 7)'));
    await writeFile(file(), `${original}\n# theirs won\n`, 'utf8');
    await page.keyboard.press('ControlOrMeta+s');
    await page.getByRole('dialog').getByRole('button', { name: 'Take theirs' }).click();

    await expect(page.locator(FILE)).toContainText('# theirs won');
    expect(await readFile(file(), 'utf8')).toContain('# theirs won');
  });
});

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await useTheme(page, theme);
    });

    test('the code view', async ({ page }) => {
      await openFlow(page);
      await showCode(page);
      await expect(page.getByText('Canvas in sync')).toBeVisible();
      await page.locator(FILE).click();
      await shoot(page, `code-view-${theme}`);

      await page.keyboard.press('ControlOrMeta+f');
      await page.getByRole('textbox', { name: 'Find in this file' }).fill('farm');
      await expect(page.locator('.cm-searchMatch').first()).toBeVisible();
      await shoot(page, `code-search-${theme}`);
    });

    test('the body editor in the panel', async ({ page }) => {
      await openFlow(page);
      await page.locator(card('Count')).click();
      await expect(page.locator(body('Count'))).toContainText('class Count');
      await shoot(page, `code-panel-${theme}`);
    });

    test('a file that stopped parsing', async ({ page }) => {
      await openFlow(page);
      await showCode(page);
      await rewrite(page, original.replace('def words(line: str):', 'def words(line: str)'));
      await expect(page.getByText('The canvas cannot show this file')).toBeVisible({
        timeout: 15_000,
      });
      await shoot(page, `code-only-${theme}`);
    });

    test('the difference dialog', async ({ page }) => {
      await openFlow(page);
      await showCode(page);
      await rewrite(page, original.replace('tq.farm(words, 2)', 'tq.farm(words, 8)'));
      await writeFile(file(), original.replace('tq.farm(Count, 3', 'tq.farm(Count, 5'), 'utf8');
      await page.keyboard.press('ControlOrMeta+s');
      await expect(page.getByRole('dialog')).toBeVisible();
      await shoot(page, `code-diff-${theme}`);
    });
  });
}
