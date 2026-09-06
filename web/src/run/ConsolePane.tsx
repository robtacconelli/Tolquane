import { useCallback, useLayoutEffect, useRef, useState, type JSX, type UIEvent } from 'react';
import { useRunStore } from '../store/run';
import styles from './Run.module.css';

/*
 * Everything the flow printed, in order, stdout and stderr together.
 *
 * The two streams are told apart quietly -- stderr keeps the danger colour and a rule
 * down its left edge -- because a flow that writes a progress line to stderr is normal
 * and should not look like a failure. The view follows the tail until the reader scrolls
 * up, and then stops until they ask for it back: nothing is more annoying than a log
 * that jumps away while it is being read.
 */

const NEAR_BOTTOM = 24;

export function ConsolePane(): JSX.Element {
  const lines = useRunStore((state) => state.lines);
  const dropped = useRunStore((state) => state.linesDropped);
  const clear = useRunStore((state) => state.clearConsole);

  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !following) return;
    node.scrollTop = node.scrollHeight;
  }, [lines, following]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
    setFollowing(gap <= NEAR_BOTTOM);
  }, []);

  const copy = useCallback(() => {
    const text = useRunStore
      .getState()
      .lines.map((line) => line.text)
      .join('\n');
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }, []);

  return (
    <div className={styles.pane}>
      <div className={styles.paneBar}>
        <span className={styles.paneLabel}>Output</span>
        <span className={styles.paneFact}>
          {lines.length === 0
            ? 'nothing yet'
            : `${lines.length.toLocaleString()} ${lines.length === 1 ? 'line' : 'lines'}`}
        </span>
        <span className={styles.paneSpacer} />
        <button type="button" className={styles.link} onClick={copy} disabled={lines.length === 0}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className={styles.link} onClick={clear} disabled={lines.length === 0}>
          Clear
        </button>
      </div>

      {lines.length === 0 ? (
        <p className={styles.empty}>
          Nothing printed yet. Everything the flow writes to <strong>stdout</strong> and{' '}
          <strong>stderr</strong> arrives here while it runs, one line at a time.
        </p>
      ) : (
        <div
          className={styles.log}
          ref={box}
          onScroll={onScroll}
          role="log"
          aria-label="Run output"
        >
          {dropped > 0 ? (
            <p className={styles.dropped}>
              {dropped.toLocaleString()} earlier lines dropped; the console keeps the last{' '}
              {lines.length.toLocaleString()}.
            </p>
          ) : null}
          {lines.map((line, index) => (
            <div
              key={line.id}
              className={line.stream === 'stderr' ? `${styles.line} ${styles.err}` : styles.line}
              data-stream={line.stream}
            >
              <span className={styles.lineNo}>{dropped + index + 1}</span>
              <span className={styles.lineText}>{line.text || ' '}</span>
            </div>
          ))}
        </div>
      )}

      {following || lines.length === 0 ? null : (
        <button
          type="button"
          className={styles.follow}
          onClick={() => {
            setFollowing(true);
          }}
        >
          Jump to the latest
        </button>
      )}
    </div>
  );
}
