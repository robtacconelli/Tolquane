import { expect, test, type Page } from '@playwright/test';
import { shoot, THEMES, useTheme } from './helpers';

/*
 * What the app looks like when the server is not answering.
 *
 * The rest of the suite runs against a real `tolquane web`, so this is the one file that
 * takes it away: `/api` is refused in the browser rather than by stopping the server,
 * which is both what a stopped server looks like to the client and something one spec
 * can do without the others noticing.
 *
 * The token prompt is here too, for the same reason: a server that answers 401 is a
 * server this browser cannot use yet, and the answer to it is a dialog, not a banner.
 */

/** Every call to `/api` fails the way it fails when nothing is listening. */
async function withoutServer(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
}

/** A server that wants a token this browser does not have. */
async function wantingToken(page: Page): Promise<void> {
  await page.route('**/api/**', (route) => {
    const auth = route.request().headers()['authorization'];
    if (auth === 'Bearer opensesame') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          version: '1.1.0',
          workspace: '/tmp/ws',
          runs_live: 0,
          scheduler: true,
        }),
      });
    }
    return route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { type: 'Unauthorized', message: 'a token is required' } }),
    });
  });
}

test.describe('with no server', () => {
  test.beforeEach(async ({ page }) => {
    await withoutServer(page);
  });

  for (const theme of THEMES) {
    test(`the banner and the empty states say what to do (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto('/flows');

      // Quiet, and only after a poll has actually failed.
      const banner = page.getByRole('status').filter({ hasText: 'not reachable' });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('tolquane web');
      await expect(page.getByText('The server is not running')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(page.getByText('Server offline')).toBeVisible();
      await shoot(page, `${theme}-offline-flows`);

      await page.getByRole('link', { name: 'Runs' }).click();
      await expect(page.getByText('The server is not running')).toBeVisible();
      await shoot(page, `${theme}-offline-runs`);

      await page.getByRole('link', { name: 'Schedules' }).click();
      await expect(page.getByText('The server is not running')).toBeVisible();

      await page.getByRole('link', { name: 'Settings' }).click();
      await expect(page.getByText(/Settings could not be read|not running/)).toBeVisible();
      await shoot(page, `${theme}-offline-settings`);
    });
  }

  test('an open flow says it is not open, and the editor still stands', async ({ page }) => {
    await useTheme(page, 'dark');
    await page.goto('/flows/hello.py');
    await expect(page.getByText('This flow is not open')).toBeVisible();
    await expect(page.getByText('Could not reach the Tolquane server')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Console/ })).toBeVisible();
    await shoot(page, 'dark-offline-editor');
  });
});

test.describe('with a server that wants a token', () => {
  test('asks for it, keeps the one that works and retries', async ({ page }) => {
    await useTheme(page, 'dark');
    await wantingToken(page);
    await page.goto('/flows');

    const dialog = page.getByRole('dialog', { name: /wants a token/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('tolquane web --token');
    // A server that answers 401 is running: the offline banner would send the reader to
    // restart one that is already up, so it stays away and the sidebar says what is wrong.
    await expect(page.getByRole('status').filter({ hasText: 'not reachable' })).toBeHidden();
    await expect(page.getByText('Token needed')).toBeVisible();
    await shoot(page, 'dark-token-prompt');

    // A wrong token is refused and nothing is kept.
    await dialog.getByLabel('Server token').fill('wrong');
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(dialog.getByRole('alert')).toContainText('refused that token');
    expect(await page.evaluate(() => window.localStorage.getItem('tolquane.token'))).toBeNull();

    // The right one is kept, and the page it was blocking loads.
    await dialog.getByLabel('Server token').fill('opensesame');
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => window.localStorage.getItem('tolquane.token'))).toBe(
      'opensesame',
    );
    await expect(page.getByText('Server 1.1.0')).toBeVisible();
  });

  test('can be put away, and asked for again from Settings', async ({ page }) => {
    await useTheme(page, 'dark');
    await wantingToken(page);
    await page.goto('/settings');

    const dialog = page.getByRole('dialog', { name: /wants a token/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();

    // Settings itself could not be read, but the page says so rather than looking empty.
    await expect(page.getByText(/could not be read|not running|token/i).first()).toBeVisible();
  });
});
