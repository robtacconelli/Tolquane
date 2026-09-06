import { expect, test, type Page } from '@playwright/test';
import { WS_DIR } from './harness';
import { shoot, THEMES, useTheme } from './helpers';

/*
 * Settings, against the real server: every value on the page is one the server holds,
 * and saving really writes it. The workspace field is read but never saved -- moving it
 * would take the rest of the suite's flows away -- and the numbers this file changes are
 * put back before it ends.
 */

test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
});

async function openSettings(page: Page): Promise<void> {
  await page.goto('/settings');
  await expect(page.getByLabel('Workspace directory')).toHaveValue(WS_DIR);
}

/** The section footer's Save, found by a label the section carries. */
function sectionSave(page: Page, contains: string) {
  return page
    .locator('section')
    .filter({ hasText: contains })
    .getByRole('button', { name: 'Save' });
}

test('shows what the server holds, section by section', async ({ page }) => {
  await openSettings(page);
  await expect(page.getByLabel('Default runtime')).toHaveValue('threads');
  await expect(page.getByLabel('Default batch')).toHaveValue('32');
  // The server section is what it was started with, and is read-only.
  await expect(page.getByText('127.0.0.1:')).toBeVisible();
  await expect(page.getByText('Not required')).toBeVisible();
});

test('an edit in flight, and a number that is not one', async ({ page }) => {
  await openSettings(page);
  await page.getByLabel('Concurrent runs').fill('99');
  await expect(page.getByText('Between 1 and 64.')).toBeVisible();
  await expect(sectionSave(page, 'Default runtime')).toBeDisabled();
  await shoot(page, 'settings-editing');

  await page.getByLabel('Concurrent runs').fill('4');
  await expect(page.getByText('Between 1 and 64.')).toBeHidden();
});

test('saves a section and says so, then puts it back', async ({ page }) => {
  await openSettings(page);
  await page.getByLabel('Default batch').fill('64');
  await sectionSave(page, 'Default runtime').click();
  await expect(page.getByText('Saved')).toBeVisible();
  await shoot(page, 'settings-saved');

  // It is on the server, not only on screen.
  await page.reload();
  await expect(page.getByLabel('Default batch')).toHaveValue('64');

  await page.getByLabel('Default batch').fill('32');
  await sectionSave(page, 'Default runtime').click();
  await expect(page.getByText('Saved')).toBeVisible();
});

test('discards an edit rather than saving it', async ({ page }) => {
  await openSettings(page);
  await page.getByLabel('Default batch').fill('7');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page
    .locator('section')
    .filter({ hasText: 'Default runtime' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(page.getByLabel('Default batch')).toHaveValue('32');
});

test('keeps a server token in this browser, and clears it again', async ({ page }) => {
  await openSettings(page);
  const field = page.getByLabel('Your token');
  await field.fill('a-token');
  await page.getByRole('button', { name: 'Use it' }).click();
  expect(await page.evaluate(() => window.localStorage.getItem('tolquane.token'))).toBe('a-token');
  await expect(page.getByText('Stored in this browser.')).toBeVisible();

  await page.getByRole('button', { name: 'Clear' }).click();
  expect(await page.evaluate(() => window.localStorage.getItem('tolquane.token'))).toBeNull();
});

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    // The scrolling element is the shell's main, not the document, so `fullPage` would
    // only ever show the first screen: the whole page needs a viewport its own size.
    test.use({ viewport: { width: 1280, height: 2200 } });

    test('every section at full height', async ({ page }) => {
      await useTheme(page, theme);
      await openSettings(page);
      await shoot(page, `settings-${theme}`);
    });
  });
}
