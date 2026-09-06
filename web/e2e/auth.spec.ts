import { expect, test, type Page } from '@playwright/test';
import { shoot, THEMES, useTheme } from './helpers';
import { SERVER_TOKEN } from './users.harness';

/*
 * The other kind of server: `tolquane web --token …` with no accounts in it yet.
 *
 * Nothing under `/api` answers without the token -- not even "who am I" -- so the page
 * cannot know what kind of server it is until the token has been given, and the first
 * thing it can offer is the field to paste it into. Once it has one, the server says it
 * has no users, and the login page offers to make the first administrator.
 *
 * The tests run in this order on purpose: the last one leaves the server with an
 * administrator in it, and there is no going back from that.
 */

async function unlock(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'This server wants a token' })).toBeVisible();
  await page.getByLabel('Server token').fill(SERVER_TOKEN);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Create the first administrator' })).toBeVisible();
}

test('asks for the token in the app the way it always has', async ({ page }) => {
  await page.goto('/flows');
  // The 1.2 behaviour, unchanged: a --token server with no users is not a login screen.
  const dialog = page.getByRole('dialog', { name: /wants a token/ });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Token needed')).toBeVisible();
});

test('refuses a token that is not the token', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Server token').fill('not-the-token');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toContainText('refused that token');
  expect(await page.evaluate(() => window.localStorage.getItem('tolquane.token'))).toBeNull();
});

for (const theme of THEMES) {
  test(`the token field and the setup form (${theme})`, async ({ page }) => {
    await useTheme(page, theme);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'This server wants a token' })).toBeVisible();
    await shoot(page, `login-token-${theme}`);

    await page.getByLabel('Server token').fill(SERVER_TOKEN);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(
      page.getByRole('heading', { name: 'Create the first administrator' }),
    ).toBeVisible();
    await shoot(page, `login-setup-${theme}`);
  });
}

test('says what is wrong before it asks the server', async ({ page }) => {
  await unlock(page);
  await page.getByLabel('Name').fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByLabel('Password again').fill('short');
  await page.getByRole('button', { name: 'Create the administrator' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 8 characters');

  await page.getByLabel('Password', { exact: true }).fill('a-long-enough-one');
  await page.getByLabel('Password again').fill('a-different-one');
  await page.getByRole('button', { name: 'Create the administrator' }).click();
  await expect(page.getByRole('alert')).toContainText('not the same');
});

/* Last: from here on this server has users, and asks everybody to sign in. */
test('makes the first administrator and signs in as them', async ({ page }) => {
  await unlock(page);
  await page.getByLabel('Name').fill('root');
  await page.getByLabel('Password', { exact: true }).fill('root-password-1');
  await page.getByLabel('Password again').fill('root-password-1');
  await page.getByRole('button', { name: 'Create the administrator' }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Flows' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Account: root/ })).toContainText('admin');
  // The administrator exists now, so the server has users and asks for a sign-in.
  await page.getByRole('button', { name: /^Account: root/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
