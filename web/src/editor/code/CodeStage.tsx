/**
 * The Code view of the editor page: the whole file, editable, with everything the canvas
 * knows about it in the margins.
 *
 * Typing here is the source of truth (`sourceTyped`); the canvas catches up 600 ms later.
 * When the parser cannot model what was typed, nothing is lost and nothing is reverted --
 * the file stays exactly as written and the panel underneath says which line stopped it.
 */

import { useMemo, type JSX } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { findNode, getAt } from '../../model';
import { MOD_KEY } from '../../platform';
import { useFlowStore, useProblems } from '../../store/flow';
import { CodeMirror } from './CodeMirror';
import styles from './code.module.css';
import { lineOfNode, parseErrorLine } from './locate';
import type { CodeProblem } from './problems';
import { sourceTyped } from './sync';
import { statusOf, useCodeSyncStore } from './syncStore';

/** `⌘F` on a Mac, `Ctrl F` everywhere else. */
const chord = (letter: string): string => (MOD_KEY === '⌘' ? `⌘${letter}` : `Ctrl ${letter}`);

export function CodeStage(): JSX.Element {
  const path = useFlowStore((state) => state.path);
  const source = useFlowStore((state) => state.source);
  const model = useFlowStore((state) => state.model);
  const codeOnly = useFlowStore((state) => state.codeOnly);
  const dirty = useFlowStore((state) => state.dirty);
  const problems = useProblems();

  const phase = useCodeSyncStore((state) => state.phase);
  const failure = useCodeSyncStore((state) => state.failure);
  const reveal = useCodeSyncStore((state) => state.reveal);

  /* Everything wrong with the file, on the line it is wrong on: the parser's own
   * complaint, and every problem `check` could pin to a node of this flow. */
  const marks = useMemo<CodeProblem[]>(() => {
    const out: CodeProblem[] = [];
    const failed = codeOnly ? parseErrorLine(codeOnly.reason) : null;
    if (codeOnly && failed !== null) {
      out.push({ line: failed, message: codeOnly.reason, severity: 'error' });
    }
    if (!model) return out;
    for (const problem of problems) {
      if (problem.path === null) continue;
      const block = getAt(model.flow, problem.path);
      if (!block || block.type !== 'ref') continue;
      const node = findNode(model, block.id);
      if (!node) continue;
      const line = lineOfNode(source, node.source, node.id);
      if (line === null) continue;
      out.push({ line, message: problem.message, severity: problem.severity });
    }
    return out;
  }, [codeOnly, model, problems, source]);

  const revealAt = useMemo(() => {
    if (!reveal) return null;
    if (reveal.line !== null) return { line: reveal.line, token: reveal.token };
    if (!model || reveal.id === null) return null;
    const node = findNode(model, reveal.id);
    if (!node) return null;
    const line = lineOfNode(source, node.source, node.id);
    return line === null ? null : { line, token: reveal.token };
    // The text is deliberately not a dependency: a reveal is a moment, not a state, and
    // re-running it on every keystroke would drag the cursor around while someone types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, model]);

  const status = statusOf({ phase, failure, codeOnly: codeOnly?.reason ?? null });
  const reason = failure ?? codeOnly?.reason ?? null;
  const line = codeOnly ? parseErrorLine(codeOnly.reason) : null;

  return (
    <div className={`${styles.surface ?? ''} ${styles.stage ?? ''}`}>
      <div className={styles.head}>
        <span className={styles.name}>{path ?? 'untitled.py'}</span>
        {dirty ? <span className={styles.dot} aria-label="Unsaved changes" /> : null}
        <span className={styles.spacer} />
        <span className={styles.hint}>
          <kbd>{chord('F')}</kbd> find · <kbd>{chord('S')}</kbd> save
        </span>
        <span className={styles.status} data-tone={status.tone} role="status">
          <span className={styles.statusDot} />
          {status.text}
        </span>
      </div>

      {path === null ? (
        <p className={styles.empty}>Open a flow to see its code.</p>
      ) : (
        <CodeMirror
          value={source}
          onChange={sourceTyped}
          problems={marks}
          reveal={revealAt}
          ariaLabel="Flow source"
          placeholder="# an empty file: write a flow, or draw one on the canvas"
        />
      )}

      {reason !== null ? (
        <div className={styles.notice} data-tone={failure ? 'error' : 'warning'} role="status">
          <span className={styles.noticeGlyph}>
            <Icon name="alert" size={14} />
          </span>
          <div className={styles.noticeText}>
            <p className={styles.noticeTitle}>
              {failure ? 'The server could not read this file' : 'The canvas cannot show this file'}
            </p>
            <p className={styles.noticeBody}>
              {failure
                ? 'The text is safe; nothing was changed. '
                : 'Your text is exactly as you typed it. The canvas is read-only until the file parses again. '}
              <span className={styles.reason}>{reason}</span>
            </p>
            {line !== null ? (
              <div className={styles.noticeActions}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => useCodeSyncStore.getState().revealLine(line)}
                >
                  <Icon name="code" size={14} />
                  Go to line {line}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default CodeStage;
