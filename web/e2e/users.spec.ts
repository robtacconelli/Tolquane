import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { shoot, THEMES, useTheme } from './helpers';
import { ALICE, BOB, USERS_URL } from './users.harness';

/*
 * A real `tolquane web` with accounts in it (see `e2e/users.harness.ts`): alice is an
 * administrator, bob a member, and neither of them exists in the browser until they sign
 * in through the page. Nothing here is mocked -- the passwords were set by
 * `tolquane web users add`, the sessions are the server's own, and every refusal is the
 * server's message.
 */

async function signIn(page: Page, who: { name: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Name').fill(who.name);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Flows' })).toBeVisible();
}

/** The account button at the foot of the sidebar. */
function accountButton(page: Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^Account: ${name}`) });
}

/** An administrator's own token, for the things a spec does behind the page's back. */
async function adminToken(request: APIRequestContext): Promise<string> {
  const answer = await request.post(`${USERS_URL}/api/auth/login`, {
    data: { name: ALICE.name, password: ALICE.password },
  });
  expect(answer.ok()).toBe(true);
  const body = (await answer.json()) as { token: string };
  return body.token;
}

test.describe('signing in', () => {
  test('stands in front of the app, and puts the reader back afterwards', async ({ page }) => {
    await page.goto('/runs');
    // Not one paint of somebody else's workspace: the page asks who you are first.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page.getByLabel('Name').fill(ALICE.name);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('do not go together');
    expect(await page.evaluate(() => window.localStorage.getItem('tolquane.token'))).toBeNull();

    await page.getByLabel('Password').fill(ALICE.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Back at /runs, which is where the reader was going before they were asked.
    await expect(page).toHaveURL(/\/runs$/);
    expect(await page.evaluate(() => window.localStorage.getItem('tolquane.token'))).not.toBeNull();
  });

  test('names the account in the sidebar, and signs out again', async ({ page }) => {
    await signIn(page, ALICE);
    const account = accountButton(page, 'alice');
    await expect(account).toContainText('alice');
    await expect(account).toContainText('admin');

    await account.click();
    await expect(page.getByRole('menu', { name: 'Account' })).toContainText('Administrator');
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => window.localStorage.getItem('tolquane.token'))).toBeNull();
  });

  test('sends a session the server has forgotten back to the login page', async ({ page }) => {
    await signIn(page, ALICE);
    // The session is dropped from the browser's side of the wire, which is what an
    // expired or revoked one looks like: the next request is a 401.
    await page.evaluate(() => window.localStorage.setItem('tolquane.token', 'not-a-session'));
    await page.getByRole('link', { name: 'Schedules' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('a member', () => {
  test('is not offered the users page, and is refused it when asked for by name', async ({
    page,
  }) => {
    await signIn(page, BOB);
    const sections = page.getByRole('navigation', { name: 'Sections' });
    await expect(sections.getByRole('link', { name: 'Flows' })).toBeVisible();
    await expect(sections.getByRole('link', { name: 'Users' })).toHaveCount(0);

    await page.goto('/users');
    await expect(page.getByText('Users is for administrators')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the flows' })).toBeVisible();
  });

  test('sees the settings that are theirs, and not the ones that are not', async ({ page }) => {
    await signIn(page, BOB);
    await page.goto('/settings');
    // The server answers `server: null` and `has_*_key: null` to a member (U, Roles), so
    // the page has fewer sections than an administrator's.
    await expect(page.getByText('Appearance')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Server' })).toHaveCount(0);
    await expect(page.getByText('Access token', { exact: true })).toHaveCount(0);
  });
});

test.describe('the users page', () => {
  // The copy buttons write to the clipboard; a browser that has not been asked refuses.
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('lists everybody who can sign in', async ({ page }) => {
    await signIn(page, ALICE);
    await page.getByRole('link', { name: 'Users' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Users' })).toBeVisible();
    // `alice` is in the sidebar too, so the rows are found by what only they have.
    await expect(page.getByLabel('Role for alice')).toHaveValue('admin');
    await expect(page.getByLabel('Role for bob')).toHaveValue('member');
    await expect(page.getByText('you')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Disable bob' })).toBeVisible();
  });

  test('adds somebody, changes them, and takes them away again', async ({ page }) => {
    await signIn(page, ALICE);
    await page.goto('/users');

    await page.getByRole('button', { name: 'Add a user' }).click();
    await page.getByLabel('Name').fill('dora');
    await page.getByRole('button', { name: 'Add the user' }).click();

    // The temporary password exists as a string exactly once, here.
    const secret = page.getByRole('dialog').locator('code');
    await expect(secret).toBeVisible();
    const password = (await secret.textContent()) ?? '';
    expect(password.length).toBeGreaterThanOrEqual(8);
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    const row = page.getByLabel('Role for dora');
    await expect(row).toHaveValue('member');
    await row.selectOption('admin');
    await expect(page.getByLabel('Role for dora')).toHaveValue('admin');

    await page.getByRole('switch', { name: 'Disable dora' }).click();
    await expect(page.getByRole('switch', { name: 'Enable dora' })).toBeVisible();
    await page.getByRole('switch', { name: 'Enable dora' }).click();
    await expect(page.getByRole('switch', { name: 'Disable dora' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete dora' }).click();
    await page.getByRole('button', { name: 'Delete the user' }).click();
    await expect(page.getByLabel('Role for dora')).toHaveCount(0);
  });

  test('shows the server refusing to leave nobody in charge', async ({ page }) => {
    await signIn(page, ALICE);
    await page.goto('/users');

    // Two refusals, both the server's own words, both on the row they are about.
    await page.getByLabel('Role for alice').selectOption('member');
    await expect(page.getByRole('alert')).toContainText('last administrator');
    await expect(page.getByLabel('Role for alice')).toHaveValue('admin');

    await page.getByRole('button', { name: 'Delete alice' }).click();
    await page.getByRole('button', { name: 'Delete the user' }).click();
    await expect(page.getByRole('alert')).toContainText('cannot delete yourself');
  });

  test('makes a new API token, shows it once and revokes it', async ({ page }) => {
    await signIn(page, ALICE);
    await accountButton(page, 'alice').click();
    await page.getByRole('menuitem', { name: 'API tokens…' }).click();

    await page.getByLabel('New token').fill('nightly report');
    await page.getByRole('button', { name: 'Make a token' }).click();
    await expect(page.getByText(/shown this once/)).toBeVisible();
    await expect(page.getByText('nightly report').first()).toBeVisible();

    await page.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText(/No tokens yet/)).toBeVisible();
  });
});

test.describe('a password somebody else chose', () => {
  test('has to be replaced at the first sign-in, and the new one works', async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const made = await request.post(`${USERS_URL}/api/users`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'erin', role: 'member', password: 'given-to-erin-1' },
    });
    expect(made.status()).toBe(201);
    expect(((await made.json()) as { must_change_password: boolean }).must_change_password).toBe(
      true,
    );

    await page.goto('/login');
    await page.getByLabel('Name').fill('erin');
    await page.getByLabel('Password').fill('given-to-erin-1');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
    // The one just used is the current one: it is not asked for twice.
    await expect(page.getByLabel('Current password')).toHaveCount(0);
    await page.getByLabel('New password', { exact: true }).fill('erins-own-password');
    await page.getByLabel('New password again').fill('erins-own-password');
    await page.getByRole('button', { name: 'Set the password' }).click();

    await expect(page.getByRole('heading', { level: 2, name: 'Flows' })).toBeVisible();
    await expect(accountButton(page, 'erin')).toBeVisible();

    // And it is really the new password now.
    await accountButton(page, 'erin').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, { name: 'erin', password: 'erins-own-password' });
    await expect(page.getByRole('heading', { name: 'Choose a password' })).toHaveCount(0);

    await request.delete(
      `${USERS_URL}/api/users/${String(((await made.json()) as { id: number }).id)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
  });
});

test.describe('the gallery', () => {
  for (const theme of THEMES) {
    test(`the login page, the users page and the account menu (${theme})`, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await shoot(page, `login-${theme}`);

      await signIn(page, ALICE);
      await page.goto('/users');
      await expect(page.getByLabel('Role for bob')).toBeVisible();
      await shoot(page, `users-${theme}`);

      await accountButton(page, 'alice').click();
      await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible();
      await shoot(page, `account-menu-${theme}`);
      await page.keyboard.press('Escape');

      // The moment the temporary password exists: it is on screen once and nowhere else.
      const name = `shot-${theme}`;
      await page.getByRole('button', { name: 'Add a user' }).click();
      await page.getByLabel('Name').fill(name);
      await page.getByRole('button', { name: 'Add the user' }).click();
      await expect(page.getByText(/is shown once/)).toBeVisible();
      await shoot(page, `users-new-${theme}`);
      await page.getByRole('button', { name: 'Done' }).click();

      // Put the list back, so the other theme's picture is of the same two people.
      await page.getByRole('button', { name: `Delete ${name}` }).click();
      await page.getByRole('button', { name: 'Delete the user' }).click();
      await expect(page.getByLabel(`Role for ${name}`)).toHaveCount(0);
    });
  }
});
