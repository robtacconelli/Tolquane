import { mkdir, readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/*
 * The canvas editor, against the fixture flows.
 *
 * There is no server in this run, so the flow routes are answered from the same JSON the
 * unit tests use (made with `python -m tolquane.web.model parse`). That is the whole
 * contract the editor has with S4, so the page is exercised through its real load path.
 */

const OUT = 'e2e/screenshots';
const THEMES = ['dark', 'light'] as const;

const FIXTURES: Record<string, string> = {
  'hello.py': 'hello.json',
  'word_count.py': 'word_count.json',
  'showcase.py': 'showcase.json',
  'newton_sqrt_feedback/flow.py': 'newton.json',
  'word_frequency/flow.py': 'word_frequency.json',
  'url_status_report/flow.py': 'url_status.json',
  'som.py': 'som.json',
};

async function fixture(name: string): Promise<string> {
  return readFile(`src/test/fixtures/${FIXTURES[name] ?? 'hello.json'}`, 'utf8');
}

async function serveFixtures(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname.replace(/^\/api\//, ''));
    if (path === 'health') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, version: '0.1.0', workspace: '/workspace' }),
      });
      return;
    }
    if (path.startsWith('flows/') && path.endsWith('/check')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, nodes: 8, edges: 9 }),
      });
      return;
    }
    if (path.startsWith('flows/')) {
      const flow = path.slice('flows/'.length);
      if (FIXTURES[flow]) {
        await route.fulfill({ contentType: 'application/json', body: await fixture(flow) });
        return;
      }
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

async function useTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    'tolquane.theme',
    theme,
  ] as const);
}

async function openFlow(page: Page, flow: string): Promise<void> {
  await page.goto(`/flows/${flow}`);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.waitForTimeout(250); // the fit-view transition
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
}

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
});

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await serveFixtures(page);
      await useTheme(page, theme);
    });

    test('draws a farm flow', async ({ page }) => {
      await openFlow(page, 'word_count.py');
      await expect(page.getByText('words farm').first()).toBeVisible();
      await expect(page.getByText('tq.farm · 2 workers').first()).toBeVisible();
      await shoot(page, `${theme}-canvas-word-count`);
    });

    test('draws every block kind', async ({ page }) => {
      await openFlow(page, 'showcase.py');
      await expect(page.getByText('all-to-all').first()).toBeVisible();
      await expect(page.getByText('newton').first()).toBeVisible();
      await shoot(page, `${theme}-canvas-showcase`);

      // The whole thing at once, on the wide screen this flow needs.
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.getByRole('button', { name: 'Fit', exact: true }).click();
      await page.waitForTimeout(400);
      await shoot(page, `${theme}-canvas-showcase-whole`);
    });

    test('draws a feedback loop', async ({ page }) => {
      await openFlow(page, 'newton_sqrt_feedback/flow.py');
      await expect(page.getByText('loop').first()).toBeVisible();
      await shoot(page, `${theme}-canvas-feedback`);
    });

    test('selects a farm, changes its workers and undoes that', async ({ page }) => {
      await openFlow(page, 'word_count.py');
      await page.getByText('words farm').first().click();
      await expect(page.getByLabel('How many')).toHaveValue('2');
      await shoot(page, `${theme}-properties-farm`);

      await page.getByLabel('How many').fill('8');
      await expect(page.getByText('tq.farm · 8 workers').first()).toBeVisible();
      await expect(page.getByText('unsaved changes')).toBeVisible();
      await shoot(page, `${theme}-properties-workers`);

      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.getByText('tq.farm · 2 workers').first()).toBeVisible();
    });

    test('shows the problems a bad option makes, on the card and in the drawer', async ({
      page,
    }) => {
      await openFlow(page, 'word_count.py');
      await page.getByText('words farm').first().click();
      await page.getByLabel('Collect policy').selectOption('gather');
      await expect(
        page.getByText("collect='gather' pairs with emit='scatter'").first(),
      ).toBeVisible();
      await page.getByRole('tab', { name: /Problems/ }).click();
      await shoot(page, `${theme}-problems`);
    });

    test('tidies the layout and fits the view', async ({ page }) => {
      await openFlow(page, 'word_frequency/flow.py');
      await page.getByRole('button', { name: 'Tidy up' }).click();
      await page.waitForTimeout(400);
      await shoot(page, `${theme}-canvas-tidy`);
    });

    test('shows the expanded graph', async ({ page }) => {
      await openFlow(page, 'word_count.py');
      await page.getByRole('group', { name: 'Canvas layer' }).getByText('Threads').click();
      await expect(page.getByText('words.emitter').first()).toBeVisible();
      await page.waitForTimeout(300);
      await shoot(page, `${theme}-canvas-threads`);
    });

    test('opens a file it cannot model read-only', async ({ page }) => {
      await page.goto('/flows/som.py');
      await expect(page.getByText(/cannot be modelled/).first()).toBeVisible();
      await page.waitForTimeout(400);
      await shoot(page, `${theme}-code-only`);
    });

    test('shows the source in the code view', async ({ page }) => {
      await openFlow(page, 'hello.py');
      await page.getByRole('group', { name: 'Editor view' }).getByText('Code').click();
      await expect(page.getByText('def main() -> None:')).toBeVisible();
      await shoot(page, `${theme}-code`);
    });

    test('deletes the selected block with the keyboard, and undoes that', async ({ page }) => {
      await openFlow(page, 'hello.py');
      await page.getByText('double farm').first().click();
      await expect(page.getByLabel('How many')).toBeVisible();
      await page.keyboard.press('Delete');
      await expect(page.getByText('double farm')).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.getByText('double farm').first()).toBeVisible();
    });

    test('adds a block from the palette', async ({ page }) => {
      await openFlow(page, 'hello.py');
      await page.getByRole('button', { name: /Farm/ }).click();
      await expect(page.getByText('work farm').first()).toBeVisible();
      await shoot(page, `${theme}-palette-added`);
    });
  });
}
