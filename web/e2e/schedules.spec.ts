import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';

/* The server of S4 does not exist yet, so this spec is the contract answered by hand.
 * Everything the schedules page can show has a shot here, in both themes. */

const OUT = 'e2e/screenshots';
const THEMES = ['dark', 'light'] as const;

// Fixed zone and times relative to the run, so the shots read the same wherever they run.
test.use({ timezoneId: 'UTC' });

function at(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const FLOWS = {
  workspace: '/home/me/flows',
  flows: [
    {
      path: 'hello.py',
      name: 'hello',
      modified: at(-4000),
      size: 480,
      has_layout: true,
      last_run: null,
    },
    {
      path: 'reports/word_count.py',
      name: 'word_count',
      modified: at(-900),
      size: 1240,
      has_layout: true,
      last_run: { id: 12, status: 'done', ended: at(-30) },
    },
    {
      path: 'nightly_etl.py',
      name: 'nightly_etl',
      modified: at(-8000),
      size: 2100,
      has_layout: false,
      last_run: null,
    },
  ],
};

const SCHEDULES = [
  {
    id: 1,
    flow: 'reports/word_count.py',
    cron: '*/15 * * * *',
    sample: null,
    runtime: 'threads',
    enabled: true,
    created: at(-9000),
    last_run: 12,
    last_status: 'done',
    next_run: at(11),
    description: 'every 15 minutes',
    next_five: [at(11), at(26), at(41), at(56), at(71)],
  },
  {
    id: 2,
    flow: 'nightly_etl.py',
    cron: '0 2 * * *',
    sample: 'yesterday',
    runtime: 'processes',
    enabled: true,
    created: at(-20000),
    last_run: 9,
    last_status: 'failed',
    next_run: at(600),
    description: 'at 2:00 every day',
    next_five: [at(600), at(2040), at(3480), at(4920), at(6360)],
  },
  {
    id: 3,
    flow: 'hello.py',
    cron: '0 9 * * 1-5',
    sample: null,
    runtime: 'threads',
    enabled: false,
    created: at(-40000),
    last_run: null,
    last_status: null,
    next_run: null,
    description: 'at 9:00, Monday to Friday',
    next_five: [],
  },
];

const DESCRIPTIONS: Record<string, string> = {
  '*/5 * * * *': 'every 5 minutes',
  '0 * * * *': 'every hour, on the hour',
  '0 9 * * 1-5': 'at 9:00, Monday to Friday',
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function server(page: Page, schedules: unknown[]): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/health') {
      return json(route, {
        ok: true,
        version: '0.1.0',
        workspace: '/home/me/flows',
        runs_live: 0,
        scheduler: true,
      });
    }
    if (path === '/api/flows') return json(route, FLOWS);
    if (path === '/api/schedules' && method === 'GET') return json(route, { schedules });
    if (/^\/api\/schedules\/\d+\/run$/.test(path)) {
      return json(route, { id: 31, flow: 'reports/word_count.py', status: 'running' });
    }
    if (path === '/api/schedules/preview') {
      const cron = (route.request().postDataJSON() as { cron?: string }).cron ?? '';
      if (cron.startsWith('99')) {
        return json(
          route,
          { error: { type: 'ValueError', message: `minute field out of range: ${cron}` } },
          400,
        );
      }
      return json(route, {
        description: DESCRIPTIONS[cron] ?? `on ${cron}`,
        next_five: [at(3), at(8), at(13), at(18), at(23)],
      });
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
    });

    test('the list of schedules', async ({ page }) => {
      await server(page, SCHEDULES);
      await page.goto('/schedules');
      await expect(page.getByText('every 15 minutes')).toBeVisible();
      await expect(page.getByText('Paused')).toBeVisible();
      await page.screenshot({ path: `${OUT}/${theme}-schedules-list.png`, animations: 'disabled' });
    });

    test('the empty state', async ({ page }) => {
      await server(page, []);
      await page.goto('/schedules');
      await expect(page.getByText('No schedules')).toBeVisible();
      await page.screenshot({
        path: `${OUT}/${theme}-schedules-empty.png`,
        animations: 'disabled',
      });
    });

    test('the new schedule dialog, with its preview', async ({ page }) => {
      await server(page, SCHEDULES);
      await page.goto('/schedules');
      await page.getByRole('button', { name: 'New schedule' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New schedule' });
      await expect(dialog.getByText('every 5 minutes')).toBeVisible();

      await dialog.getByRole('button', { name: 'Weekdays' }).click();
      await expect(dialog.getByLabel('Cron expression')).toHaveValue('0 9 * * 1-5');
      await expect(dialog.getByText('at 9:00, Monday to Friday')).toBeVisible();
      await page.screenshot({ path: `${OUT}/${theme}-schedules-new.png`, animations: 'disabled' });
    });

    test('a cron the server refuses', async ({ page }) => {
      await server(page, SCHEDULES);
      await page.goto('/schedules');
      await page.getByRole('button', { name: 'New schedule' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New schedule' });
      const expression = dialog.getByLabel('Cron expression');
      await expression.fill('99 * * * *');
      await expect(dialog.getByText(/minute field out of range/)).toBeVisible();
      await page.screenshot({
        path: `${OUT}/${theme}-schedules-bad-cron.png`,
        animations: 'disabled',
      });
    });

    test('a run started from the list', async ({ page }) => {
      await server(page, SCHEDULES);
      await page.goto('/schedules');
      await page.getByRole('button', { name: 'Run reports/word_count.py now' }).click();
      await expect(page.getByRole('status')).toContainText('started');
      await page.screenshot({
        path: `${OUT}/${theme}-schedules-notice.png`,
        animations: 'disabled',
      });
    });

    test('the delete confirmation', async ({ page }) => {
      await server(page, SCHEDULES);
      await page.goto('/schedules');
      await page.getByRole('button', { name: 'Delete the schedule for nightly_etl.py' }).click();
      await expect(page.getByRole('dialog', { name: 'Delete this schedule?' })).toBeVisible();
      await page.screenshot({
        path: `${OUT}/${theme}-schedules-delete.png`,
        animations: 'disabled',
      });
    });
  });
}
