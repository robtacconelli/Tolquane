import { describe, expect, it } from 'vitest';
import { importProblems, importsFromError } from './imports';

/* The import probe (docs/web-interfaces.md, E): a module the run interpreter cannot
 * import is a warning with the line that fixes it, not a failure of the flow. */

describe('what the probe found, as problems', () => {
  it('keeps only the modules that are missing', () => {
    const found = importProblems([
      { module: 'numpy', ok: true, hint: null },
      { module: 'cv2', ok: false, hint: 'pip install opencv-python' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      path: null,
      message: 'cv2 is not installed for the interpreter runs use.',
      severity: 'warning',
      source: 'server',
      hint: 'pip install opencv-python',
    });
  });

  it('is a warning even without a hint, and nothing at all for nothing', () => {
    expect(importProblems([{ module: 'x', ok: false, hint: null }])[0]?.severity).toBe('warning');
    expect(importProblems([{ module: 'x', ok: false, hint: null }])[0]?.hint).toBeUndefined();
    expect(importProblems(undefined)).toEqual([]);
    expect(importProblems([])).toEqual([]);
  });
});

describe('the probe inside a failed check', () => {
  it('finds the list in the server’s own envelope', () => {
    const detail = {
      error: {
        type: 'GraphError',
        message: "ModuleNotFoundError: No module named 'cv2'",
        detail: { imports: [{ module: 'cv2', ok: false, hint: 'pip install opencv-python' }] },
      },
    };
    expect(importsFromError(detail)).toEqual([
      { module: 'cv2', ok: false, hint: 'pip install opencv-python' },
    ]);
    expect(importProblems(importsFromError(detail))[0]?.hint).toBe('pip install opencv-python');
  });

  it('is empty rather than a second failure when the body is not that', () => {
    expect(importsFromError(null)).toEqual([]);
    expect(importsFromError('<html>502</html>')).toEqual([]);
    expect(importsFromError({ error: { message: 'x' } })).toEqual([]);
    expect(importsFromError({ error: { detail: { imports: 'no' } } })).toEqual([]);
    expect(importsFromError({ error: { detail: { imports: [{ nope: 1 }] } } })).toEqual([]);
  });
});
