import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { FLOWS } from './harness';
import { openFlow, readFlow, shoot, THEMES, useEditorLayout, useTheme } from './helpers';

/*
 * The AI builder panel (F5), against the real server.
 *
 * The chat route is the one route that streams, and it is the one thing here that is
 * scripted: this machine has no key, and a fulfilled `page.route` would hand the browser
 * the whole body at once -- the point of the panel is what it looks like while the answer
 * is still arriving. So `window.fetch` is replaced for that one URL and fed the events
 * over time, each frame cut in two so the client's parser meets a split line, which is
 * what a socket really does. Everything else on the page is the real server.
 *
 * The last test is the opposite: the real route, with no key, which is where most people
 * meet this panel for the first time.
 */

const ANSWER = [
  'Widening the farm is the change worth making here.\n\n',
  'The farm around `words` had two workers; the file it reads is long enough that\n',
  'eight keeps the sink busy.\n\n',
  '```python\ntq.farm(words, 8, ordered=True)\n```\n\n',
  '- `check_flow` passed: **6 nodes, 6 edges**\n',
  '- the sample ran in 0.4 s\n',
];

function turn(source: string, model: unknown, graph: unknown): unknown[] {
  return [
    ...ANSWER.map((delta) => ({ type: 'text', delta })),
    { type: 'tool', name: 'write_flow', status: 'started', summary: '38 lines' },
    { type: 'tool', name: 'write_flow', status: 'done', summary: 'wrote flow.py', error: false },
    { type: 'tool', name: 'check_flow', status: 'started', summary: '{}' },
    {
      type: 'tool',
      name: 'check_flow',
      status: 'done',
      summary: 'OK: 6 nodes, 6 edges',
      error: false,
    },
    { type: 'tool', name: 'run_flow', status: 'started', summary: '{"use_sample_file": true}' },
    {
      type: 'tool',
      name: 'run_flow',
      status: 'done',
      summary: 'ran in 0.4 s, 12 items out',
      error: false,
    },
    { type: 'flow', source, model, graph },
    {
      type: 'done',
      ok: true,
      summary: 'Widened the farm to eight workers.',
      usage: { input_tokens: 4210, output_tokens: 980 },
    },
  ];
}

/** Feed `/api/ai/chat` the given events, one every `gap` milliseconds, in two pieces. */
async function scriptStream(page: Page, events: unknown[], gap = 120): Promise<void> {
  await page.addInitScript((raw: string) => {
    const script = JSON.parse(raw) as { events: unknown[]; gap: number };
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
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
  }, JSON.stringify({ events, gap }));
}

/** The flow the scripted builder claims to have written, parsed by the real server. */
async function widerFarm(request: APIRequestContext): Promise<{
  source: string;
  model: unknown;
  graph: unknown;
}> {
  const source = (await readFlow(FLOWS.words)).replace(
    'tq.farm(words, 2)',
    'tq.farm(words, 8, ordered=True)',
  );
  const answer = await request.post('/api/flows/parse', {
    data: { source, name: FLOWS.words },
  });
  const parsed = (await answer.json()) as { model: unknown; graph: unknown };
  return { source, model: parsed.model, graph: parsed.graph };
}

async function openPanel(page: Page, flow: string): Promise<void> {
  await openFlow(page, flow);
  await page.getByRole('button', { name: 'AI builder' }).first().click();
  await expect(page.getByLabel('Ask the AI builder')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await useTheme(page, 'dark');
  await useEditorLayout(page);
});

for (const theme of THEMES) {
  test(`streams an answer, shows its tools and applies the flow (${theme})`, async ({
    page,
    request,
  }) => {
    const written = await widerFarm(request);
    await scriptStream(page, turn(written.source, written.model, written.graph));
    await useTheme(page, theme);
    await openPanel(page, FLOWS.hello);

    // The empty panel says what the builder does before it is asked anything.
    await expect(page.getByText('Change this flow by asking')).toBeVisible();

    await page.getByLabel('Ask the AI builder').fill('make it faster');
    await page.keyboard.press('Enter');

    // Mid-stream: the words are arriving and the turn can still be stopped.
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByText(/Widening the farm/)).toBeVisible();
    await shoot(page, `ai-streaming-${theme}`);

    // Every tool call appears as it happens.
    await expect(page.getByText('Wrote the flow')).toBeVisible();
    await expect(page.getByText('Checked the wiring')).toBeVisible();
    await expect(page.getByText('OK: 6 nodes, 6 edges')).toBeVisible();
    await expect(page.getByText('Ran it on a sample')).toBeVisible();

    // The fenced block is a code block, not a paragraph full of backticks.
    await expect(page.getByText('tq.farm(words, 8, ordered=True)')).toBeVisible();

    const apply = page.getByRole('button', { name: 'Apply to editor' });
    await expect(apply).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
    await shoot(page, `ai-flow-card-${theme}`);

    // The diff is written here, against the source on the canvas.
    await page.getByRole('button', { name: 'Show diff' }).click();
    await expect(page.getByRole('region', { name: 'What the builder changed' })).toBeVisible();
    await shoot(page, `ai-diff-${theme}`);
    await page.getByRole('button', { name: 'Hide diff' }).click();

    // Applying puts it on the canvas and leaves the file to be saved.
    await expect(page.getByText('double').first()).toBeVisible();
    await apply.click();
    await expect(page.getByText('words farm').first()).toBeVisible();
    await expect(page.getByText('unsaved changes')).toBeVisible();
    await shoot(page, `ai-applied-${theme}`);
  });
}

test('stops a turn that is still arriving', async ({ page, request }) => {
  const written = await widerFarm(request);
  await scriptStream(page, turn(written.source, written.model, written.graph), 400);
  await openPanel(page, FLOWS.hello);
  await page.getByLabel('Ask the AI builder').fill('make it faster');
  await page.keyboard.press('Enter');

  await expect(page.getByText(/Widening the farm/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Stopped.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask' })).toBeVisible();
  // Nothing arrived after the stop.
  await expect(page.getByRole('button', { name: 'Apply to editor' })).toBeHidden();
});

test('keeps a thread per flow', async ({ page }) => {
  await scriptStream(page, [
    { type: 'text', delta: 'This one counts words.' },
    { type: 'done', ok: true, summary: 'Explained.' },
  ]);
  await openPanel(page, FLOWS.hello);
  await page.getByLabel('Ask the AI builder').fill('explain this flow');
  await page.keyboard.press('Enter');
  await expect(page.getByText('This one counts words.')).toBeVisible();

  // In the app, not through a reload: the conversation lives for the session.
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await sections.getByRole('link', { name: 'Flows' }).click();
  await page.getByRole('link', { name: 'word_count' }).click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await expect(page.getByLabel('Ask the AI builder')).toBeVisible();
  await expect(page.getByText('This one counts words.')).toBeHidden();

  await sections.getByRole('link', { name: 'Flows' }).click();
  await page.getByRole('link', { name: 'hello' }).click();
  await expect(page.getByText('This one counts words.')).toBeVisible();
});

test('offers the quick actions, and one of them fills the composer', async ({ page }) => {
  await scriptStream(page, [{ type: 'done', ok: true, summary: '' }]);
  await openPanel(page, FLOWS.hello);
  await expect(page.getByRole('button', { name: 'Explain this flow' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a stage that…' }).click();
  await expect(page.getByLabel('Ask the AI builder')).toHaveValue('Add a stage that ');
});

test('the palette opens the panel on the flow that is open', async ({ page }) => {
  await openFlow(page, FLOWS.hello);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('button', { name: 'Build a flow with the AI builder…' }).click();
  await expect(page.getByLabel('Ask the AI builder')).toBeVisible();
});

test('says which key is missing, and where to put it', async ({ page }) => {
  // No script here: the real route, on a server started with no key at all.
  await openPanel(page, FLOWS.hello);
  await expect(page.getByText(/No anthropic key yet/)).toBeVisible();

  await page.getByLabel('Ask the AI builder').fill('explain this flow');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/ANTHROPIC_API_KEY/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open settings' })).toBeVisible();
  await shoot(page, 'ai-no-key-panel');
});
