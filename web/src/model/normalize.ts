/**
 * Reading the server's JSON into the model types.
 *
 * The client is hand-typed against the contract until the OpenAPI generator lands, so
 * this is where a model from the wire gets its missing pieces: farm options an older
 * writer left out, a tree the parser wrote without `name` or `merge`. It fills, it never
 * rejects: a shape we do not know is kept as an `inline` expression rather than lost.
 */

import { farmOptions } from './tree';
import {
  COLLECT_POLICIES,
  EMIT_POLICIES,
  RUNTIMES,
  type CollectPolicy,
  type EmitPolicy,
  type FarmOptions,
  type FlowModel,
  type Layout,
  type NodeDef,
  type NodeKind,
  type Runtime,
  type Tree,
} from './types';

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return typeof value === 'object' && value !== null ? (value as Raw) : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const NODE_KINDS: readonly NodeKind[] = ['source', 'node', 'sink', 'raw'];

export function normalizeNode(raw: unknown): NodeDef {
  const data = asRecord(raw);
  return {
    id: asString(data.id, 'node'),
    kind: oneOf<NodeKind>(data.kind, NODE_KINDS, 'node'),
    is_class: asBool(data.is_class),
    is_async: asBool(data.is_async),
    params: asStrings(data.params),
    doc: asStringOrNull(data.doc),
    source: asString(data.source),
  };
}

/** A block option that is a tree, `false` (no end at all) or `null` (the default one). */
function normalizeSlot(value: unknown): Tree | false | null {
  if (value === false) return false;
  if (value === null || value === undefined) return null;
  return normalizeTree(value);
}

function normalizeOptions(raw: unknown): FarmOptions {
  const data = asRecord(raw);
  return farmOptions({
    emit: oneOf<EmitPolicy>(data.emit, EMIT_POLICIES, 'round_robin'),
    collect:
      data.collect === null || data.collect === undefined
        ? null
        : oneOf<CollectPolicy>(data.collect, COLLECT_POLICIES, 'first_come'),
    ordered: asBool(data.ordered),
    emitter: normalizeSlot(data.emitter),
    collector: normalizeSlot(data.collector),
    key:
      data.key === null || data.key === undefined || data.key === false
        ? null
        : normalizeTree(data.key),
    prefetch: asNumberOrNull(data.prefetch) ?? 1,
    window: asNumberOrNull(data.window),
    name: asStringOrNull(data.name),
    capacity: asNumberOrNull(data.capacity),
    runtime:
      data.runtime === null || data.runtime === undefined
        ? null
        : oneOf<Runtime>(data.runtime, RUNTIMES, 'threads'),
  });
}

/** A tree from the wire, with every optional field filled in. */
export function normalizeTree(raw: unknown): Tree {
  const data = asRecord(raw);
  switch (data.type) {
    case 'start':
      return { type: 'start' };
    case 'ref':
      return { type: 'ref', id: asString(data.id) };
    case 'pipeline':
      return {
        type: 'pipeline',
        stages: (Array.isArray(data.stages) ? data.stages : []).map(normalizeTree),
      };
    case 'farm': {
      const worker = Array.isArray(data.worker)
        ? data.worker.map(normalizeTree)
        : normalizeTree(data.worker);
      const workers = Array.isArray(worker) ? worker.length : (asNumberOrNull(data.workers) ?? 4);
      return { type: 'farm', worker, workers, options: normalizeOptions(data.options) };
    }
    case 'comb':
      return { type: 'comb', first: normalizeTree(data.first), second: normalizeTree(data.second) };
    case 'feedback':
      return {
        type: 'feedback',
        inner: normalizeTree(data.inner),
        name: asStringOrNull(data.name),
      };
    case 'all2all':
      return {
        type: 'all2all',
        left: normalizeTree(data.left),
        right: normalizeTree(data.right),
        R: data.R === null || data.R === undefined ? null : normalizeTree(data.R),
        G: data.G === null || data.G === undefined ? null : normalizeTree(data.G),
        merge: asBool(data.merge),
      };
    case 'inline':
      return { type: 'inline', source: asString(data.source) };
    default:
      // Not a shape we know: keep whatever text there is rather than lose the stage.
      return { type: 'inline', source: asString(data.source, JSON.stringify(raw)) };
  }
}

export function normalizeModel(raw: unknown): FlowModel {
  const data = asRecord(raw);
  return {
    version: asNumberOrNull(data.version) ?? 1,
    name: asString(data.name, 'flow'),
    doc: asStringOrNull(data.doc),
    prelude: asStrings(data.prelude),
    nodes: (Array.isArray(data.nodes) ? data.nodes : []).map(normalizeNode),
    flow: normalizeTree(data.flow),
    start: asStringOrNull(data.start),
    main: asStringOrNull(data.main),
    epilogue: asStrings(data.epilogue),
    build_notes: asStrings(data.build_notes),
    guard: asStringOrNull(data.guard),
  };
}

export function normalizeLayout(raw: unknown): Layout {
  const data = asRecord(raw);
  const positions: Layout['positions'] = {};
  for (const [key, value] of Object.entries(asRecord(data.positions))) {
    const point = asRecord(value);
    positions[key] = { x: asNumberOrNull(point.x) ?? 0, y: asNumberOrNull(point.y) ?? 0 };
  }
  const viewport =
    data.viewport === null || data.viewport === undefined ? null : asRecord(data.viewport);
  return {
    version: asNumberOrNull(data.version) ?? 1,
    positions,
    viewport: viewport
      ? {
          x: asNumberOrNull(viewport.x) ?? 0,
          y: asNumberOrNull(viewport.y) ?? 0,
          zoom: asNumberOrNull(viewport.zoom) ?? 1,
        }
      : null,
    samples: (Array.isArray(data.samples) ? data.samples : []).map((sample) => {
      const item = asRecord(sample);
      return {
        name: asString(item.name),
        items: Array.isArray(item.items) ? item.items : [],
      };
    }),
  };
}

export function emptyLayout(): Layout {
  return { version: 1, positions: {}, viewport: null, samples: [] };
}
