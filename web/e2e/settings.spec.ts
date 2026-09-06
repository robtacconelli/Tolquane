import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';

/* The settings page against the contract of S4, answered by hand until the server lands. */

const OUT = 'e2e/screenshots';
const THEMES = ['dark', 'light'] as const;

test.use({ timezoneId: 'UTC' });

const SETTINGS = {
  workspace: '/home/me/flows',
  default_runtime: 'threads',
  default_batch: 32,
  exec_timeout: 30,
  max_concurrent_runs: 4,
  cancel_grace: 10,
  theme: 'dark',
  ai: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    has_anthropic_key: true,
    has_openai_key: false,
  },
  server: { host: '127.0.0.1', port: 8765, token_set: false },
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function server(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/health') {
      return json(route, {
        ok: true,
        version: '0.1.0',
        workspace: '/home/me/flows',
        runs_live: 0,
        scheduler: true,
      });
    }
    if (path === '/api/settings') {
      if (route.request().method() === 'PUT') {
        const patch = route.request().postDataJSON() as Record<string, unknown>;
        return json(route, { ...SETTINGS, ...patch, ai: SETTINGS.ai });
      }
      return json(route, SETTINGS);
    }
    return json(route, { ok: true });
  });
}

async function useTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    'tolquane.theme',
    theme,
  ] as const);
}

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
});

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await useTheme(page, theme);
      await server(page);
    });

    /* The scrolling element is the shell's main, not the document, so `fullPage` would
     * only ever show the first screen: the whole page needs a viewport its own size. */
    test.describe('at full height', () => {
      test.use({ viewport: { width: 1280, height: 2100 } });

      test('every section, as the server left it', async ({ page }) => {
        await page.goto('/settings');
        await expect(page.getByLabel('Workspace directory')).toHaveValue('/home/me/flows');
        await page.screenshot({ path: `${OUT}/${theme}-settings.png`, animations: 'disabled' });
      });

      test('an edit in flight and a number that is not one', async ({ page }) => {
        await page.goto('/settings');
        await page.getByLabel('Workspace directory').fill('/home/me/pipelines');
        await page.getByLabel('Concurrent runs').fill('99');
        await expect(page.getByText('Between 1 and 64.')).toBeVisible();
        await page.screenshot({
          path: `${OUT}/${theme}-settings-editing.png`,
          animations: 'disabled',
        });
      });
    });

    test('the top of the page at the viewport size', async ({ page }) => {
      await page.goto('/settings');
      await expect(page.getByLabel('Workspace directory')).toHaveValue('/home/me/flows');
      await page.screenshot({ path: `${OUT}/${theme}-settings-top.png`, animations: 'disabled' });
    });

    test('a section saved', async ({ page }) => {
      await page.goto('/settings');
      await page.getByLabel('Default batch').fill('64');
      await page
        .locator('section')
        .filter({ hasText: 'Default runtime' })
        .getByRole('button', { name: 'Save' })
        .click();
      await expect(page.getByText('Saved')).toBeVisible();
      await page.screenshot({ path: `${OUT}/${theme}-settings-saved.png`, animations: 'disabled' });
    });
  });
}
