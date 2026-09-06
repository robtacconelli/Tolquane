import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { WS_DIR } from './harness';

/*
 * What every spec in this directory does the same way: pick a theme before the first
 * paint, open a flow and wait for the canvas, take a screenshot into the gallery, and
 * put a file back the way it was found.
 */

export const OUT = 'e2e/screenshots';
export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

/** The theme is read from localStorage before the first paint, as in index.html. */
export async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    'tolquane.theme',
    theme,
  ] as const);
}

/**
 * Start the editor from a known shape: palette open, panel open, drawer open at its
 * default height. The page remembers these between visits, so without this a spec would
 * depend on whatever the last one folded away.
 */
export async function useEditorLayout(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const [key, value] of [
      ['tolquane.editor.palette', 'on'],
      ['tolquane.editor.drawer', 'on'],
      ['tolquane.editor.panel', 'on'],
      ['tolquane.editor.minimap', 'on'],
      ['tolquane.editor.drawerHeight', '208'],
    ] as const) {
      window.localStorage.setItem(key, value);
    }
  });
}

export async function shoot(page: Page, name: string): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
}

/** A flow file in the workspace the suite seeded. */
export function flowFile(path: string): string {
  return join(WS_DIR, path);
}

export function readFlow(path: string): Promise<string> {
  return readFile(flowFile(path), 'utf8');
}

export function writeFlow(path: string, text: string): Promise<void> {
  return writeFile(flowFile(path), text, 'utf8');
}

/** Open a flow on the canvas and wait until its cards are drawn and the view settled. */
export async function openFlow(page: Page, path: string): Promise<void> {
  await page.goto(`/flows/${path}`);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await expect(page.getByText(/^(saved|layout moved|unsaved changes)$/).first()).toBeVisible();
  // The fit-view transition; screenshots of a moving canvas are not reviewable.
  await page.waitForTimeout(400);
}

export function runButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Run', exact: true });
}

/** The run's own state, at the end of the drawer's tab strip. */
export function runSummary(page: Page): Locator {
  return page.locator('[role="tablist"][aria-label="Run output"] [data-status]');
}

export async function waitForRun(page: Page, status: string, timeout = 40_000): Promise<void> {
  await expect(runSummary(page)).toHaveAttribute('data-status', status, { timeout });
}

/**
 * The strip a page says things in. There can be more than one on screen -- the offline
 * banner and the AI panel's own warning are both `status` -- so a notice is always
 * looked for by what it says.
 */
export function notice(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text });
}

export async function drawerTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
}
