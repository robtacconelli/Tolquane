/**
 * The flow model as TypeScript, mirroring `docs/web-interfaces.md`, S1.
 *
 * The Python file is the artifact and this is a view of it: node bodies are kept as the
 * text their author wrote (`NodeDef.source`), and only the composition is structure (the
 * `Tree`). Anything the model cannot say is an `inline` expression, kept verbatim.
 *
 * Every field here exists in the JSON the server sends; `normalizeModel` fills in the
 * ones an older or hand-written model leaves out, so the rest of the app can read them
 * without guarding.
 */

/** What a node definition is, as `tq.` writes it. */
export type NodeKind = 'source' | 'node' | 'sink' | 'raw';

export interface NodeDef {
  id: string;
  kind: NodeKind;
  is_class: boolean;
  is_async: boolean;
  /** Positional parameter names of the function, or of `__call__` for a class. */
  params: string[];
  doc: string | null;
  /** The whole definition, decorator lines included, verbatim. */
  source: string;
}

export const EMIT_POLICIES = ['round_robin', 'on_demand', 'broadcast', 'scatter', 'key'] as const;
export const COLLECT_POLICIES = ['first_come', 'round_robin', 'ordered', 'gather'] as const;
export const RUNTIMES = ['threads', 'processes'] as const;

export type EmitPolicy = (typeof EMIT_POLICIES)[number];
export type CollectPolicy = (typeof COLLECT_POLICIES)[number];
export type Runtime = (typeof RUNTIMES)[number];

/**
 * A farm's options. `emitter` and `collector` are a block (a node of this flow, or an
 * expression), `false` to expose the workers directly, or `null` for the default one.
 */
export interface FarmOptions {
  emit: EmitPolicy;
  collect: CollectPolicy | null;
  ordered: boolean;
  emitter: Tree | false | null;
  collector: Tree | false | null;
  key: Tree | null;
  prefetch: number;
  window: number | null;
  name: string | null;
  capacity: number | null;
  runtime: Runtime | null;
}

/** The flow's input slot: `start`, which is the start node or `tq.from_iterable(source)`. */
export interface StartTree {
  type: 'start';
}

/** One of the flow's own nodes, by id. */
export interface RefTree {
  type: 'ref';
  id: string;
}

/** An expression the model does not understand, kept as text and rendered back as it was. */
export interface InlineTree {
  type: 'inline';
  source: string;
}

export interface PipelineTree {
  type: 'pipeline';
  stages: Tree[];
}

/** A worker list is FastFlow's heterogeneous farm: one worker per callable. */
export interface FarmTree {
  type: 'farm';
  worker: Tree | Tree[];
  workers: number;
  options: FarmOptions;
}

export interface CombTree {
  type: 'comb';
  first: Tree;
  second: Tree;
}

export interface FeedbackTree {
  type: 'feedback';
  inner: Tree;
  name: string | null;
}

export interface All2AllTree {
  type: 'all2all';
  left: Tree;
  right: Tree;
  R: Tree | null;
  G: Tree | null;
  merge: boolean;
}

export type Tree =
  | StartTree
  | RefTree
  | InlineTree
  | PipelineTree
  | FarmTree
  | CombTree
  | FeedbackTree
  | All2AllTree;

export type TreeType = Tree['type'];

/** The blocks that hold other blocks; everything else is a leaf card on the canvas. */
export const CONTAINER_TYPES: readonly TreeType[] = [
  'pipeline',
  'farm',
  'comb',
  'feedback',
  'all2all',
];

export interface FlowModel {
  version: number;
  name: string;
  doc: string | null;
  /** Top-level statements that are not a node, `build`, `main` or the guard, in order. */
  prelude: string[];
  nodes: NodeDef[];
  flow: Tree;
  /** The node used when `source is None`; `null` when the flow has no source slot. */
  start: string | null;
  /** `null` when `main()` is the standard call. */
  main: string | null;
  epilogue: string[];
  build_notes: string[];
  guard: string | null;
}

/** A file the model cannot represent: the canvas is read-only and says why. */
export interface CodeOnly {
  reason: string;
}

/* ------------------------------------------------------------------ the layout sidecar */

export interface Position {
  x: number;
  y: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** One saved input for the Run panel; `items` are JSON values. */
export interface Sample {
  name: string;
  items: unknown[];
}

export interface Layout {
  version: number;
  /** Keyed by the path of the tree element: `stages.1`, `stages.1.worker`. */
  positions: Record<string, Position>;
  viewport: Viewport | null;
  samples: Sample[];
}

/* -------------------------------------------------------------------- the expanded graph */

export interface GraphNode {
  name: string;
  kind: string;
  role: string | null;
  group: string | null;
  is_sink: boolean;
  is_async: boolean;
  tagged: boolean;
}

export interface GraphEdge {
  src: string;
  dst: string;
  rule: string;
  feedback: boolean;
  capacity: number | null;
  batch: number | null;
}

export interface GraphLoop {
  name: string;
  nodes: string[];
  heads: string[];
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  loops: GraphLoop[];
  windows: Record<string, number>;
}

/* ------------------------------------------------------------------------ the routes */

/** `GET /api/flows/{path}` and everything that answers with a flow. */
export interface FlowResponse {
  path: string;
  source: string;
  modified: string;
  model: FlowModel | null;
  code_only: CodeOnly | null;
  graph: GraphView | null;
  layout: Layout | null;
}
