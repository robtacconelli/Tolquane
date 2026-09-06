import { expect, test, type Page } from '@playwright/test';
import { FLOWS } from './harness';
import { notice, shoot, THEMES, useTheme } from './helpers';

/*
 * Schedules, against the real store: every row here is a row in the database and every
 * "next run" is the cron parser's own answer. The tests make their schedules and take
 * them away again, so the page starts empty and ends empty.
 */

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
});

async function openSchedules(page: Page): Promise<void> {
  await page.goto('/schedules');
  await expect(page.getByText('Scheduled flows')).toBeVisible();
}

/** Make one schedule through the page, and hand back the row it produced. */
async function schedule(page: Page, flow: string, cron: string): Promise<void> {
  await page.getByRole('button', { name: 'New schedule' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByLabel('Flow').selectOption(flow);
  await dialog.getByLabel('Cron expression').fill(cron);
  await dialog.getByRole('button', { name: 'Create schedule' }).click();
  await expect(dialog).toBeHidden();
}

async function unschedule(page: Page, flow: string): Promise<void> {
  await page.getByRole('button', { name: `Delete the schedule for ${flow}` }).click();
  await page.getByRole('button', { name: 'Delete schedule' }).click();
  await expect(notice(page, 'Deleted the schedule')).toBeVisible();
}

test('starts with an empty state that says what a schedule is', async ({ page }) => {
  await openSchedules(page);
  await expect(page.getByText('No schedules')).toBeVisible();
  await expect(page.getByText(/plain English/)).toBeVisible();
  await shoot(page, 'schedules-empty');
});

test('previews an expression in English and in times before it is saved', async ({ page }) => {
  await openSchedules(page);
  await page.getByRole('button', { name: 'New schedule' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });

  await expect(dialog.getByText('every 5 minutes')).toBeVisible();
  await dialog.getByRole('button', { name: 'Weekdays' }).click();
  await expect(dialog.getByLabel('Cron expression')).toHaveValue('0 9 * * 1-5');
  await expect(dialog.getByText('at 09:00, Monday to Friday')).toBeVisible();
  await shoot(page, 'schedules-new');

  // And the server's own message when the expression is not one.
  await dialog.getByLabel('Cron expression').fill('99 * * * *');
  await expect(dialog.getByText(/minute/)).toBeVisible();
  await shoot(page, 'schedules-bad-cron');
  await page.keyboard.press('Escape');
});

test('lists a schedule, pauses it, runs it now and deletes it', async ({ page }) => {
  await openSchedules(page);
  await schedule(page, FLOWS.hello, '*/15 * * * *');

  const row = page.getByRole('listitem', { name: `Schedule for ${FLOWS.hello}` });
  await expect(row).toContainText('every 15 minutes');
  await expect(row.getByText(/\d{1,2}:\d{2}/).first()).toBeVisible();
  await shoot(page, 'schedules-list');

  // Paused: the next time goes, because there is not one.
  await page.getByRole('switch', { name: `Disable the schedule for ${FLOWS.hello}` }).click();
  await expect(row).toContainText('Paused');
  await page.getByRole('switch', { name: `Enable the schedule for ${FLOWS.hello}` }).click();
  await expect(row).not.toContainText('Paused');

  // Run now starts a real run, and says which one.
  await page.getByRole('button', { name: `Run ${FLOWS.hello} now` }).click();
  await expect(notice(page, /started for/)).toBeVisible();
  await shoot(page, 'schedules-notice');

  await page.getByRole('button', { name: `Delete the schedule for ${FLOWS.hello}` }).click();
  await expect(page.getByRole('dialog', { name: 'Delete this schedule?' })).toBeVisible();
  await shoot(page, 'schedules-delete');
  await page.getByRole('button', { name: 'Delete schedule' }).click();
  await expect(notice(page, 'Deleted the schedule')).toBeVisible();
  await expect(page.getByText('No schedules')).toBeVisible();
});

test('edits a schedule that already exists', async ({ page }) => {
  await openSchedules(page);
  await schedule(page, FLOWS.average, '0 * * * *');

  await page.getByRole('button', { name: `Edit the schedule for ${FLOWS.average}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
  await expect(dialog.getByLabel('Cron expression')).toHaveValue('0 * * * *');
  await dialog.getByLabel('Cron expression').fill('0 2 * * *');
  await expect(dialog.getByText('at 02:00 daily')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByRole('listitem', { name: `Schedule for ${FLOWS.average}` })).toContainText(
    'at 02:00 daily',
  );
  await unschedule(page, FLOWS.average);
});

for (const theme of THEMES) {
  test(`the list reads in the ${theme} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await openSchedules(page);
    await schedule(page, FLOWS.nested, '*/15 * * * *');
    await expect(page.getByText('every 15 minutes')).toBeVisible();
    await shoot(page, `schedules-${theme}`);
    await unschedule(page, FLOWS.nested);
  });
}
