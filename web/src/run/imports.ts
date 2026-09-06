/**
 * What the import probe found, as problems the Problems tab can show.
 *
 * `POST /api/flows/{path}/check` answers `imports` when the flow checks, and carries the
 * same list in the `detail` of its 400 when it does not (section E, "as built"): an
 * `import pandas` that is not installed is exactly the failure whose fix belongs here.
 * A missing module is a *warning*, not an error -- the flow is fine, the interpreter is
 * not -- and it comes with the `pip install` line that ends it.
 */

import type { Schemas } from '../api/client';
import type { Problem } from '../model';

export type ImportProbe = Schemas['ImportProbe'];

/** The modules this interpreter could not import, as warnings with their hints. */
export function importProblems(imports: readonly ImportProbe[] | undefined): Problem[] {
  return (imports ?? [])
    .filter((probe) => !probe.ok)
    .map((probe) => ({
      path: null,
      message: `${probe.module} is not installed for the interpreter runs use.`,
      severity: 'warning' as const,
      source: 'server' as const,
      ...(probe.hint ? { hint: probe.hint } : {}),
    }));
}

/**
 * The probe list inside a failed check.
 *
 * `ApiError.detail` is the whole body, and the body is the server's envelope, so the
 * list is at `error.detail.imports`. Anything else -- a proxy's HTML, a timeout with no
 * body at all -- is simply no imports rather than a second failure on top of the first.
 */
export function importsFromError(detail: unknown): ImportProbe[] {
  if (!detail || typeof detail !== 'object') return [];
  const envelope = (detail as { error?: unknown }).error;
  const inner =
    envelope && typeof envelope === 'object' ? (envelope as { detail?: unknown }).detail : null;
  const imports =
    inner && typeof inner === 'object' ? (inner as { imports?: unknown }).imports : null;
  if (!Array.isArray(imports)) return [];
  return imports.filter(
    (probe): probe is ImportProbe =>
      typeof probe === 'object' &&
      probe !== null &&
      typeof (probe as ImportProbe).module === 'string' &&
      typeof (probe as ImportProbe).ok === 'boolean',
  );
}
