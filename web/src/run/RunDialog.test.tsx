import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../api/runs';
import { RunDialog } from './RunDialog';

/* One past run: what it was given (section E) and, for a scheduled one, the chain of
 * attempts and who was told about the end of it (section N). */

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function serve(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(urlOf(input), 'http://localhost');
      const body = routes[url.pathname];
      if (body === undefined) {
        return Promise.resolve(new Response('', { status: 404 }));
      }
      if (typeof body === 'string') {
        return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/plain' } }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );
    }),
  );
}

const base: Run = {
  id: 12,
  flow: 'params.py',
  runtime: 'threads',
  sample: null,
  trigger: 'manual',
  user: 'local',
  started: '2026-09-06T10:00:00Z',
  ended: '2026-09-06T10:00:02Z',
  status: 'done',
  report: null,
  log: '',
  trace_path: null,
  error: null,
  params: {},
  env: {},
  live: false,
};

function show(run: Run, runs: Run[] = [run], onOpenRun = vi.fn()): void {
  render(
    <RunDialog
      run={run}
      runs={runs}
      busy={false}
      onClose={vi.fn()}
      onRerun={vi.fn()}
      onCancel={vi.fn()}
      onOpenRun={onOpenRun}
    />,
  );
}

describe('the inputs a run was given', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    serve({ '/api/runs/12/log': 'hello' });
  });

  it('has no Inputs tab when there were none', () => {
    show(base);
    expect(screen.queryByRole('button', { name: 'Inputs' })).not.toBeInTheDocument();
  });

  it('shows the parameters as literals and the environment as it was set', async () => {
    const user = userEvent.setup();
    show({ ...base, params: { factor: 9, loud: true }, env: { GREETING: 'hello' } });

    await user.click(screen.getByRole('button', { name: 'Inputs' }));
    expect(screen.getByText('factor')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    // A boolean reads as Python wrote it, not as JSON would.
    expect(screen.getByText('True')).toBeInTheDocument();
    expect(screen.getByText('GREETING')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });
});

describe('the outcome of a scheduled run', () => {
  const firing: Run = {
    ...base,
    id: 10,
    trigger: 'schedule:3',
    status: 'failed',
    started: '2026-09-06T10:00:00Z',
  };
  const retry: Run = {
    ...base,
    id: 12,
    trigger: 'retry:3:1',
    status: 'done',
    started: '2026-09-06T10:01:00Z',
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('has no Outcome tab for a run nobody scheduled', () => {
    serve({ '/api/runs/12/log': '' });
    show(base);
    expect(screen.queryByRole('button', { name: 'Outcome' })).not.toBeInTheDocument();
  });

  it('lists the chain and every delivery attempt', async () => {
    const user = userEvent.setup();
    serve({
      '/api/runs/12/log': '',
      '/api/runs/12/notifications': {
        notifications: [
          {
            id: 1,
            run_id: 12,
            schedule_id: 3,
            channel: 'webhook',
            target: 'https://example.com/hook',
            status: 'failed',
            error: 'could not reach it',
            created: '2026-09-06T10:02:00Z',
          },
          {
            id: 2,
            run_id: 12,
            schedule_id: 3,
            channel: 'webhook',
            target: 'https://example.com/hook',
            status: 'sent',
            error: null,
            created: '2026-09-06T10:02:30Z',
          },
        ],
      },
    });
    const open = vi.fn();
    show(retry, [firing, retry], open);

    await user.click(screen.getByRole('button', { name: 'Outcome' }));
    const attempts = within(screen.getByRole('list', { name: 'Attempts' }));
    expect(attempts.getByText('First attempt')).toBeInTheDocument();
    expect(attempts.getByText('Retry 1')).toBeInTheDocument();
    expect(attempts.getByText('run 10')).toBeInTheDocument();

    // The other run of the chain is a way into it.
    await user.click(attempts.getByText('First attempt'));
    expect(open).toHaveBeenCalledWith(10);

    const sent = within(await screen.findByRole('list', { name: 'Notifications sent' }));
    expect(sent.getByText('could not reach it')).toBeInTheDocument();
    expect(sent.getByText('sent')).toBeInTheDocument();
  });

  it('says nobody was told when there is nothing to show', async () => {
    const user = userEvent.setup();
    serve({ '/api/runs/10/log': '', '/api/runs/10/notifications': { notifications: [] } });
    show(firing, [firing]);
    await user.click(screen.getByRole('button', { name: 'Outcome' }));
    expect(await screen.findByText(/Nobody was told/)).toBeInTheDocument();
  });
});
