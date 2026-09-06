/**
 * The four things people ask the builder often enough to deserve a button.
 *
 * `send: false` means the phrase goes into the composer for the user to finish; the
 * others are complete questions and go straight out.
 */

import type { Problem } from '../model';

export interface QuickAction {
  id: string;
  label: string;
  question: string;
  /** Ask it now, or leave it in the composer to be finished. */
  send: boolean;
}

export function quickActions(options: {
  hasFlow: boolean;
  problems: readonly Problem[];
}): QuickAction[] {
  const actions: QuickAction[] = [];
  if (options.hasFlow) {
    actions.push({
      id: 'explain',
      label: 'Explain this flow',
      question: 'Explain what this flow does, stage by stage, and where its time goes.',
      send: true,
    });
    actions.push({
      id: 'faster',
      label: 'Make it faster',
      question:
        'Make this flow faster. Say what the bottleneck is, change the flow, and tell me what you changed and why.',
      send: true,
    });
  }
  actions.push({
    id: 'add',
    label: 'Add a stage that…',
    question: 'Add a stage that ',
    send: false,
  });

  const errors = options.problems.filter((problem) => problem.severity === 'error');
  if (errors.length > 0) {
    actions.push({
      id: 'fix',
      label: `Fix ${errors.length === 1 ? 'the problem' : `the ${String(errors.length)} problems`}`,
      question: [
        'Check reports these problems with the flow. Fix them and explain the cause:',
        ...errors.map((problem) => `- ${problem.message}`),
      ].join('\n'),
      send: true,
    });
  }
  return actions;
}
