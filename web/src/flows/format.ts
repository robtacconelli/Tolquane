/** Small formatters the workspace list needs; kept out of the component file so the
 * module exports components only and fast refresh keeps working. */

/** `1.3 kB`, `840 B`: enough to tell a stub from a real flow at a glance. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1000) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} kB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** The directory a flow lives in, or nothing when it sits at the top of the workspace. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/**
 * A workspace path short enough for a panel header: as much of its tail as fits in
 * `budget` characters, with the whole of it left in the `title` for anyone who needs it.
 * The tail is the part that says where you are; the root of a home directory is not.
 */
export function shortPath(path: string, budget = 34): string {
  if (path.length <= budget) return path;
  const parts = path.split('/').filter(Boolean);
  const kept: string[] = [];
  let width = 0;
  for (let at = parts.length - 1; at >= 0; at -= 1) {
    const part = parts[at] ?? '';
    if (kept.length > 0 && width + part.length + 1 > budget) break;
    kept.unshift(part);
    width += part.length + 1;
  }
  return `…/${kept.join('/')}`;
}
