import { expect, test } from '@playwright/test';
import { FLOWS } from './harness';
import { openFlow, shoot, THEMES, useEditorLayout, useTheme } from './helpers';

/*
 * The gallery: every screen, in both themes, at the two window sizes the app is designed
 * for -- 1280x720, where the canvas has the least room, and 1440x900. Nothing here
 * asserts a pixel; the point is a folder of shots that can be looked at after a change,
 * which is the only way anyone reviews how this looks.
 */

/*
 * Nothing on any of these screens may write to the console. A React warning -- a missing
 * key, an update on an unmounted component, a controlled input turning uncontrolled --
 * is a defect that only ever shows up here, so the gallery is also where it is caught.
 */
const complained = new WeakMap<object, string[]>();

test.beforeEach(({ page }) => {
  const complaints: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      complaints.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => complaints.push(`pageerror: ${error.message}`));
  complained.set(page, complaints);
});

test.afterEach(({ page }) => {
  expect(complained.get(page) ?? []).toEqual([]);
});

const SIZES = [
  { name: 'sm', width: 1280, height: 720 },
  { name: 'lg', width: 1440, height: 900 },
] as const;

const PAGES = [
  { name: 'flows', path: '/flows', marker: 'Workspace' },
  { name: 'runs', path: '/runs', marker: 'History' },
  { name: 'schedules', path: '/schedules', marker: 'Scheduled flows' },
  { name: 'settings', path: '/settings', marker: 'Appearance' },
] as const;

for (const size of SIZES) {
  test.describe(`${String(size.width)} wide`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    for (const theme of THEMES) {
      test.describe(`${theme} theme`, () => {
        test.beforeEach(async ({ page }) => {
          await useTheme(page, theme);
          await useEditorLayout(page);
        });

        const tag = `${theme}-${size.name}`;

        test('the list pages', async ({ page }) => {
          for (const route of PAGES) {
            await page.goto(route.path);
            await expect(page.getByText(route.marker).first()).toBeVisible();
            await shoot(page, `${tag}-${route.name}`);
          }
        });

        test('the editor, on a flow and on one it cannot model', async ({ page }) => {
          await openFlow(page, FLOWS.words);
          await shoot(page, `${tag}-editor`);

          await page.getByText('words farm').first().click();
          await expect(page.getByLabel('How many')).toBeVisible();
          await shoot(page, `${tag}-properties`);

          await page.getByRole('button', { name: 'Code', exact: true }).click();
          await expect(page.getByText('Canvas in sync')).toBeVisible();
          await shoot(page, `${tag}-code`);

          await page.goto(`/flows/${FLOWS.codeOnly}`);
          await expect(page.getByText(/cannot be modelled/).first()).toBeVisible();
          await page.waitForTimeout(500);
          await shoot(page, `${tag}-code-only`);
        });

        test('the editor folded down to the canvas', async ({ page }) => {
          await openFlow(page, FLOWS.words);
          await page.getByRole('button', { name: 'Fold the block palette' }).click();
          await page.getByRole('button', { name: 'Fold the run drawer' }).click();
          await page.getByRole('button', { name: 'Hide the side panel' }).click();
          await page.getByRole('button', { name: 'Fit', exact: true }).click();
          await page.waitForTimeout(500);
          await shoot(page, `${tag}-editor-folded`);
        });

        test('the nested flow, the palette and the collapsed sidebar', async ({ page }) => {
          await openFlow(page, FLOWS.nested);
          // The breadcrumb of a flow in a folder: Flows > reports > word_frequency.py
          await expect(page.getByRole('heading', { level: 1 })).toHaveText('word_frequency.py');
          await shoot(page, `${tag}-editor-nested`);

          await page.goto('/flows');
          // The palette's hotkey is registered when the shell mounts, not when the
          // document loads: press it once there is something on screen to press it at.
          await expect(page.getByRole('heading', { name: 'Flows', level: 2 })).toBeVisible();
          await page.keyboard.press('ControlOrMeta+k');
          const palette = page.getByRole('dialog', { name: 'Command palette' });
          await expect(palette).toBeVisible();
          // The workspace arrives from the server a moment after the palette opens.
          await expect(palette.getByRole('button', { name: 'word_count' })).toBeVisible();
          await shoot(page, `${tag}-palette`);
          await page.keyboard.press('Escape');

          await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
          await expect(page.getByRole('link', { name: 'Runs' })).toBeVisible();
          await shoot(page, `${tag}-collapsed`);
          await page.getByRole('button', { name: 'Expand the sidebar' }).click();
        });
      });
    }
  });
}
