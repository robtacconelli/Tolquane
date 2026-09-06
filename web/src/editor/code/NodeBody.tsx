/**
 * A node's body, editable, in the property panel.
 *
 * The same editor as the file view in its compact density. A change here is a model edit
 * (`setNodeSource`), which makes the file stale, which regenerates it -- so the text of
 * the whole file follows the body, and the parse that comes after says whether what was
 * written still holds together.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { useFlowStore } from '../../store/flow';
import { CodeMirror } from './CodeMirror';
import styles from './code.module.css';
import { nodeSourceTyped } from './sync';
import { useCodeSyncStore } from './syncStore';

/** After the last keystroke in a node body, before the model hears about it. */
export const BODY_DEBOUNCE_MS = 400;

export function NodeBody({
  id,
  source,
  title,
  action,
  readOnly = false,
}: {
  /** The node being edited; give the component `key={id}` so it starts afresh per node. */
  id: string;
  source: string;
  title: string;
  action?: ReactNode;
  readOnly?: boolean;
}): JSX.Element {
  const [text, setText] = useState(source);
  const sent = useRef(source);
  const phase = useCodeSyncStore((state) => state.phase);
  const codeOnly = useFlowStore((state) => state.codeOnly);

  /* Text that came back from the model -- a regeneration, an undo, a fresh parse -- wins,
   * but never while someone is mid-word: the pending keystrokes are still on their way in. */
  useEffect(() => {
    if (source === sent.current) return;
    setText((current) => (current === sent.current ? source : current));
    sent.current = source;
  }, [source]);

  useEffect(() => {
    if (readOnly || text === sent.current) return;
    const timer = window.setTimeout(() => {
      sent.current = text;
      nodeSourceTyped(id, text);
    }, BODY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, id, readOnly]);

  const note: { tone: 'idle' | 'busy' | 'error'; text: string } =
    codeOnly !== null
      ? { tone: 'error', text: codeOnly.reason }
      : phase === 'generating' || phase === 'parsing'
        ? { tone: 'busy', text: 'Writing this into the file…' }
        : { tone: 'idle', text: 'Edits here are written into the file and shown on the canvas.' };

  return (
    <div className={`${styles.surface ?? ''} ${styles.body ?? ''}`}>
      <div className={styles.bodyHead}>
        <span className={styles.bodyTitle}>{title}</span>
        {action}
      </div>
      <CodeMirror
        compact
        value={text}
        onChange={setText}
        readOnly={readOnly}
        ariaLabel={`Body of ${id}`}
        className={styles.bodyEditor ?? ''}
      />
      <p className={styles.bodyNote} data-tone={note.tone}>
        {note.text}
      </p>
    </div>
  );
}

export default NodeBody;
