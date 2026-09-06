import { describe, expect, it } from 'vitest';
import type { Problem } from '../model';
import { quickActions } from './quickActions';

const error = (message: string): Problem => ({
  path: null,
  message,
  severity: 'error',
  source: 'server',
});

describe('quickActions', () => {
  it('offers the two questions about a flow only when one is open', () => {
    const open = quickActions({ hasFlow: true, problems: [] }).map((action) => action.id);
    expect(open).toEqual(['explain', 'faster', 'add']);

    const none = quickActions({ hasFlow: false, problems: [] }).map((action) => action.id);
    expect(none).toEqual(['add']);
  });

  it('leaves "add a stage that" in the composer to be finished', () => {
    const add = quickActions({ hasFlow: true, problems: [] }).find((action) => action.id === 'add');
    expect(add).toMatchObject({ send: false, question: 'Add a stage that ' });
  });

  it('offers to fix what Check found, with the messages in the question', () => {
    const actions = quickActions({
      hasFlow: true,
      problems: [
        error("collect='gather' pairs with emit='scatter'"),
        error('double has no sink'),
        { path: null, message: 'a warning', severity: 'warning', source: 'model' },
      ],
    });
    const fix = actions.find((action) => action.id === 'fix');
    expect(fix?.label).toBe('Fix the 2 problems');
    expect(fix?.send).toBe(true);
    expect(fix?.question).toContain("collect='gather' pairs with emit='scatter'");
    expect(fix?.question).toContain('double has no sink');
    expect(fix?.question).not.toContain('a warning');
  });

  it('counts one problem in the singular', () => {
    const actions = quickActions({ hasFlow: true, problems: [error('one thing')] });
    expect(actions.find((action) => action.id === 'fix')?.label).toBe('Fix the problem');
  });
});
