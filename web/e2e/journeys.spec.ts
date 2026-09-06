import { rm } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { FLOWS } from './harness';
import {
  drawerTab,
  flowFile,
  notice,
  openFlow,
  readFlow,
  runButton,
  shoot,
  useEditorLayout,
  useTheme,
  waitForRun,
  writeFlow,
} from './helpers';

/*
 * The five journeys of docs/web.md, end to end through the real server.
 *
 * They are one story told in order, on a flow this file makes and takes away again:
 * draw it from the palette, run it on a sample, look at what crossed an edge, ask the
 * builder to change it, and put it on a schedule. Everything except the builder's answer
 * -- which needs a key this machine does not have -- is the real thing: a file on disk,
 * a child process, a WebSocket, a row in the database.
 *
 * `serial` because they are steps, not cases: step 3 has nothing to say if step 1 never
 * drew the flow, and reporting five failures for one cause helps nobody.
 */

const FLOW = 'journey.py';
const SAMPLE = 'three numbers';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
  await useEditorLayout(page);
});

test.afterAll(async () => {
  await rm(flowFile(FLOW), { force: true });
  await rm(flowFile('journey.layout.json'), { force: true });
});

/** The events one scripted turn of the builder sends, ending in a flow to apply. */
function builderTurn(source: string, model: unknown, graph: unknown): unknown[] {
  return [
    { type: 'text', delta: 'Widening the farm is the change worth making here.\n\n' },
    { type: 'text', delta: 'Three workers was the number you drew; eight keeps the sink busy.\n' },
    { type: 'tool', name: 'write_flow', status: 'started', summary: '24 lines' },
    { type: 'tool', name: 'write_flow', status: 'done', summary: 'wrote journey.py', error: false },
    { type: 'tool', name: 'check_flow', status: 'started', summary: '{}' },
    {
      type: 'tool',
      name: 'check_flow',
      status: 'done',
      summary: 'OK: 5 nodes, 4 edges',
      error: false,
    },
    { type: 'flow', source, model, graph },
    { type: 'done', ok: true, summary: 'Widened the farm to eight workers.' },
  ];
}

/**
 * Answer `/api/ai/chat` with the given events, a little apart, each frame cut in two.
 *
 * There is no key on this machine, and a fulfilled `page.route` would hand the browser
 * the whole body at once -- and the point of the panel is what it looks like while the
 * answer is still arriving. So the one route is scripted over `window.fetch` instead,
 * with the split lines a socket really produces.
 */
async function scriptBuilder(page: Page, events: unknown[]): Promise<void> {
  await page.addInitScript(
    (raw: string) => {
      const script = JSON.parse(raw) as { events: unknown[]; gap: number };
      const original = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('/api/ai/chat')) return original(input, init);
        const encoder = new TextEncoder();
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            let index = 0;
            let closed = false;
            const stop = (): void => {
              if (closed) return;
              closed = true;
              controller.error(new DOMException('aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', stop);
            const push = (): void => {
              if (closed) return;
              if (signal?.aborted) {
                stop();
                return;
              }
              if (index >= script.events.length) {
                closed = true;
                controller.close();
                return;
              }
              const frame = `data: ${JSON.stringify(script.events[index])}\n\n`;
              const cut = Math.max(1, Math.floor(frame.length / 2));
              controller.enqueue(encoder.encode(frame.slice(0, cut)));
              window.setTimeout(() => {
                if (!closed) controller.enqueue(encoder.encode(frame.slice(cut)));
              }, 10);
              index += 1;
              window.setTimeout(push, script.gap);
            };
            window.setTimeout(push, script.gap);
          },
        });
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        );
      };
    },
    JSON.stringify({ events, gap: 90 }),
  );
}

// ----------------------------------------------------------- 1. draw a flow

test('a flow drawn from the palette, saved as Python', async ({ page }) => {
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow' }).click();

  const dialog = page.getByRole('dialog', { name: 'New flow' });
  await dialog.getByLabel('Name').fill('journey');
  await expect(dialog.getByText(FLOW)).toBeVisible();
  await dialog.getByRole('radio', { name: /Hello/ }).click();
  await shoot(page, 'journey-1-new');
  await dialog.getByRole('button', { name: 'Create flow' }).click();

  // The editor opens on the new file: a source, a farm holding its worker, and a sink.
  await expect(page).toHaveURL(new RegExp(`/flows/${FLOW.replace('.', '\\.')}$`));
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await expect(page.getByText('numbers').first()).toBeVisible();
  await expect(page.getByText('double farm').first()).toBeVisible();
  await expect(page.getByText('show').first()).toBeVisible();

  // The farm's options, in the panel that opens with the card that is selected.
  await page.getByText('double farm').first().click();
  await page.getByLabel('How many').fill('3');
  await page.getByLabel('Ordered').setChecked(true);
  await expect(page.getByText('tq.farm · 3 workers').first()).toBeVisible();
  await expect(page.getByText('unsaved changes')).toBeVisible();

  // A stage from the palette lands before the sink: a block on the canvas is a block in
  // the file, so this also writes the node's Python.
  await page.getByRole('button', { name: 'Node', exact: true }).click();
  await expect(page.getByText('stage').first()).toBeVisible();
  await page.waitForTimeout(400);
  await shoot(page, 'journey-1-drawn');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(notice(page, 'Saved')).toBeVisible();

  // The artifact is the file, so that is what is checked.
  const written = await readFlow(FLOW);
  expect(written).toContain('def stage(');
  expect(written).toContain('tq.farm(double, 3, ordered=True)');
  expect(written).toContain('>> stage >> show');
});

// ------------------------------------------------- 2. run it, read the report

test('run on a sample, with the report it produced', async ({ page }) => {
  await openFlow(page, FLOW);

  // A sample stands in for the flow's own source: three items, saved with the flow.
  await page.getByRole('button', { name: 'Run options' }).click();
  await page.getByRole('button', { name: 'Manage samples' }).click();
  const samples = page.getByRole('dialog', { name: 'Samples' });
  await expect(samples).toBeVisible();
  await samples.getByRole('button', { name: 'Add a sample' }).click();
  await samples.getByLabel('Name').fill(SAMPLE);
  await samples.getByLabel('Items').fill('11\n22\n33');
  await shoot(page, 'journey-2-samples');
  await samples.getByRole('button', { name: 'Save samples' }).click();
  await expect(samples).toBeHidden();

  await page.getByRole('button', { name: 'Run options' }).click();
  await page.getByLabel('Input').selectOption(SAMPLE);
  await page.keyboard.press('Escape');

  await runButton(page).click();
  await waitForRun(page, 'done');

  // Every card ends done, and the sink printed the sample doubled by the farm.
  await expect(page.locator('[data-state="done"]').first()).toBeVisible();
  await expect(page.getByRole('log', { name: 'Run output' })).toContainText('66');
  await shoot(page, 'journey-2-run');

  await drawerTab(page, 'Report');
  await expect(page.getByRole('columnheader', { name: 'Busy %' })).toBeVisible();
  await expect(page.getByText('busiest').first()).toBeVisible();
  await shoot(page, 'journey-2-report');
});

// ------------------------------------------------------ 3. items in a tap

test('the items that crossed each edge', async ({ page }) => {
  await openFlow(page, FLOW);
  await runButton(page).click();
  await waitForRun(page, 'done');

  await drawerTab(page, 'Taps');
  const edges = page.getByRole('listbox', { name: 'Edges' });
  await expect(edges).toBeVisible();
  await edges.getByRole('option').first().click();
  await expect(page.getByText('Last items')).toBeVisible();
  await shoot(page, 'journey-3-taps');
});

// ------------------------------------------------- 4. ask the builder, apply

test('the builder is asked for a change, and it is applied', async ({ page, request }) => {
  const source = (await readFlow(FLOW)).replace('tq.farm(double, 3', 'tq.farm(double, 8');
  // The builder's answer carries the flow it wrote, parsed. The server does that parsing
  // for real -- it is the same route the code view uses -- so only the words are scripted.
  const parsed = await request.post('/api/flows/parse', { data: { source, name: FLOW } });
  expect(parsed.ok()).toBe(true);
  const flow = (await parsed.json()) as { model: unknown; graph: unknown };
  await scriptBuilder(page, builderTurn(source, flow.model, flow.graph));
  await openFlow(page, FLOW);

  await page.getByRole('button', { name: 'AI builder' }).first().click();
  await expect(page.getByLabel('Ask the AI builder')).toBeVisible();
  await expect(page.getByText('Change this flow by asking')).toBeVisible();

  await page.getByLabel('Ask the AI builder').fill('make it faster');
  await page.keyboard.press('Enter');

  await expect(page.getByText(/Widening the farm/)).toBeVisible();
  await expect(page.getByText('Wrote the flow')).toBeVisible();
  await expect(page.getByText('OK: 5 nodes, 4 edges')).toBeVisible();
  await shoot(page, 'journey-4-answer');

  const apply = page.getByRole('button', { name: 'Apply to editor' });
  await expect(apply).toBeVisible();
  await apply.click();

  // It is on the canvas and not yet on disk: applying is an edit, like any other.
  await expect(page.getByText('tq.farm · 8 workers').first()).toBeVisible();
  await expect(page.getByText('unsaved changes')).toBeVisible();
  await shoot(page, 'journey-4-applied');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(notice(page, 'Saved')).toBeVisible();
  expect(await readFlow(FLOW)).toContain('tq.farm(double, 8');
});

// -------------------------------------------------------- 5. schedule it

test('put on a schedule, with the next times it will run', async ({ page }) => {
  await openFlow(page, FLOW);

  // From the command palette, which is where a flow that is open gets scheduled.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('button', { name: 'Schedule this flow…' }).click();

  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Flow')).toHaveValue(FLOW);
  await dialog.getByRole('button', { name: 'Weekdays' }).click();
  await expect(dialog.getByLabel('Cron expression')).toHaveValue('0 9 * * 1-5');
  await expect(dialog.getByText('at 09:00, Monday to Friday')).toBeVisible();
  await shoot(page, 'journey-5-dialog');
  await dialog.getByRole('button', { name: 'Create schedule' }).click();

  await expect(notice(page, `Scheduled ${FLOW}`)).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: FLOW });
  await expect(row).toContainText('at 09:00, Monday to Friday');
  await expect(row.getByText(/\d{1,2}:\d{2}/).first()).toBeVisible();
  await shoot(page, 'journey-5-listed');

  // And taken away again, so the next run of the suite starts where this one did.
  await page.getByRole('button', { name: `Delete the schedule for ${FLOW}` }).click();
  await page.getByRole('button', { name: 'Delete schedule' }).click();
  await expect(notice(page, 'Deleted the schedule')).toBeVisible();
});

// ---------------------------------------------------- 6. the code round trip

test('the code round trip: edit the text, the canvas follows, save', async ({ page }) => {
  const original = await readFlow(FLOWS.words);
  try {
    await openFlow(page, FLOWS.words);
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await expect(page.getByText('Canvas in sync')).toBeVisible();
    await shoot(page, 'journey-6-code');

    // Replace the whole file the way a person would: select everything, then type.
    const file = page.locator('[aria-label="Flow source"] .cm-content');
    await file.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(original.replace('tq.farm(words, 2)', 'tq.farm(words, 6)'));

    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await expect(page.getByText('tq.farm · 6 workers').first()).toBeVisible({ timeout: 20_000 });
    await shoot(page, 'journey-6-canvas');

    await page.keyboard.press('ControlOrMeta+s');
    await expect(notice(page, 'Saved')).toBeVisible();
    expect(await readFlow(FLOWS.words)).toBe(
      original.replace('tq.farm(words, 2)', 'tq.farm(words, 6)'),
    );
  } finally {
    await writeFlow(FLOWS.words, original);
  }
});
