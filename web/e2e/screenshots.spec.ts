import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const OUT = 'e2e/screenshots';

const ROUTES = [
  { name: 'flows', path: '/flows', marker: 'No flows yet' },
  { name: 'editor', path: '/flows/reports/word_count.py', marker: 'Properties' },
  { name: 'runs', path: '/runs', marker: 'Nothing has run yet' },
  { name: 'schedules', path: '/schedules', marker: 'Scheduled flows' },
  { name: 'settings', path: '/settings', marker: 'Appearance' },
] as const;

const THEMES = ['dark', 'light'] as const;

/** The theme is read from localStorage before the first paint, as in index.html. */
async function useTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    'tolquane.theme',
    theme,
  ] as const);
}

/**
 * There is no server in this run, and the preview server would answer /api with its own
 * SPA fallback. Failing the calls outright is what a stopped server actually looks like
 * to the client, and it makes the offline banner appear at once.
 */
async function withoutServer(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
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
      await withoutServer(page);
      await useTheme(page, theme);
    });

    for (const route of ROUTES) {
      test(`${route.name} looks right`, async ({ page }) => {
        await page.goto(route.path);
        await expect(page.getByText(route.marker).first()).toBeVisible();
        // Wait for the banner so every shot is taken in the same, settled state.
        await expect(page.getByRole('status')).toBeVisible();
        await shoot(page, `${theme}-${route.name}`);
      });
    }

    test('command palette looks right', async ({ page }) => {
      await page.goto('/flows');
      await expect(page.getByRole('status')).toBeVisible();
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      await shoot(page, `${theme}-palette`);
    });

    test('collapsed sidebar looks right', async ({ page }) => {
      await page.goto('/flows');
      await expect(page.getByRole('status')).toBeVisible();
      await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
      await expect(page.getByRole('link', { name: 'Runs' })).toBeVisible();
      await shoot(page, `${theme}-collapsed`);
    });
  });
}
