/**
 * `localStorage`, guarded.
 *
 * A private window, a locked-down webview and a browser with site data blocked all throw
 * from the accessor itself, and no remembered preference is worth breaking the app for.
 * Everything the app remembers between visits goes through these three functions.
 */

export function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* the preference is lost for this session only */
  }
}

/** A remembered number, clamped, with the default when nothing is stored or it is junk. */
export function readNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = readStorage(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
