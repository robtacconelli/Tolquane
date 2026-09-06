import { Handle, Position as HandlePosition, type NodeProps } from '@xyflow/react';
import type { JSX } from 'react';
import { BlockCard } from '../components/BlockCard';
import { BLOCK_KINDS } from '../components/blockKinds';
import type { NodeState } from '../components/nodeState';
import { StatusDot } from '../components/StatusDot';
import { stateOfGroup } from '../store/run';
import type { CanvasNodeData } from './buildGraph';
import { useCanvas } from './CanvasContext';
import styles from './nodes.module.css';

/* The four node types the canvas draws. Every one of them follows the block card spec in
 * DESIGN.md: the leaf is the card itself, the container is a panel with the card's header
 * shape, and the run overlay only ever adds a ring and a dot -- never a background, so the
 * text stays readable in both themes. */

function Glyph({ kind, size }: { kind: CanvasNodeData['kind']; size: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {BLOCK_KINDS[kind].glyph}
    </svg>
  );
}

function Ports({ data }: { data: CanvasNodeData }): JSX.Element {
  return (
    <>
      {data.hasInput ? (
        <Handle
          type="target"
          position={HandlePosition.Left}
          className={styles.port}
          isConnectable={false}
        />
      ) : null}
      {data.hasOutput ? (
        <Handle
          type="source"
          position={HandlePosition.Right}
          className={styles.port}
          isConnectable={false}
        />
      ) : null}
    </>
  );
}

/** The run figures a card wears while a flow is running: items through, and how busy. */
function useRunLine(data: CanvasNodeData): { line: string | null; state: NodeState | null } {
  const { nodeStatus } = useCanvas();
  const status = stateOfGroup(nodeStatus, data.runKey);
  if (!status) return { line: null, state: null };
  const items = status.items_out || status.items_in;
  const busy = Math.round(status.busy_share * 100);
  return { line: `${items.toLocaleString()} items · ${String(busy)}% busy`, state: status.state };
}

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export function BlockCardNode({ data, selected }: NodeProps): JSX.Element {
  const card = data as CanvasNodeData;
  const { severity } = useCanvas();
  const run = useRunLine(card);
  const mark = card.problemPath === null ? undefined : severity[card.problemPath];
  return (
    <div
      className={classes(styles.wrap, selected === true && styles.selectedWrap)}
      data-severity={mark ?? undefined}
      data-state={run.state ?? undefined}
      data-kind={card.kind}
      title={card.title}
    >
      <Ports data={card} />
      <BlockCard
        kind={card.kind}
        title={card.title}
        subtitle={run.line ?? card.subtitle}
        {...(run.state ? { state: run.state } : {})}
        selected={selected === true}
        hasInput={false}
        hasOutput={false}
        style={{ height: '100%', width: '100%' }}
      />
    </div>
  );
}

/** A farm's emitter and collector: the same card, half the size, at the ends of the group. */
export function EndCardNode({ data, selected }: NodeProps): JSX.Element {
  const card = data as CanvasNodeData;
  const { severity } = useCanvas();
  const run = useRunLine(card);
  const mark = card.problemPath === null ? undefined : severity[card.problemPath];
  return (
    <div
      className={classes(styles.wrap, styles.end, selected === true && styles.selectedWrap)}
      data-severity={mark ?? undefined}
      data-state={run.state ?? undefined}
      data-role={card.role ?? undefined}
      data-kind={card.kind}
    >
      <Ports data={card} />
      <span className={styles.endGlyph}>
        <Glyph kind={card.kind} size={14} />
      </span>
      <span className={styles.endText}>
        <span className={styles.endTitle}>{card.title}</span>
        <span className={styles.endSubtitle}>{card.subtitle}</span>
      </span>
      {run.state ? <StatusDot state={run.state} /> : null}
    </div>
  );
}

/** A comb is one card showing the two nodes it fuses onto one thread. */
export function CombCardNode({ data, selected }: NodeProps): JSX.Element {
  const card = data as CanvasNodeData;
  const { severity } = useCanvas();
  const run = useRunLine(card);
  const mark = card.problemPath === null ? undefined : severity[card.problemPath];
  return (
    <div
      className={classes(styles.wrap, styles.comb, selected === true && styles.selectedWrap)}
      data-severity={mark ?? undefined}
      data-state={run.state ?? undefined}
      data-kind={card.kind}
    >
      <Ports data={card} />
      <span className={styles.stripe} />
      <div className={styles.combHead}>
        <span className={styles.glyph}>
          <Glyph kind={card.kind} size={17} />
        </span>
        <span className={styles.headText}>
          <span className={styles.title}>{card.title}</span>
          <span className={styles.subtitle}>{run.line ?? card.subtitle}</span>
        </span>
        {run.state ? <StatusDot state={run.state} /> : null}
      </div>
      <div className={styles.combParts}>
        {card.parts.map((part, index) => (
          <span key={`${part}-${String(index)}`} className={styles.combPart}>
            {part}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A farm, a loop, an all-to-all or a nested pipeline: a panel holding its cards. */
export function BlockGroupNode({ data, selected }: NodeProps): JSX.Element {
  const card = data as CanvasNodeData;
  const { severity } = useCanvas();
  const run = useRunLine(card);
  const mark = card.problemPath === null ? undefined : severity[card.problemPath];
  return (
    <div
      className={classes(styles.group, selected === true && styles.selectedWrap)}
      data-severity={mark ?? undefined}
      data-state={run.state ?? undefined}
      data-kind={card.kind}
    >
      <Ports data={card} />
      <span className={styles.stripe} />
      <div className={styles.groupHead}>
        <span className={styles.glyph}>
          <Glyph kind={card.kind} size={17} />
        </span>
        <span className={styles.headText}>
          <span className={styles.title}>{card.title}</span>
          <span className={styles.subtitle}>{run.line ?? card.subtitle}</span>
        </span>
        <span className={styles.badges}>
          {card.badges.map((badge) => (
            <span key={badge} className={styles.badge}>
              {badge}
            </span>
          ))}
        </span>
        {run.state ? <StatusDot state={run.state} /> : null}
      </div>
    </div>
  );
}
