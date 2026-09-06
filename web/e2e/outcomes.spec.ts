import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { FLOWS } from './harness';
import { notice, shoot, THEMES, useTheme } from './helpers';

/*
 * Schedule outcomes (section N), against the real server and a real webhook.
 *
 * `python -m http.server` answers a POST with 501 and never shows what was in it, so the
 * receiver here is ten lines of Node that keep the bodies: a test notification is only
 * proved by what arrived at the other end.
 */

interface Hook {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

async function webhook(): Promise<Hook> {
  const bodies: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      bodies.push(body);
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/hook`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
});

async function openSchedules(page: Page): Promise<void> {
  await page.goto('/schedules');
  await expect(page.getByText('Scheduled flows')).toBeVisible();
}

async function unschedule(page: Page, flow: string): Promise<void> {
  await page.getByRole('button', { name: `Delete the schedule for ${flow}` }).click();
  await page.getByRole('button', { name: 'Delete schedule' }).click();
  await expect(notice(page, 'Deleted the schedule')).toBeVisible();
}

test('a schedule keeps its inputs and its outcomes, and the list rings a bell', async ({
  page,
}) => {
  const hook = await webhook();
  try {
    await openSchedules(page);
    await page.getByRole('button', { name: 'New schedule' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await dialog.getByLabel('Flow').selectOption(FLOWS.params);

    // The parameters come from the flow's own model, not from a list this page keeps.
    await expect(dialog.getByLabel('factor')).toHaveValue('2');
    await dialog.getByLabel('factor').fill('4');
    await dialog.getByRole('button', { name: 'Add a variable' }).click();
    await dialog.getByLabel('Variable 1 name').fill('GREETING');
    await dialog.getByLabel('Value of GREETING').fill('cron');

    await dialog.getByRole('switch', { name: 'Failed' }).click();
    await dialog.getByRole('switch', { name: 'Done' }).click();
    await dialog.getByRole('checkbox', { name: 'Use the default' }).click();
    await dialog.getByLabel('Webhook').fill(hook.url);
    await dialog.getByLabel('Retries').selectOption('2');
    await dialog.getByLabel('Wait between them').fill('5');
    await dialog.getByText('Tell me when a run is').scrollIntoViewIfNeeded();
    await shoot(page, 'outcomes-dialog');

    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByRole('listitem', { name: `Schedule for ${FLOWS.params}` });
    await expect(row.getByRole('img', { name: /Notifications on for/ })).toBeVisible();
    await expect(row).toContainText('2 retries');
    await shoot(page, 'outcomes-list');

    // Reopened, every one of them is where it was left.
    await page.getByRole('button', { name: `Edit the schedule for ${FLOWS.params}` }).click();
    const edit = page.getByRole('dialog', { name: 'Edit schedule' });
    await expect(edit.getByLabel('factor')).toHaveValue('4');
    await expect(edit.getByLabel('Value of GREETING')).toHaveValue('cron');
    await expect(edit.getByLabel('Webhook')).toHaveValue(hook.url);
    await expect(edit.getByLabel('Retries')).toHaveValue('2');
    await expect(edit.getByRole('switch', { name: 'Failed' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // And the test really posts: the receiver above has the body to prove it.
    await edit.getByRole('button', { name: 'Send a test' }).click();
    await expect(edit.getByText(`webhook · ${hook.url}`)).toBeVisible({ timeout: 20_000 });
    await expect(edit.getByText('sent')).toBeVisible();
    await edit.getByText(`webhook · ${hook.url}`).scrollIntoViewIfNeeded();
    await shoot(page, 'outcomes-test');
    expect(hook.bodies).toHaveLength(1);
    const sent = JSON.parse(hook.bodies[0] ?? '{}') as { flow?: string; event?: string };
    expect(sent.flow).toBe(FLOWS.params);

    await page.keyboard.press('Escape');
    await unschedule(page, FLOWS.params);
  } finally {
    await hook.close();
  }
});

test('a schedule with nowhere to send says so instead of pretending', async ({ page }) => {
  await openSchedules(page);
  await page.getByRole('button', { name: 'New schedule' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByLabel('Flow').selectOption(FLOWS.hello);
  await dialog.getByRole('button', { name: 'Create schedule' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: `Edit the schedule for ${FLOWS.hello}` }).click();
  const edit = page.getByRole('dialog', { name: 'Edit schedule' });
  await edit.getByRole('button', { name: 'Send a test' }).click();
  await expect(edit.getByRole('alert')).toBeVisible({ timeout: 20_000 });

  await page.keyboard.press('Escape');
  await unschedule(page, FLOWS.hello);
});

test('a run started by a schedule keeps its inputs and its outcome', async ({ page }) => {
  const hook = await webhook();
  try {
    await openSchedules(page);
    await page.getByRole('button', { name: 'New schedule' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await dialog.getByLabel('Flow').selectOption(FLOWS.params);
    await dialog.getByLabel('factor').fill('3');
    await dialog.getByRole('switch', { name: 'Done' }).click();
    await dialog.getByRole('checkbox', { name: 'Use the default' }).click();
    await dialog.getByLabel('Webhook').fill(hook.url);
    await dialog.getByRole('button', { name: 'Create schedule' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: `Run ${FLOWS.params} now` }).click();
    await expect(notice(page, /started for/)).toBeVisible();

    await page.goto('/runs');
    const row = page
      .locator('div')
      .filter({ hasText: /^Schedule \d+$/ })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole('button', { name: /Open run/ })
      .first()
      .click();

    const open = page.getByRole('dialog');
    await open.getByRole('button', { name: 'Inputs' }).click();
    await expect(open.getByText('factor')).toBeVisible();
    await expect(open.getByText('3', { exact: true })).toBeVisible();

    await open.getByRole('button', { name: 'Outcome' }).click();
    await expect(open.getByRole('list', { name: 'Attempts' })).toContainText('First attempt');
    // The notification is delivered on its own thread, so it may take a moment.
    await expect(open.getByRole('list', { name: 'Notifications sent' })).toContainText('webhook', {
      timeout: 20_000,
    });
    await shoot(page, 'outcomes-run-dialog');

    await page.keyboard.press('Escape');
    await openSchedules(page);
    await unschedule(page, FLOWS.params);
  } finally {
    await hook.close();
  }
});

for (const theme of THEMES) {
  test(`the outcomes section reads in the ${theme} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await openSchedules(page);
    await page.getByRole('button', { name: 'New schedule' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New schedule' });
    await dialog.getByLabel('Flow').selectOption(FLOWS.params);
    await expect(dialog.getByLabel('factor')).toBeVisible();
    await dialog.getByRole('switch', { name: 'Failed' }).click();
    await dialog.getByRole('switch', { name: 'Deadlock' }).click();
    await dialog
      .getByRole('button', { name: 'Send a test' })
      .or(dialog.getByLabel('Email'))
      .first()
      .scrollIntoViewIfNeeded();
    await shoot(page, `outcomes-dialog-${theme}`);
    await page.keyboard.press('Escape');

    await page.goto('/settings');
    // The whole page arrives with one request; wait for it rather than for one field.
    await expect(page.getByLabel('Workspace directory')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Default webhook')).toBeVisible();
    await page.getByLabel('SMTP password').scrollIntoViewIfNeeded();
    await shoot(page, `outcomes-settings-${theme}`);
  });
}
