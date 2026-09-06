import { useState, type JSX } from 'react';
import { Icon } from '../components/Icon';
import { StatusDot } from '../components/StatusDot';
import type { Problem } from '../model';
import { useFlowStore } from '../store/flow';
import { useRunStore } from '../store/run';
import { pathOfNode } from './keys';
import styles from './Run.module.css';

/*
 * Everything wrong with this flow in one list: what `validateModel` and `tq.check` say
 * about the file, and what the last run said about itself.
 *
 * A run failure names the thread that raised (`double.1`), so the row points at the card
 * that thread belongs to and selecting the row selects the card. A deadlock report names
 * every blocked node in its message; the first is the one to look at.
 */

export function ProblemsPane({
  problems,
  selected,
  onSelect,
}: {
  /** From F2: the model's own problems and the server's last `check`. */
  problems: readonly Problem[];
  selected: string | null;
  onSelect: (path: string) => void;
}): JSX.Element {
  const runProblems = useRunStore((state) => state.problems);
  const runGraph = useRunStore((state) => state.graph);
  const model = useFlowStore((state) => state.model);
  const flowGraph = useFlowStore((state) => state.graph);
  const [open, setOpen] = useState<number | null>(null);

  if (problems.length === 0 && runProblems.length === 0) {
    return (
      <div className={styles.pane}>
        <p className={styles.empty}>
          Nothing wrong with this flow. <strong>Check</strong> runs <code>tq.check</code> on the
          server for the last word, and anything a run raises lands here with its traceback.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.problems}>
      {problems.map((problem, index) => (
        <button
          key={`check-${problem.message}-${String(index)}`}
          type="button"
          className={
            problem.path === selected ? `${styles.problem} ${styles.problemActive}` : styles.problem
          }
          onClick={() => {
            if (problem.path !== null) onSelect(problem.path);
          }}
        >
          <span className={styles.problemHead}>
            <StatusDot state={problem.severity === 'error' ? 'failed' : 'waiting'} />
            <span className={styles.problemText}>{problem.message}</span>
            <span
              className={
                problem.severity === 'warning'
                  ? `${styles.problemWhere} ${styles.problemWarning}`
                  : styles.problemWhere
              }
            >
              {problem.severity === 'warning'
                ? 'warning'
                : problem.source === 'server'
                  ? 'tq.check'
                  : (problem.path ?? 'flow')}
            </span>
          </span>
          {/* The one line that ends it: `pip install opencv-python`, ready to be copied
              into the terminal the interpreter lives in. */}
          {problem.hint ? <code className={styles.problemHint}>{problem.hint}</code> : null}
        </button>
      ))}

      {runProblems.map((problem) => {
        const path = problem.node ? pathOfNode(model, runGraph ?? flowGraph, problem.node) : null;
        const isOpen = open === problem.id;
        return (
          <div key={`run-${String(problem.id)}`}>
            {/* The row is the disclosure: a chevron on a row that has a traceback, and
                clicking it both selects the card that raised it and opens the trace. */}
            <button
              type="button"
              className={
                path !== null && path === selected
                  ? `${styles.problem} ${styles.problemActive}`
                  : styles.problem
              }
              {...(problem.traceback ? { 'aria-expanded': isOpen } : {})}
              onClick={() => {
                if (path !== null) onSelect(path);
                setOpen(isOpen ? null : problem.id);
              }}
            >
              <span className={styles.problemHead}>
                <StatusDot state="failed" />
                <span className={styles.problemText}>{problem.message}</span>
                <span className={styles.problemWhere}>{problem.node ?? problem.type}</span>
                {problem.traceback ? (
                  <span className={styles.discloseMark} data-open={isOpen}>
                    <Icon name="chevronRight" size={13} />
                  </span>
                ) : null}
              </span>
            </button>
            {isOpen && problem.traceback ? (
              <pre className={styles.traceback}>{problem.traceback}</pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
