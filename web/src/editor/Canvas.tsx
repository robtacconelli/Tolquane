import {
  Background,
  BackgroundVariant,
  getNodesBounds,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type DragEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Icon } from '../components/Icon';
import { templateFor, type CardKind, type Position } from '../model';
import { useFlowStore, useProblems } from '../store/flow';
import type { RunEdgeStatus, RunNodeStatus } from '../store/run';
import { autoLayoutStages } from './autoLayout';
import { buildGraph, type CanvasEdge, type CanvasNode, type CanvasNodeData } from './buildGraph';
import { CanvasContext, type CanvasContextValue } from './CanvasContext';
import { BLOCK_DRAG_TYPE } from './dragTypes';
import { FlowEdge, LoopEdge } from './edges';
import { buildExpandedGraph } from './expandedGraph';
import { BlockCardNode, BlockGroupNode, CombCardNode, EndCardNode } from './nodes';
import styles from './Canvas.module.css';
import '@xyflow/react/dist/style.css';

/* The canvas. It is the whole reason this chunk is loaded lazily: React Flow and dagre
 * are the two heaviest things in the app, and the flows list, the runs page and the
 * settings page have no use for either. */

const nodeTypes = {
  blockCard: BlockCardNode,
  blockGroup: BlockGroupNode,
  endCard: EndCardNode,
  combCard: CombCardNode,
};

const edgeTypes = { flowEdge: FlowEdge, loopEdge: LoopEdge };

/* Opening a flow never zooms so far out that the cards stop being readable: one wider
 * than the canvas starts at its head, to be panned through. Asking to fit, on the other
 * hand, means fit -- however small that turns out to be. */
const FIT = { padding: '32px', minZoom: 0.55, maxZoom: 1 } as const;
const FIT_ALL = { padding: '32px', minZoom: 0.15, maxZoom: 1 } as const;

const MARKERS = {
  flow: { type: MarkerType.ArrowClosed, color: 'var(--tq-border-strong)', width: 13, height: 13 },
  farm: { type: MarkerType.ArrowClosed, color: 'var(--tq-border)', width: 12, height: 12 },
  cross: { type: MarkerType.ArrowClosed, color: 'var(--tq-accent-line)', width: 12, height: 12 },
  loop: { type: MarkerType.ArrowClosed, color: 'var(--tq-accent)', width: 12, height: 12 },
} as const;

export interface CanvasProps {
  /**
   * The live run, from `src/store/run.ts`. F4 fills these in; every card colours its dot
   * from the first and every edge shows its queue depth from the second.
   */
  nodeStatus?: Record<string, RunNodeStatus>;
  edgeStatus?: Record<string, RunEdgeStatus>;
  /** The properties panel's "edit code" button; F3 hands this a real editor. */
  onEditCode?: (nodeId: string) => void;
}

export default function Canvas(props: CanvasProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

/** The overview keeps the canvas's own reading: structure in the accent, stages neutral. */
function miniMapColor(node: CanvasNode): string {
  const kind = node.data.kind;
  if (kind === 'source') return 'var(--tq-node-done)';
  if (kind === 'sink') return 'var(--tq-node-failed)';
  if (node.data.variant === 'group') return 'var(--tq-accent-line)';
  return 'var(--tq-border-strong)';
}

function withMarkers(edges: CanvasEdge[]): CanvasEdge[] {
  return edges.map((edge) => ({ ...edge, markerEnd: MARKERS[edge.data?.kind ?? 'flow'] }));
}

function CanvasInner({ nodeStatus, edgeStatus }: CanvasProps): JSX.Element {
  const model = useFlowStore((state) => state.model);
  const positions = useFlowStore((state) => state.layout.positions);
  const viewport = useFlowStore((state) => state.layout.viewport);
  const selected = useFlowStore((state) => state.selected);
  const expanded = useFlowStore((state) => state.expanded);
  const graph = useFlowStore((state) => state.graph);
  const codeOnly = useFlowStore((state) => state.codeOnly);
  const problems = useProblems();

  const select = useFlowStore((state) => state.select);
  const setPosition = useFlowStore((state) => state.setPosition);
  const setPositions = useFlowStore((state) => state.setPositions);
  const setViewport = useFlowStore((state) => state.setViewport);
  const beginChange = useFlowStore((state) => state.beginChange);
  const removeBlock = useFlowStore((state) => state.removeBlock);
  const appendBlock = useFlowStore((state) => state.appendBlock);

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>([]);
  const {
    screenToFlowPosition,
    zoomIn,
    zoomOut,
    fitView,
    getNodes,
    getViewport,
    setViewport: moveTo,
  } = useReactFlow();
  const zoom = useViewport().zoom;
  const wrapper = useRef<HTMLDivElement>(null);
  const dropped = useRef<Position | null>(null);

  /*
   * Fit, then, when the flow is wider than the canvas even at the smallest readable
   * zoom, put its head at the left edge rather than centring the overflow: a flow is
   * read from its source, and half a source card on the left edge reads as broken.
   */
  const fitFlow = useCallback(
    (duration = 0, everything = false): void => {
      const options = everything ? FIT_ALL : FIT;
      void fitView({ ...options, ...(duration > 0 ? { duration } : {}) }).then(() => {
        const bounds = getNodesBounds(getNodes());
        const view = getViewport();
        const width = wrapper.current?.clientWidth ?? 0;
        if (bounds.width * view.zoom <= width - 64) return;
        void moveTo(
          { x: 32 - bounds.x * view.zoom, y: view.y, zoom: view.zoom },
          duration > 0 ? { duration } : undefined,
        );
      });
    },
    [fitView, getNodes, getViewport, moveTo],
  );

  const readOnly = codeOnly !== null || expanded;
  const showThreads = expanded || model === null;

  const built = useMemo(() => {
    if (showThreads) return graph ? buildExpandedGraph(graph) : { nodes: [], edges: [] };
    if (!model) return { nodes: [], edges: [] };
    return buildGraph(model, positions);
  }, [model, positions, graph, showThreads]);

  const stages = useMemo(
    () => (model ? buildGraph(model, positions).stages : []),
    [model, positions],
  );

  /* A flow with no sidecar is laid out the moment it opens: nobody should meet a pile of
   * cards at the origin. Dagre only ever fills in what the sidecar does not say. */
  useEffect(() => {
    if (showThreads || stages.length === 0) return;
    const missing = stages.some((stage) => positions[stage.path] === undefined);
    if (!missing) return;
    setPositions(autoLayoutStages(stages), false);
    if (!viewport) window.setTimeout(() => fitFlow(), 0);
  }, [stages, positions, setPositions, showThreads, fitFlow, viewport]);

  const severity = useMemo(() => {
    const out: Record<string, 'error' | 'warning'> = {};
    for (const problem of problems) {
      if (problem.path === null) continue;
      if (problem.severity === 'error' || out[problem.path] === undefined) {
        out[problem.path] = problem.severity;
      }
    }
    return out;
  }, [problems]);

  useEffect(() => {
    setNodes(
      built.nodes.map((node) => ({
        ...node,
        selected: !showThreads && node.data.path === selected,
      })),
    );
    setEdges(withMarkers(built.edges));
  }, [built, selected, showThreads, setNodes, setEdges]);

  const context = useMemo<CanvasContextValue>(
    () => ({
      nodeStatus: nodeStatus ?? {},
      edgeStatus: edgeStatus ?? {},
      severity,
      selected,
      readOnly,
    }),
    [nodeStatus, edgeStatus, severity, selected, readOnly],
  );

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      if (showThreads) return;
      select((node.data as CanvasNodeData).path);
    },
    [select, showThreads],
  );

  const onDragStart = useCallback<OnNodeDrag>(() => beginChange(), [beginChange]);
  const onDragStop = useCallback<OnNodeDrag>(
    (_event, node) => setPosition(node.id, node.position),
    [setPosition],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(BLOCK_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData(BLOCK_DRAG_TYPE) as CardKind | '';
      if (!kind || !model || readOnly) return;
      const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const template = templateFor(kind, model);
      dropped.current = { x: at.x - 104, y: at.y - 32 };
      appendBlock(template.block, template.nodes);
    },
    [appendBlock, model, readOnly, screenToFlowPosition],
  );

  /* The block a person dropped belongs where they dropped it, not at the end of the row
   * dagre would give it; the append had to happen first to know its path. A block added
   * by a click has no place of its own, so the canvas goes to meet it instead. */
  const lastSelected = useRef<string | null>(null);
  const nodeCount = useRef(0);
  useEffect(() => {
    const added = built.nodes.length > nodeCount.current;
    nodeCount.current = built.nodes.length;
    if (selected === null || selected === lastSelected.current) return;
    lastSelected.current = selected;
    if (dropped.current) {
      setPosition(selected, dropped.current);
      dropped.current = null;
    } else if (added) {
      const { zoom } = getViewport();
      window.setTimeout(() => {
        void fitView({
          nodes: [{ id: selected }],
          minZoom: zoom,
          maxZoom: zoom,
          padding: '80px',
          duration: 220,
        });
      }, 0);
    }
  }, [built, selected, setPosition, fitView, getViewport]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (readOnly || selected === null) return;
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      event.preventDefault();
      removeBlock(selected);
    },
    [readOnly, removeBlock, selected],
  );

  const tidy = useCallback(() => {
    if (stages.length === 0) return;
    beginChange();
    setPositions(autoLayoutStages(stages));
    window.setTimeout(() => fitFlow(220), 0);
  }, [beginChange, fitFlow, setPositions, stages]);

  const empty = !showThreads && built.nodes.length === 0;

  return (
    <div
      className={styles.canvas}
      ref={wrapper}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onKeyDown={onKeyDown}
      role="application"
      aria-label="Flow canvas"
      tabIndex={-1}
    >
      <CanvasContext value={context}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDragStart={onDragStart}
          onNodeDragStop={onDragStop}
          onPaneClick={() => select(null)}
          onMoveEnd={(_event, next) => setViewport(next)}
          {...(viewport ? { defaultViewport: viewport } : { fitView: true })}
          fitViewOptions={FIT}
          minZoom={0.2}
          maxZoom={2}
          nodesConnectable={false}
          nodesDraggable={!readOnly}
          elementsSelectable
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          selectionKeyCode={null}
          proOptions={{ hideAttribution: true }}
          className={styles.flow}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1}
            color="var(--tq-border)"
            bgColor="var(--tq-surface-sunken)"
          />
          <MiniMap
            className={styles.minimap}
            pannable
            zoomable
            ariaLabel="Flow overview"
            maskColor="color-mix(in srgb, var(--tq-surface-sunken) 76%, transparent)"
            bgColor="var(--tq-surface)"
            nodeColor={miniMapColor}
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
          />
        </ReactFlow>

        {empty ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyTitle}>An empty canvas</p>
            <p className={styles.emptyBody}>
              Drag a block from the left, or click one to add it to the end of the flow.
            </p>
          </div>
        ) : null}

        <div className={styles.controls}>
          <button
            type="button"
            className={styles.control}
            onClick={tidy}
            title="Tidy up the layout"
          >
            <Icon name="canvas" size={15} />
            Tidy up
          </button>
          <span className={styles.controlDivider} />
          <button
            type="button"
            className={styles.control}
            onClick={() => void zoomOut({ duration: 120 })}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className={styles.zoomLevel}>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className={styles.control}
            onClick={() => void zoomIn({ duration: 120 })}
            aria-label="Zoom in"
          >
            +
          </button>
          <span className={styles.controlDivider} />
          <button
            type="button"
            className={styles.control}
            onClick={() => fitFlow(220, true)}
            title="Fit the whole flow in the view"
          >
            Fit
          </button>
        </div>
      </CanvasContext>
    </div>
  );
}
