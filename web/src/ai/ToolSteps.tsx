import type { JSX } from 'react';
import { Icon, type IconName } from '../components/Icon';
import type { ToolStep } from '../store/ai';
import styles from './AiPanel.module.css';

/**
 * What the builder did, as a timeline.
 *
 * The four tools are the loop from docs/builder.md: it writes the file, checks the
 * wiring, runs it on a sample and reads an example when it needs one. Seeing that
 * happen is most of the trust in the answer, so the steps are shown as they arrive
 * rather than summarised at the end.
 */
const LOOK: Record<string, { label: string; icon: IconName }> = {
  write_flow: { label: 'Wrote the flow', icon: 'code' },
  check_flow: { label: 'Checked the wiring', icon: 'check' },
  run_flow: { label: 'Ran it on a sample', icon: 'play' },
  read_docs: { label: 'Read the docs', icon: 'flows' },
};

const RUNNING: Record<string, string> = {
  write_flow: 'Writing the flow',
  check_flow: 'Checking the wiring',
  run_flow: 'Running it on a sample',
  read_docs: 'Reading the docs',
};

export function ToolSteps({ steps }: { steps: readonly ToolStep[] }): JSX.Element | null {
  if (steps.length === 0) return null;
  return (
    <ol className={styles.steps}>
      {steps.map((step) => {
        const look = LOOK[step.name] ?? { label: step.name, icon: 'command' as IconName };
        const label = step.running ? (RUNNING[step.name] ?? look.label) : look.label;
        return (
          <li
            key={step.id}
            className={styles.step}
            data-running={step.running || undefined}
            data-error={step.error || undefined}
          >
            <span className={styles.stepGlyph}>
              <Icon name={step.error ? 'alert' : look.icon} size={12} />
            </span>
            <div className={styles.stepText}>
              <span className={styles.stepLabel}>
                {label}
                {step.request ? <span className={styles.stepArg}>{step.request}</span> : null}
              </span>
              {step.result ? <span className={styles.stepResult}>{step.result}</span> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
