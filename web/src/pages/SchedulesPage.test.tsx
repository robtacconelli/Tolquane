import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowSummary } from '../api/flowsList';
import type { ScheduleRow } from '../api/schedules';
import { SchedulesPage } from './SchedulesPage';

/* The server is being built next door, so every test here is the contract of
 * docs/web-interfaces.md, S4, answered by hand. */

interface Reply {
  status?: number;
  body: unknown;
}

type Route = (body: unknown) => Reply;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const seen: { key: string; body: unknown }[] = [];

function serve(routes: Record<string, Route>): void {
  seen.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(urlOf(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      seen.push({ key, body });
      const route = routes[key];
      const reply: Reply = route
        ? route(body)
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

function bodyOf(key: string): unknown {
  return seen.find((call) => call.key === key)?.body;
}

const NEXT_FIVE = [
  '2026-09-06T12:15:00Z',
  '2026-09-06T12:30:00Z',
  '2026-09-06T12:45:00Z',
  '2026-09-06T13:00:00Z',
  '2026-09-06T13:15:00Z',
];

const DESCRIPTIONS: Record<string, string> = {
  '*/5 * * * *': 'every 5 minutes',
  '0 * * * *': 'every hour, on the hour',
  '*/15 * * * *': 'every 15 minutes',
};

const ROWS: ScheduleRow[] = [
  {
    id: 1,
    flow: 'reports/word_count.py',
    cron: '*/15 * * * *',
    sample: null,
    runtime: 'threads',
    enabled: true,
    created: '2026-09-01T08:00:00Z',
    last_run: 12,
    last_status: 'done',
    next_run: '2026-09-06T12:15:00Z',
    user: 'local',
    params: {},
    env: {},
    notify: { events: [], webhook: null, emails: [] },
    retries: 0,
    retry_delay: 60,
    last_outcome: null,
    description: 'every 15 minutes',
    next_five: NEXT_FIVE,
  },
  {
    id: 2,
    flow: 'nightly_etl.py',
    cron: '0 2 * * *',
    sample: 'small',
    runtime: 'processes',
    enabled: false,
    created: '2026-08-20T08:00:00Z',
    last_run: 9,
    last_status: 'failed',
    next_run: null,
    user: 'local',
    params: { factor: 3 },
    env: { TZ: 'UTC' },
    notify: { events: ['failed', 'done'], webhook: null, emails: ['ops@example.com'] },
    retries: 2,
    retry_delay: 30,
    last_outcome: { status: 'failed', attempts: 3, notified: true },
    description: 'at 2:00 every day',
    next_five: [],
  },
];

const FLOWS: FlowSummary[] = [
  {
    path: 'hello.py',
    name: 'hello',
    modified: '2026-09-05T10:00:00Z',
    size: 512,
    has_layout: true,
    last_run: null,
  },
  {
    path: 'reports/word_count.py',
    name: 'word_count',
    modified: '2026-09-05T10:00:00Z',
    size: 900,
    has_layout: false,
    last_run: null,
  },
];

const flowsRoute: Route = () => ({ body: { workspace: '/home/me/flows', flows: FLOWS } });

const previewRoute: Route = (body) => {
  const cron = (body as { cron?: string }).cron ?? '';
  if (!/^[\d*/,\-\s]+$/.test(cron) || cron.startsWith('99')) {
    return {
      status: 400,
      body: { error: { type: 'ValueError', message: `minute field out of range: ${cron}` } },
    };
  }
  return { body: { description: DESCRIPTIONS[cron] ?? `on ${cron}`, next_five: NEXT_FIVE } };
};

describe('the schedules page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows every schedule with its expression in English', async () => {
    serve({
      'GET /api/schedules': () => ({ body: { schedules: ROWS } }),
      'GET /api/flows': flowsRoute,
    });
    render(<SchedulesPage />);

    expect(await screen.findByText('reports/word_count.py')).toBeInTheDocument();
    expect(screen.getByText('*/15 * * * *')).toBeInTheDocument();
    expect(screen.getByText('every 15 minutes')).toBeInTheDocument();
    expect(screen.getByText('at 2:00 every day')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    // A disabled schedule says so where its next time would have been.
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'Disable the schedule for reports/word_count.py' }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: 'Enable the schedule for nightly_etl.py' }),
    ).not.toBeChecked();
  });

  it('rings a bell on the schedule that tells somebody, and says how it went', async () => {
    serve({
      'GET /api/schedules': () => ({ body: { schedules: ROWS } }),
      'GET /api/flows': flowsRoute,
    });
    render(<SchedulesPage />);

    await screen.findByText('nightly_etl.py');
    // One of the two notifies; the other has no events, so it has no bell.
    const bells = screen.getAllByRole('img', { name: /Notifications on for/ });
    expect(bells).toHaveLength(1);
    expect(bells[0]).toHaveAccessibleName('Notifications on for nightly_etl.py');
    expect(bells[0]).toHaveAttribute(
      'title',
      'Notifies on failed, done — the default webhook and ops@example.com',
    );

    // The outcome of the last firing: how many tries it took and that somebody was told.
    expect(screen.getByText('run #9 · 3 tries · notified')).toBeInTheDocument();
    expect(screen.getByText(/2 retries/)).toBeInTheDocument();
  });

  it('offers the empty state when nothing is scheduled', async () => {
    serve({
      'GET /api/schedules': () => ({ body: { schedules: [] } }),
      'GET /api/flows': flowsRoute,
    });
    render(<SchedulesPage />);

    expect(await screen.findByText('No schedules')).toBeInTheDocument();
    // The column header stays: it says what will be here.
    expect(screen.getByText('Next run')).toBeInTheDocument();
  });

  it('says the server is not running when it cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    render(<SchedulesPage />);
    expect(await screen.findByText('The server is not running')).toBeInTheDocument();
  });

  it('creates a schedule after previewing the expression', async () => {
    const user = userEvent.setup();
    let created = false;
    serve({
      'GET /api/schedules': () => ({ body: { schedules: created ? [ROWS[0]] : [] } }),
      'GET /api/flows': flowsRoute,
      'POST /api/schedules/preview': previewRoute,
      'POST /api/schedules': () => {
        created = true;
        return { body: ROWS[0] };
      },
    });
    render(<SchedulesPage />);

    await user.click((await screen.findAllByRole('button', { name: 'New schedule' }))[0]!);
    const dialog = screen.getByRole('dialog', { name: 'New schedule' });

    // The default expression is previewed without a keystroke.
    expect(await within(dialog).findByText('every 5 minutes', {}, { timeout: 3000 })).toBeVisible();
    expect(within(dialog).getAllByText(/\d{1,2}[:.]\d{2}/).length).toBeGreaterThanOrEqual(5);

    await user.click(within(dialog).getByRole('button', { name: 'Hourly' }));
    expect(within(dialog).getByLabelText('Cron expression')).toHaveValue('0 * * * *');
    expect(
      await within(dialog).findByText('every hour, on the hour', {}, { timeout: 3000 }),
    ).toBeVisible();

    await user.selectOptions(within(dialog).getByLabelText('Flow'), 'hello.py');
    await user.click(within(dialog).getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // A schedule now carries its inputs and its outcomes too, empty until they are set.
    expect(bodyOf('POST /api/schedules')).toEqual({
      flow: 'hello.py',
      cron: '0 * * * *',
      runtime: 'threads',
      sample: null,
      enabled: true,
      params: {},
      env: {},
      notify: { events: [], webhook: null, emails: [] },
      retries: 0,
      retry_delay: 60,
    });
    expect(await screen.findByText(/Scheduled hello\.py/)).toBeInTheDocument();
  });

  it('shows the server’s own words when the cron is wrong', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ body: { schedules: [] } }),
      'GET /api/flows': flowsRoute,
      'POST /api/schedules/preview': previewRoute,
      'POST /api/schedules': () => ({
        status: 400,
        body: { error: { type: 'ValueError', message: 'minute field out of range: 99' } },
      }),
    });
    render(<SchedulesPage />);

    await user.click((await screen.findAllByRole('button', { name: 'New schedule' }))[0]!);
    const dialog = screen.getByRole('dialog', { name: 'New schedule' });
    const expression = within(dialog).getByLabelText('Cron expression');

    await user.clear(expression);
    await user.type(expression, '99 * * * *');
    expect(
      await within(dialog).findByText(/minute field out of range/, {}, { timeout: 3000 }),
    ).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Create schedule' }));
    expect(
      await within(dialog).findByText('minute field out of range: 99', {}, { timeout: 3000 }),
    ).toBeVisible();
    // The dialog stays open with what was typed, so it can be fixed.
    expect(screen.getByRole('dialog', { name: 'New schedule' })).toBeInTheDocument();
  });

  it('runs a schedule now and says which run started', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ body: { schedules: ROWS } }),
      'GET /api/flows': flowsRoute,
      'POST /api/schedules/1/run': () => ({
        body: { id: 31, flow: 'reports/word_count.py', status: 'running' },
      }),
    });
    render(<SchedulesPage />);

    await user.click(await screen.findByRole('button', { name: 'Run reports/word_count.py now' }));
    expect(
      await screen.findByText('Run #31 started for reports/word_count.py.'),
    ).toBeInTheDocument();
  });

  it('disables a schedule with the row toggle', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ body: { schedules: ROWS } }),
      'GET /api/flows': flowsRoute,
      'PUT /api/schedules/1': () => ({ body: { ...ROWS[0], enabled: false, next_run: null } }),
    });
    render(<SchedulesPage />);

    await user.click(
      await screen.findByRole('switch', { name: 'Disable the schedule for reports/word_count.py' }),
    );
    await waitFor(() => expect(bodyOf('PUT /api/schedules/1')).toEqual({ enabled: false }));
    expect(
      await screen.findByRole('switch', { name: 'Enable the schedule for reports/word_count.py' }),
    ).not.toBeChecked();
  });

  it('asks before deleting, then deletes', async () => {
    const user = userEvent.setup();
    let deleted = false;
    serve({
      'GET /api/schedules': () => ({ body: { schedules: deleted ? [ROWS[1]] : ROWS } }),
      'GET /api/flows': flowsRoute,
      'DELETE /api/schedules/1': () => {
        deleted = true;
        return { body: { ok: true } };
      },
    });
    render(<SchedulesPage />);

    await user.click(
      await screen.findByRole('button', { name: 'Delete the schedule for reports/word_count.py' }),
    );
    const confirm = screen.getByRole('dialog', { name: 'Delete this schedule?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete schedule' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByText('reports/word_count.py')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('nightly_etl.py')).toBeInTheDocument();
  });

  it('opens an existing schedule on the preset it was made with', async () => {
    const user = userEvent.setup();
    serve({
      'GET /api/schedules': () => ({ body: { schedules: ROWS } }),
      'GET /api/flows': flowsRoute,
      'POST /api/schedules/preview': previewRoute,
    });
    render(<SchedulesPage />);

    await user.click(
      await screen.findByRole('button', { name: 'Edit the schedule for reports/word_count.py' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit schedule' });
    expect(within(dialog).getByLabelText('Cron expression')).toHaveValue('*/15 * * * *');
    expect(within(dialog).getByRole('button', { name: 'Every few minutes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
