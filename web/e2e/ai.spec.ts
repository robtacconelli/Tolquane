import { mkdir, readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/*
 * The AI builder panel (F5).
 *
 * The chat route is the one route that streams, so it is scripted rather than mocked
 * with `page.route`: a fulfilled route hands the browser the whole body at once, and the
 * point of this panel is what it looks like while the answer is still arriving. The
 * script below replaces `window.fetch` for that one URL and feeds the events out over
 * time, each frame cut in two so the client's parser meets a split line, which is what a
 * socket really does. Everything else is answered from the same fixtures the unit tests
 * use, so the panel is exercised through its real load path.
 *
 * The last test needs a real server: `no anthropic key` is the server's own sentence and
 * is not worth inventing here.
 */

const OUT = 'e2e/screenshots';
const THEMES = ['dark', 'light'] as const;
const SERVER = process.env.TOLQUANE_E2E_SERVER ?? 'http://127.0.0.1:8783';

const SETTINGS = {
  workspace: '/home/me/flows',
  default_runtime: 'threads',
  default_batch: 32,
  exec_timeout: 30,
  max_concurrent_runs: 4,
  cancel_grace: 10,
  theme: 'dark',
  ai: {
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    has_anthropic_key: true,
    has_openai_key: false,
  },
  server: { host: '127.0.0.1', port: 8765, token_set: false },
};

const FIXTURES: Record<string, string> = {
  'hello.py': 'hello.json',
  'word_count.py': 'word_count.json',
};

async function fixture(name: string): Promise<string> {
  return readFile(`src/test/fixtures/${FIXTURES[name] ?? 'hello.json'}`, 'utf8');
}

async function serveFixtures(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname.replace(/^\/api\//, ''));
    if (path === 'health') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, version: '1.1.0', workspace: '/home/me/flows' }),
      });
      return;
    }
    if (path === 'settings') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(SETTINGS) });
      return;
    }
    if (path === 'flows') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          workspace: '/home/me/flows',
          flows: Object.keys(FIXTURES).map((flow) => ({
            path: flow,
            name: flow.replace(/\.py$/, ''),
            modified: '2026-09-05T10:00:00Z',
            size: 900,
            has_layout: false,
            last_run: null,
          })),
        }),
      });
      return;
    }
    if (path.startsWith('flows/')) {
      const flow = path.slice('flows/'.length);
      if (FIXTURES[flow]) {
        await route.fulfill({ contentType: 'application/json', body: await fixture(flow) });
        return;
      }
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

async function useTheme(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    'tolquane.theme',
    theme,
  ] as const);
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
              if (closed) return;
              controller.enqueue(encoder.encode(frame.slice(cut)));
            }, 10);
            index += 1;
            window.setTimeout(push, script.gap);
          };
          window.setTimeout(push, script.gap);
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    };
  }, JSON.stringify({ events, gap }));
}

const ANSWER = [
  'Widening the farm is the change worth making here.\n\n',
  'The farm around `words` had two workers; the file it reads is long enough that\n',
  'eight keeps the sink busy.\n\n',
  '```python\ntq.farm(words, 8, ordered=True)\n```\n\n',
  '- `check_flow` passed: **6 nodes, 6 edges**\n',
  '- the sample ran in 0.4 s\n',
];

/** The events of one turn, with the flow taken from the word_count fixture. */
async function turn(): Promise<unknown[]> {
  const written = JSON.parse(await fixture('word_count.py')) as {
    source: string;
    model: unknown;
    graph: unknown;
  };
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
    { type: 'flow', source: written.source, model: written.model, graph: written.graph },
    {
      type: 'done',
      ok: true,
      summary: 'Widened the farm to eight workers.',
      usage: { input_tokens: 4210, output_tokens: 980 },
    },
  ];
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
}

async function openPanel(page: Page, flow = 'hello.py'): Promise<void> {
  await page.goto(`/flows/${flow}`);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await page.getByRole('button', { name: 'AI builder' }).click();
  await expect(page.getByLabel('Ask the AI builder')).toBeVisible();
}

/** The two tests below need a real server; the rest are answered from the fixtures. */
let up = false;

test.beforeAll(async ({ request }) => {
  await mkdir(OUT, { recursive: true });
  try {
    up = (await request.get(`${SERVER}/api/health`, { timeout: 3000 })).ok();
  } catch {
    up = false;
  }
});

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await serveFixtures(page);
      await useTheme(page, theme);
    });

    test('streams an answer, shows its tools and applies the flow it wrote', async ({ page }) => {
      await scriptStream(page, await turn());
      await openPanel(page);

      // The empty panel says what the builder does before it is asked anything.
      await expect(page.getByText('Change this flow by asking')).toBeVisible();
      await expect(page.getByText('claude-opus-4-5')).toBeVisible();

      await page.getByLabel('Ask the AI builder').fill('make it faster');
      await page.keyboard.press('Enter');

      // Mid-stream: the words are arriving and the turn can still be stopped.
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
      await expect(page.getByText(/Widening the farm/)).toBeVisible();
      await shoot(page, `${theme}-ai-streaming`);

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
      await shoot(page, `${theme}-ai-flow-card`);

      // The diff is written here, against the source on the canvas.
      await page.getByRole('button', { name: 'Show diff' }).click();
      await expect(page.getByRole('region', { name: 'What the builder changed' })).toBeVisible();
      await shoot(page, `${theme}-ai-diff`);
      await page.getByRole('button', { name: 'Hide diff' }).click();

      // Applying puts it on the canvas and leaves the file to be saved.
      await expect(page.getByText('double').first()).toBeVisible();
      await apply.click();
      await expect(page.getByText('words farm').first()).toBeVisible();
      await expect(page.getByText('unsaved changes')).toBeVisible();
      await expect(page.getByText(/On the canvas/)).toBeVisible();
      await shoot(page, `${theme}-ai-applied`);
    });

    test('says which key is missing, and where to put it', async ({ page }) => {
      test.skip(!up, `no Tolquane server on ${SERVER}`);
      // The real server, which has no key on this machine and says so itself.
      await page.unroute('**/api/**');
      await page.goto(`${SERVER}/flows/hello.py`);
      await expect(page.getByRole('button', { name: 'AI builder' })).toBeVisible();
      await page.getByRole('button', { name: 'AI builder' }).click();

      await expect(page.getByText(/No anthropic key yet/)).toBeVisible();
      await page.getByLabel('Ask the AI builder').fill('explain this flow');
      await page.keyboard.press('Enter');

      await expect(page.getByText(/ANTHROPIC_API_KEY/)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open settings' })).toBeVisible();
      await shoot(page, `${theme}-ai-no-key`);
    });
  });
}

test.describe('the panel on its own', () => {
  test.beforeEach(async ({ page }) => {
    await serveFixtures(page);
    await useTheme(page, 'dark');
  });

  test('stops a turn that is still arriving', async ({ page }) => {
    await scriptStream(page, await turn(), 400);
    await openPanel(page);
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
    await openPanel(page);
    await page.getByLabel('Ask the AI builder').fill('explain this flow');
    await page.keyboard.press('Enter');
    await expect(page.getByText('This one counts words.')).toBeVisible();

    // In the app, not through a reload: the conversation lives for the session.
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Flows' })
      .click();
    await page.getByRole('link', { name: 'word_count' }).click();
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    await expect(page.getByLabel('Ask the AI builder')).toBeVisible();
    await expect(page.getByText('This one counts words.')).toBeHidden();

    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Flows' })
      .click();
    await page.getByRole('link', { name: 'hello' }).click();
    await expect(page.getByText('This one counts words.')).toBeVisible();
  });

  test('offers the quick actions, and one of them fills the composer', async ({ page }) => {
    await scriptStream(page, [{ type: 'done', ok: true, summary: '' }]);
    await openPanel(page);
    await expect(page.getByRole('button', { name: 'Explain this flow' })).toBeVisible();
    await page.getByRole('button', { name: 'Add a stage that…' }).click();
    await expect(page.getByLabel('Ask the AI builder')).toHaveValue('Add a stage that ');
  });

  test('the palette opens the panel on the flow that is open', async ({ page }) => {
    await page.goto('/flows/hello.py');
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('button', { name: 'Build a flow with the AI builder…' }).click();
    await expect(page.getByLabel('Ask the AI builder')).toBeVisible();
  });
});
