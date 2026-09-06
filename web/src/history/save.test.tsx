import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowStore } from '../store/flow';
import { SaveMessageDialog } from './SaveMessageDialog';
import { commitBody, savedText } from './save';
import { useHistoryStore } from './store';

/* Saving with a message: what goes on the wire, what the toolbar says afterwards, and
 * the little dialog Cmd/Ctrl+Shift+S opens (section H). */

const COMMIT = { rev: '6c72ce416038098bdbfda22cc359cda9cc856a71', short: '6c72ce4' };

function repo(available: boolean): void {
  useHistoryStore.setState({
    status: {
      available,
      reason: available ? null : 'the workspace is not in a git repository',
      repo: available,
      root: available ? '/w' : null,
      dirty: 0,
    },
  });
}

describe('the body a save sends', () => {
  it('asks for a commit only when a message is waiting', () => {
    expect(commitBody(null)).toEqual({});
    expect(commitBody('   ')).toEqual({});
    expect(commitBody('  Give the farm four workers ')).toEqual({
      commit: { message: 'Give the farm four workers' },
    });
  });
});

describe('what the toolbar says after a save', () => {
  it('says only Saved when nobody asked for a commit and none was made', () => {
    expect(savedText(null, false)).toBe('Saved');
  });

  it('says so when a commit was asked for and did not happen', () => {
    expect(savedText(null, true)).toBe('Saved. There was nothing to commit.');
  });

  it('names the revision when the save was asked to commit', () => {
    expect(savedText(COMMIT, true)).toBe('Saved and committed as 6c72ce4');
  });

  it('says why a commit nobody asked for happened', () => {
    expect(savedText(COMMIT, false)).toBe(
      'Saved and committed as 6c72ce4, because auto-commit is on',
    );
  });
});

describe('the save-with-message dialog', () => {
  beforeEach(() => {
    useFlowStore.getState().clear();
    useHistoryStore.setState({ status: null });
  });

  it('starts from the message that is already waiting, and saves what is typed', async () => {
    repo(true);
    useFlowStore.getState().setPendingCommit('AI: make it read a file');
    const onSave = vi.fn();
    render(<SaveMessageDialog path="hello.py" onSave={onSave} onClose={vi.fn()} />);

    const field = screen.getByLabelText('Commit message');
    expect(field).toHaveValue('AI: make it read a file');

    await userEvent.clear(field);
    await userEvent.type(field, 'Four workers{Enter}');
    expect(onSave).toHaveBeenCalledWith('Four workers');
  });

  it("commits with the server's own message when none is typed", async () => {
    repo(true);
    const onSave = vi.fn();
    render(<SaveMessageDialog path="reports/hello.py" onSave={onSave} onClose={vi.fn()} />);

    expect(screen.getByLabelText('Commit message')).toHaveAttribute(
      'placeholder',
      'Edit reports/hello.py',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save and commit' }));
    expect(onSave).toHaveBeenCalledWith('Edit reports/hello.py');
  });

  it('offers a plain save, and says why, where there is no repository', async () => {
    repo(false);
    const onSave = vi.fn();
    render(<SaveMessageDialog path="hello.py" onSave={onSave} onClose={vi.fn()} />);

    expect(screen.queryByLabelText('Commit message')).not.toBeInTheDocument();
    expect(screen.getByText('the workspace is not in a git repository')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save without committing' }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});
