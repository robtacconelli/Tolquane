import { useEffect, useMemo, type JSX } from 'react';
import { useRunStore } from '../store/run';
import { splitEdgeKey } from './format';
import styles from './Run.module.css';

/*
 * What actually went down each channel.
 *
 * `tap=N` (S2) keeps the last N items that crossed every edge as their `repr`, cut to
 * 200 characters, and sends them with each progress snapshot. That is the one debugging
 * tool a dataflow really needs: not a breakpoint, but the last few things this edge
 * carried, next to how deep its queue is now and how deep it ever got.
 *
 * Edges are picked from the list here or by clicking one on the canvas.
 */

export function TapsPane(): JSX.Element {
  const edges = useRunStore((state) => state.edges);
  const selected = useRunStore((state) => state.selectedEdge);
  const selectEdge = useRunStore((state) => state.selectEdge);
  const tap = useRunStore((state) => state.options.tap);
  const status = useRunStore((state) => state.status);
  const aliases = useRunStore((state) => state.aliases);

  // Only the run's own edges are listed: the block-view aliases stand for these and
  // would say the same thing twice under a name no run ever printed.
  const keys = useMemo(
    () =>
      Object.keys(edges)
        .filter((key) => !(key in aliases.edges))
        .sort((a, b) => a.localeCompare(b)),
    [edges, aliases],
  );

  const current = selected && edges[selected] ? selected : (keys[0] ?? null);

  useEffect(() => {
    if (selected === null && current !== null) selectEdge(current);
  }, [selected, current, selectEdge]);

  const shown = current ? edges[current] : undefined;

  if (keys.length === 0) {
    return (
      <div className={styles.pane}>
        <p className={styles.empty}>
          {status === 'idle'
            ? 'Run the flow to see what crosses each edge.'
            : 'No edges yet. The first progress snapshot brings them, half a second in.'}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.pane}>
      <div className={styles.split}>
        <div className={styles.edges} role="listbox" aria-label="Edges">
          {keys.map((key) => {
            const edge = edges[key];
            const parts = splitEdgeKey(key);
            const full = edge?.capacity ? (edge.queued ?? 0) >= edge.capacity : false;
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={key === current}
                className={key === current ? `${styles.edge} ${styles.edgeActive}` : styles.edge}
                onClick={() => {
                  selectEdge(key);
                }}
                title={key}
              >
                <span className={styles.edgeName}>
                  {parts.src} <span className={styles.arrow}>→</span> {parts.dst}
                </span>
                <span className={full ? `${styles.queue} ${styles.queueFull}` : styles.queue}>
                  {(edge?.queued ?? 0).toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>

        <div className={styles.pane}>
          <div className={styles.paneBar}>
            <span className={styles.paneLabel}>Last items</span>
            <span className={styles.paneName}>{current}</span>
            <span className={styles.paneSpacer} />
            <span className={styles.paneFact}>
              queued {(shown?.queued ?? 0).toLocaleString()} · high water{' '}
              {(shown?.high_water ?? 0).toLocaleString()}
              {shown?.capacity ? ` of ${shown.capacity.toLocaleString()}` : ''}
            </span>
          </div>
          {shown && shown.taps.length > 0 ? (
            <div className={styles.items}>
              {shown.taps.map((item, index) => (
                <div className={styles.item} key={`${String(index)}-${item}`}>
                  <span className={styles.itemNo}>{index + 1}</span>
                  <span className={styles.itemText}>{item}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.empty}>
              {tap > 0
                ? 'Nothing has crossed this edge yet.'
                : 'This run was started without taps. Turn on “Tap items” in the Run menu and run it again to see what crosses each edge.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
