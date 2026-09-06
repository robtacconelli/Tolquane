import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import type { FlowDraft } from '../store/ai';
import { collapse, diffLines, diffStat } from './diff';
import styles from './FlowCard.module.css';

/**
 * The flow the builder ended the turn with.
 *
 * The server wrote it in a directory of its own and never touched the open file, so this
 * card is the whole handover: what it would change, and the button that changes it. The
 * editor is still what saves, which is why the card says so.
 */
export function FlowCard({
  draft,
  current,
  path,
  onApply,
  onShowCode,
}: {
  draft: FlowDraft;
  /** The source on the canvas now, to diff against. */
  current: string;
  path: string;
  onApply: () => void;
  /** Open the code view, once the flow has been applied. */
  onShowCode?: (() => void) | undefined;
}): JSX.Element {
  const [showDiff, setShowDiff] = useState(false);
  const diff = useRef<HTMLDivElement>(null);

  /* The flow on the canvas when the builder answered. Applying makes `current` the
   * source below, and "nothing changed" is not what this card is for: what it changed
   * is worth reading afterwards too. */
  const [before] = useState(current);

  const rows = useMemo(() => diffLines(before, draft.source), [before, draft.source]);
  const stat = useMemo(() => diffStat(rows), [rows]);
  const folded = useMemo(() => collapse(rows, 3), [rows]);
  const lines = draft.source
    .split('\n')
    .filter((line, index, all) => index < all.length - 1 || line).length;
  const unchanged = stat.added === 0 && stat.removed === 0;

  // An opened diff is worth reading, so it is brought into view rather than left below
  // the fold of a panel the reader has not scrolled.
  useEffect(() => {
    if (showDiff) diff.current?.scrollIntoView({ block: 'end' });
  }, [showDiff]);

  return (
    <div className={styles.card} data-applied={draft.applied || undefined}>
      <div className={styles.head}>
        <span className={styles.glyph}>
          <Icon name="sparkle" size={13} />
        </span>
        <div className={styles.headText}>
          <span className={styles.title}>{path || 'flow.py'}</span>
          <span className={styles.meta}>
            {String(lines)} lines
            {unchanged ? (
              <> · the same as what was open</>
            ) : (
              <>
                {' · '}
                <span className={styles.added}>+{stat.added}</span>{' '}
                <span className={styles.removed}>−{stat.removed}</span>
              </>
            )}
            {draft.codeOnly ? ' · code-only' : null}
          </span>
        </div>
      </div>

      {draft.codeOnly ? (
        <p className={styles.note}>
          This one cannot be drawn on the canvas: {draft.codeOnly.reason}. It still opens in the
          code view and runs.
        </p>
      ) : null}

      <div className={styles.actions}>
        {draft.applied ? (
          <span className={styles.applied}>
            <Icon name="check" size={13} />
            On the canvas — <strong>Save</strong> writes it to the file
          </span>
        ) : (
          <Button size="sm" variant="primary" onClick={onApply}>
            <Icon name="check" size={13} />
            Apply to editor
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowDiff((open) => !open)}
          aria-expanded={showDiff}
        >
          <Icon name={showDiff ? 'chevronDown' : 'chevronRight'} size={13} />
          {showDiff ? 'Hide diff' : 'Show diff'}
        </Button>
        {draft.applied && onShowCode ? (
          <Button size="sm" variant="ghost" onClick={onShowCode}>
            <Icon name="code" size={13} />
            Code
          </Button>
        ) : null}
      </div>

      {showDiff ? (
        <div className={styles.diff} ref={diff} role="region" aria-label="What the builder changed">
          {unchanged ? (
            <p className={styles.same}>Not one line differs from the flow that was open.</p>
          ) : (
            folded.map((row, index) =>
              row.kind === 'gap' ? (
                <div key={index} className={styles.gap}>
                  {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
                </div>
              ) : (
                <div key={index} className={styles.line} data-kind={row.kind}>
                  <span className={styles.gutter}>
                    {row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}
                  </span>
                  <span className={styles.text}>{row.text || ' '}</span>
                </div>
              ),
            )
          )}
        </div>
      ) : null}
    </div>
  );
}
