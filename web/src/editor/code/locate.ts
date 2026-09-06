/**
 * Finding one's way between the file and the model: which line a node is defined on,
 * which line the parser is complaining about, and where the canvas positions go when the
 * tree is parsed afresh rather than edited.
 */

import { children, joinPath, ROOT, type Position, type Tree } from '../../model';

/** The one-based line where a node's definition starts, decorators included. */
export function lineOfNode(source: string, definition: string, id: string): number | null {
  // The whole definition, when the file still holds it exactly as the model does.
  if (definition.includes(id)) {
    const at = source.indexOf(definition);
    if (at !== -1) return source.slice(0, at).split('\n').length;
  }

  const lines = source.split('\n');
  const head = new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${escape(id)}\\b`);
  const index = lines.findIndex((line) => head.test(line));
  if (index === -1) return null;
  // Walk back over the decorator lines: `@tq.node` is where the definition starts to read.
  let start = index;
  while (start > 0 && /^\s*@/.test(lines[start - 1] ?? '')) start -= 1;
  return start + 1;
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The line a parse failure names, as Python writes it: `(<unknown>, line 19)`. */
export function parseErrorLine(reason: string): number | null {
  const found = /\bline (\d+)/.exec(reason);
  if (!found?.[1]) return null;
  const line = Number(found[1]);
  return Number.isFinite(line) && line > 0 ? line : null;
}

/**
 * What a block is, for the purpose of recognising it again after the file was re-parsed.
 *
 * The layout sidecar is keyed by tree path, and a fresh parse builds new objects, so the
 * identity trick the canvas edits use (`pathRenames`) has nothing to hold on to. Names
 * do: a stage that is still `words` keeps its card, wherever in the pipeline it moved to.
 */
function label(tree: Tree): string {
  switch (tree.type) {
    case 'ref':
      return `ref:${tree.id}`;
    case 'inline':
      return `inline:${tree.source.trim()}`;
    case 'farm':
      return `farm:${Array.isArray(tree.worker) ? 'many' : label(tree.worker)}`;
    case 'feedback':
      return `feedback:${tree.name ?? ''}`;
    case 'comb':
      return `comb:${label(tree.first)}`;
    case 'all2all':
      return `all2all:${label(tree.left)}`;
    default:
      return tree.type;
  }
}

function labels(tree: Tree, base = ROOT, into = new Map<string, string>()): Map<string, string> {
  into.set(base, label(tree));
  for (const child of children(tree)) labels(child.tree, joinPath(base, child.key), into);
  return into;
}

/**
 * The layout positions re-keyed for a tree that came back from the parser. A card whose
 * path still names the same kind of block keeps its place; one that moved is followed by
 * name as long as the name is unambiguous; anything else is dropped so the sidecar does
 * not fill up with ghosts. The same object comes back when nothing moved.
 */
export function relayout(
  before: Tree | null,
  after: Tree,
  positions: Record<string, Position>,
): Record<string, Position> {
  const entries = Object.entries(positions);
  if (entries.length === 0 || !before) return positions;
  const was = labels(before);
  const now = labels(after);

  // Only names that appear exactly once on each side can be followed without guessing.
  const count = (map: Map<string, string>): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const [path, name] of map) out.set(name, [...(out.get(name) ?? []), path]);
    return out;
  };
  const byName = count(now);
  const wasByName = count(was);

  const out: Record<string, Position> = {};
  let moved = false;
  for (const [path, position] of entries) {
    const name = was.get(path);
    if (name === undefined) continue;
    if (now.get(path) === name) {
      out[path] = position;
      continue;
    }
    const here = byName.get(name);
    const there = wasByName.get(name);
    if (here?.length === 1 && there?.length === 1 && here[0] !== undefined) {
      out[here[0]] = position;
      moved = true;
    } else {
      moved = true;
    }
  }
  return moved || Object.keys(out).length !== entries.length ? out : positions;
}
