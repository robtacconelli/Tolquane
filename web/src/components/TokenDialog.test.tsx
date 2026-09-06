import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOKEN_KEY, clearUnauthorized, isUnauthorized, reportUnauthorized } from '../api/token';
import { TokenDialog } from './TokenDialog';

/* The prompt a server started with `--token` produces: nothing at all until a request is
 * refused, then one field, tried against /api/health before it is kept. */

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  localStorage.clear();
  clearUnauthorized();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  clearUnauthorized();
});

describe('the token prompt', () => {
  it('is not there while nothing has been refused', () => {
    render(<TokenDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('appears on a 401, keeps a token the server accepts and retries', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ ok: true, version: '1.1.0' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<TokenDialog />);
    reportUnauthorized();
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /wants a token/i })).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Server token'), 's3cret');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBe('s3cret');
    });
    // It was tried with its own header before it was kept, and the question is over.
    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer s3cret',
    );
    expect(isUnauthorized()).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says so when the server refuses the token, and keeps nothing', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', () => Promise.resolve(jsonResponse({ detail: 'no' }, { status: 401 })));

    render(<TokenDialog />);
    reportUnauthorized();
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Server token'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('refused that token');
    });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('can be put away without a token', async () => {
    const user = userEvent.setup();
    render(<TokenDialog />);
    reportUnauthorized();
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
