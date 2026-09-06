import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { useUiStore } from '../store/ui';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('the app shell', () => {
  beforeEach(() => {
    useUiStore.setState({
      themeMode: 'system',
      theme: 'dark',
      sidebarCollapsed: false,
      paletteOpen: false,
    });
    // No server exists yet; every health poll fails, which is the state to look good in.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
  });

  it('shows the wordmark and every section', () => {
    renderAt('/flows');
    expect(screen.getByText('Tolquane')).toBeInTheDocument();
    for (const label of ['Flows', 'Runs', 'Schedules', 'Settings']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the open section as current', () => {
    renderAt('/runs');
    expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Flows' })).not.toHaveAttribute('aria-current');
  });

  it('renders every route', () => {
    const cases: [string, string][] = [
      ['/flows', 'No workspace open'],
      ['/runs', 'History'],
      ['/schedules', 'Scheduled flows'],
      ['/settings', 'Appearance'],
    ];
    for (const [path, marker] of cases) {
      const view = renderAt(path);
      expect(screen.getByText(marker)).toBeInTheDocument();
      view.unmount();
    }
  });

  it('opens a flow path in the editor frame', () => {
    renderAt('/flows/reports/word_count.py');
    expect(screen.getByRole('heading', { level: 1, name: 'word_count.py' })).toBeInTheDocument();
    // Every folder of the path is its own crumb, so a nested flow reads as a path.
    expect(screen.getByText('reports')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Console/ })).toBeInTheDocument();
    expect(screen.getByText('Properties')).toBeInTheDocument();
  });

  it('sends / to the flows page', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: 'Flows', level: 2 })).toBeInTheDocument();
  });

  it('warns quietly once the server has failed a poll', async () => {
    renderAt('/flows');
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('not reachable');
    });
    expect(screen.getByText('Server offline')).toBeInTheDocument();
  });

  it('opens the command palette with the platform command key', async () => {
    const user = userEvent.setup();
    renderAt('/flows');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('flips the theme from the top bar', async () => {
    const user = userEvent.setup();
    renderAt('/flows');
    await user.click(screen.getByRole('button', { name: /Switch to the light theme/ }));
    expect(useUiStore.getState().theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('collapses the sidebar', async () => {
    const user = userEvent.setup();
    renderAt('/flows');
    await user.click(screen.getByRole('button', { name: 'Collapse the sidebar' }));
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });
});
