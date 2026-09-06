import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { JSX } from 'react';
import type { EdgeData } from './buildGraph';
import { useCanvas } from './CanvasContext';
import styles from './edges.module.css';

/* Two edge shapes: `>>` between stages (and inside a farm), and the loop a feedback
 * block draws back around its own block. Both show the queue depth when a run is
 * attached, because a queue filling up is the first thing a person wants to see. */

function QueueBadge({ edge, x, y }: { edge: EdgeData; x: number; y: number }): JSX.Element | null {
  const { edgeStatus } = useCanvas();
  const status = edgeStatus[edge.runKey];
  if (!status || status.queued <= 0) return null;
  return (
    <EdgeLabelRenderer>
      <div
        className={styles.queue}
        style={{ transform: `translate(-50%, -50%) translate(${String(x)}px, ${String(y)}px)` }}
      >
        {status.queued.toLocaleString()}
      </div>
    </EdgeLabelRenderer>
  );
}

export function FlowEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data } =
    props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.32,
  });
  const edge = (data ?? { kind: 'flow', runKey: '' }) as EdgeData;
  return (
    <>
      <BaseEdge
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        className={styles[edge.kind] ?? styles.flow}
      />
      <QueueBadge edge={edge} x={labelX} y={labelY} />
    </>
  );
}

/**
 * The feedback edge: out of the block's right port, under it, and back into its left one.
 * It is the one edge that says something the layout cannot -- that this block feeds itself.
 */
export function LoopEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY, markerEnd, data } = props;
  const edge = (data ?? { kind: 'loop', runKey: '' }) as EdgeData;
  const dip = edge.dip > 0 ? edge.dip : 52;
  const reach = 26;
  const under = Math.max(sourceY, targetY) + dip;
  const path = [
    `M ${String(sourceX)},${String(sourceY)}`,
    `C ${String(sourceX + reach)},${String(sourceY)} ${String(sourceX + reach)},${String(under)} ${String(sourceX)},${String(under)}`,
    `L ${String(targetX)},${String(under)}`,
    `C ${String(targetX - reach)},${String(under)} ${String(targetX - reach)},${String(targetY)} ${String(targetX)},${String(targetY)}`,
  ].join(' ');
  return (
    <>
      <BaseEdge
        path={path}
        {...(markerEnd === undefined ? {} : { markerEnd })}
        className={styles.loop}
      />
      <QueueBadge edge={edge} x={(sourceX + targetX) / 2} y={under} />
    </>
  );
}
