import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowSummary } from '../api/flowsList';
import type { Schedule } from '../api/schedules';
import { ScheduleDialog, type ScheduleFormValues } from './ScheduleDialog';

/* The dialog against the routes it reads: the flow's model for the parameters it takes,
 * the settings for the default webhook, and the test route for "Send a test". */

interface Reply {
  status?: number;
  body: unknown;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function serve(routes: Record<string, () => Reply>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      const route = routes[key];
      const reply: Reply = route
        ? route()
        : { status: 404, body: { error: { type: 'KeyError', message: `no route for ${key}` } } };
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

const FLOWS: FlowSummary[] = [
  {
    path: 'params.py',
    name: 'params',
    modified: '2026-09-06T10:00:00Z',
    size: 800,
    has_layout: false,
    last_run: null,
  },
];

const MODEL = {
  version: 1,
  name: 'params',
  doc: null,
  prelude: [],
  nodes: [],
  flow: { type: 'pipeline', stages: [] },
  start: null,
  params: [
    { name: 'factor', default: '2', annotation: 'int' },
    { name: 'label', default: '"x"', annotation: 'str' },
  ],
  main: null,
  epilogue: [],
  build_notes: [],
  guard: null,
};

const SETTINGS = {
  workspace: '/w',
  default_runtime: 'threads',
  default_batch: 32,
  exec_timeout: 30,
  max_concurrent_runs: 4,
  max_source_bytes: 1000,
  cancel_grace: 10,
  keep_traces_days: 7,
  theme: 'dark',
  python: '/usr/bin/python3',
  auto_commit: false,
  env: {},
  env_names: [],
  notifications: {
    webhook_default: 'https://hooks.example.com/default',
    smtp: null,
    has_smtp_password: false,
  },
  ai: { provider: 'anthropic', model: null, has_anthropic_key: false, has_openai_key: false },
  server: { host: '127.0.0.1', port: 8765, token_set: false },
};

const ROUTES = {
  'GET /api/settings': () => ({ body: SETTINGS }),
  'GET /api/flows/params.py': () => ({
    body: {
      path: 'params.py',
      source: '',
      modified: '2026-09-06T10:00:00Z',
      model: MODEL,
      code_only: null,
      graph: null,
      layout: null,
    },
  }),
  'POST /api/schedules/preview': () => ({
    body: { description: 'every 5 minutes', next_five: [] },
  }),
};

const SCHEDULE: Schedule = {
  id: 7,
  flow: 'params.py',
  cron: '*/5 * * * *',
  sample: null,
  runtime: 'threads',
  enabled: true,
  created: '2026-09-01T08:00:00Z',
  user: 'local',
  last_run: 3,
  last_status: 'failed',
  next_run: null,
  params: { factor: 9 },
  env: { GREETING: 'hello' },
  notify: { events: ['failed'], webhook: null, emails: ['ops@example.com'] },
  retries: 2,
  retry_delay: 30,
  last_outcome: { status: 'failed', attempts: 3, notified: true },
};

function open(props: Partial<Parameters<typeof ScheduleDialog>[0]> = {}): {
  submitted: ScheduleFormValues[];
} {
  const submitted: ScheduleFormValues[] = [];
  render(
    <ScheduleDialog
      mode="create"
      flows={FLOWS}
      debounceMs={0}
      onSubmit={(values) => {
        submitted.push(values);
        return Promise.resolve();
      }}
      onClose={() => undefined}
      {...props}
    />,
  );
  return { submitted };
}

describe('the schedule dialog’s inputs', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    serve(ROUTES);
  });

  it('shows a field for every parameter the chosen flow declares', async () => {
    open();
    expect(await screen.findByLabelText('factor')).toHaveValue('2');
    expect(screen.getByLabelText('label')).toHaveValue('x');
  });

  it('sends the parameters and the environment it was given', async () => {
    const user = userEvent.setup();
    const { submitted } = open();

    await user.clear(await screen.findByLabelText('factor'));
    await user.type(screen.getByLabelText('factor'), '9');
    await user.click(screen.getByRole('button', { name: 'Add a variable' }));
    await user.type(screen.getByLabelText('Variable 1 name'), 'GREETING');
    await user.type(screen.getByLabelText('Value of GREETING'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.params).toEqual({ factor: 9, label: 'x' });
    expect(submitted[0]?.env).toEqual({ GREETING: 'hello' });
  });

  it('fills the fields from the schedule it is editing', async () => {
    open({ mode: 'edit', initial: SCHEDULE });
    expect(await screen.findByLabelText('factor')).toHaveValue('9');
    expect(screen.getByLabelText('Value of GREETING')).toHaveValue('hello');
  });
});

describe('the outcomes section', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    serve(ROUTES);
  });

  it('shows the default webhook from settings while "use the default" is on', async () => {
    open();
    expect(await screen.findByLabelText('Webhook')).toBeDisabled();
    expect(
      screen.getByText(/The default from Settings: https:\/\/hooks.example.com\/default/),
    ).toBeInTheDocument();
  });

  it('takes a webhook of its own once the default is turned off', async () => {
    const user = userEvent.setup();
    const { submitted } = open();

    await user.click(await screen.findByRole('checkbox', { name: 'Use the default' }));
    await user.type(screen.getByLabelText('Webhook'), 'https://example.com/hook');
    await user.click(screen.getByRole('switch', { name: 'Failed' }));
    await user.type(screen.getByLabelText('Email'), 'ops@example.com');
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.notify).toEqual({
      events: ['failed'],
      webhook: 'https://example.com/hook',
      emails: ['ops@example.com'],
    });
  });

  it('keeps the four events in the server’s order however they are clicked', async () => {
    const user = userEvent.setup();
    const { submitted } = open();
    await user.click(await screen.findByRole('switch', { name: 'Done' }));
    await user.click(screen.getByRole('switch', { name: 'Failed' }));
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.notify.events).toEqual(['failed', 'done']);
  });

  it('refuses an address that is not one', async () => {
    const user = userEvent.setup();
    const { submitted } = open();
    await user.type(await screen.findByLabelText('Email'), 'nobody');
    expect(screen.getByText('Not an email address: nobody')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));
    expect(submitted).toHaveLength(0);
  });

  it('sends the retries and the delay it was set to', async () => {
    const user = userEvent.setup();
    const { submitted } = open();
    await user.selectOptions(await screen.findByLabelText('Retries'), '3');
    await user.clear(screen.getByLabelText('Wait between them'));
    await user.type(screen.getByLabelText('Wait between them'), '90');
    await user.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.retries).toBe(3);
    expect(submitted[0]?.retry_delay).toBe(90);
  });

  it('has no test button until the schedule exists, then shows what each channel said', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByLabelText('Webhook');
    expect(screen.queryByRole('button', { name: 'Send a test' })).not.toBeInTheDocument();

    vi.unstubAllGlobals();
    serve({
      ...ROUTES,
      'POST /api/schedules/7/test': () => ({
        body: {
          results: [
            { channel: 'webhook', target: 'https://example.com/hook', status: 'sent', error: null },
            {
              channel: 'email',
              target: 'ops@example.com',
              status: 'failed',
              error: 'no SMTP server is set',
            },
          ],
        },
      }),
    });
    render(
      <ScheduleDialog
        mode="edit"
        initial={SCHEDULE}
        flows={FLOWS}
        debounceMs={0}
        onSubmit={() => Promise.resolve()}
        onClose={() => undefined}
      />,
    );
    const test = await screen.findByRole('button', { name: 'Send a test' });
    await user.click(test);

    const sent = await screen.findByText('webhook · https://example.com/hook');
    expect(sent).toBeInTheDocument();
    expect(screen.getByText('no SMTP server is set')).toBeInTheDocument();
  });

  it('shows the server’s refusal when a test cannot be sent', async () => {
    const user = userEvent.setup();
    serve({
      ...ROUTES,
      'POST /api/schedules/7/test': () => ({
        status: 400,
        body: {
          error: { type: 'BadRequest', message: 'this schedule has nowhere to send a message' },
        },
      }),
    });
    render(
      <ScheduleDialog
        mode="edit"
        initial={SCHEDULE}
        flows={FLOWS}
        debounceMs={0}
        onSubmit={() => Promise.resolve()}
        onClose={() => undefined}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Send a test' }));
    expect(
      await screen.findByText('this schedule has nowhere to send a message'),
    ).toBeInTheDocument();
  });
});

describe('a flow the model cannot read', () => {
  it('says so instead of showing an empty Parameters section', async () => {
    vi.unstubAllGlobals();
    serve({
      ...ROUTES,
      'GET /api/flows/params.py': () => ({
        body: {
          path: 'params.py',
          source: '',
          modified: '2026-09-06T10:00:00Z',
          model: null,
          code_only: { reason: 'Graph.link' },
          graph: null,
          layout: null,
        },
      }),
    });
    open();
    expect(await screen.findByText(/cannot be modelled/)).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).queryByLabelText('factor')).not.toBeInTheDocument();
  });
});
