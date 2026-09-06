import { render, screen, waitFor } from '@testing-library/react';
import type { JSX } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../api/auth';
import { clearUnauthorized, reportUnauthorized, setServerMode } from '../api/token';
import { navItemsFor } from '../nav';
import { useAuthStore } from '../store/auth';
import { LoginGate } from './LoginGate';

/* The door: shut on a server with users until somebody signs in, and not there at all on
 * the loopback server that has none. */

const ALICE: User = {
  id: 1,
  name: 'alice',
  role: 'admin',
  created: '2026-09-01T10:00:00Z',
  disabled: false,
  must_change_password: false,
  last_seen: null,
};

function Where(): JSX.Element {
  const location = useLocation();
  const state = location.state as { from?: string } | null;
  return <p>login, coming from {state?.from ?? 'nowhere'}</p>;
}

function show(): void {
  render(
    <MemoryRouter initialEntries={['/runs?flow=hello.py']}>
      <Routes>
        <Route path="/login" element={<Where />} />
        <Route
          path="/runs"
          element={
            <LoginGate>
              <p>the runs</p>
            </LoginGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setServerMode(null);
  clearUnauthorized();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  );
});

describe('the login gate', () => {
  it('is not in the way on a server with no accounts', () => {
    useAuthStore.setState({ status: 'ready', mode: 'local', user: ALICE, canSetup: false });
    show();
    expect(screen.getByText('the runs')).toBeInTheDocument();
  });

  it('sends an anonymous visitor to sign in, and remembers where they were going', () => {
    useAuthStore.setState({ status: 'ready', mode: 'users', user: null, canSetup: false });
    show();
    expect(screen.getByText('login, coming from /runs?flow=hello.py')).toBeInTheDocument();
  });

  it('holds somebody who must choose a new password at the door', () => {
    useAuthStore.setState({
      status: 'ready',
      mode: 'users',
      user: { ...ALICE, must_change_password: true },
      canSetup: false,
    });
    show();
    expect(screen.getByText(/^login, coming from/)).toBeInTheDocument();
  });

  it('sends a session that has just ended to sign in again', async () => {
    useAuthStore.setState({ status: 'ready', mode: 'users', user: ALICE, canSetup: false });
    setServerMode('users');
    show();
    expect(screen.getByText('the runs')).toBeInTheDocument();

    reportUnauthorized();
    await waitFor(() => {
      expect(screen.getByText(/^login, coming from/)).toBeInTheDocument();
    });
  });

  it('draws nothing but the mark until the server has said who the caller is', () => {
    useAuthStore.setState({ status: 'loading', mode: null, user: null, canSetup: false });
    show();
    expect(screen.queryByText('the runs')).not.toBeInTheDocument();
    expect(screen.queryByText(/^login/)).not.toBeInTheDocument();
  });
});

describe('the sections', () => {
  it('keep Users for administrators', () => {
    expect(navItemsFor(true).map((item) => item.to)).toContain('/users');
    expect(navItemsFor(false).map((item) => item.to)).not.toContain('/users');
    // Everything else is everybody's.
    expect(navItemsFor(false)).toHaveLength(navItemsFor(true).length - 1);
  });
});
