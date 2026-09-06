import { describe, expect, it } from 'vitest';
import {
  addParam,
  moveParam,
  newParamName,
  paramNameError,
  removeParam,
  renameParam,
  setParam,
} from './edits';
import type { FlowParam } from './types';

/* `build()`'s keyword-only parameters (docs/web-interfaces.md, E). The helpers are pure:
 * a list in, a new list out, and nothing checked that `paramNameError` does not say. */

const PARAMS: FlowParam[] = [
  { name: 'factor', default: '2', annotation: 'int' },
  { name: 'label', default: '"x"', annotation: 'str' },
];

describe('what a parameter may be called', () => {
  it('takes a Python identifier and nothing else', () => {
    expect(paramNameError('threshold', PARAMS)).toBeNull();
    expect(paramNameError('_x2', PARAMS)).toBeNull();
    expect(paramNameError('', PARAMS)).toMatch(/needs a name/);
    expect(paramNameError('2fast', PARAMS)).toMatch(/not starting with a digit/);
    expect(paramNameError('a b', PARAMS)).toMatch(/underscores/);
  });

  it('refuses a keyword and the names build() already has', () => {
    expect(paramNameError('class', PARAMS)).toMatch(/keyword/);
    expect(paramNameError('None', PARAMS)).toMatch(/keyword/);
    expect(paramNameError('source', PARAMS)).toMatch(/already takes/);
  });

  it('refuses a name another parameter has, but not the one being renamed', () => {
    expect(paramNameError('label', PARAMS)).toMatch(/already a parameter/);
    expect(paramNameError('label', PARAMS, 'label')).toBeNull();
  });

  it('finds a free name for a new one', () => {
    expect(newParamName([])).toBe('value');
    expect(newParamName([{ name: 'value', default: 'None', annotation: null }])).toBe('value2');
  });
});

describe('editing the list', () => {
  it('adds at the end, where build() declares it', () => {
    const next = addParam(PARAMS, { name: 'loud', default: 'False', annotation: 'bool' });
    expect(next.map((p) => p.name)).toEqual(['factor', 'label', 'loud']);
    expect(PARAMS).toHaveLength(2); // the input is untouched
  });

  it('renames one and leaves the others alone', () => {
    const next = renameParam(PARAMS, 'factor', 'scale');
    expect(next.map((p) => p.name)).toEqual(['scale', 'label']);
    expect(next[1]).toBe(PARAMS[1]);
  });

  it('retypes one: the default literal and the annotation together', () => {
    const next = setParam(PARAMS, 'factor', { default: '""', annotation: 'str' });
    expect(next[0]).toEqual({ name: 'factor', default: '""', annotation: 'str' });
  });

  it('removes one by name, and shrugs at a name nothing has', () => {
    expect(removeParam(PARAMS, 'label').map((p) => p.name)).toEqual(['factor']);
    expect(removeParam(PARAMS, 'nope')).toHaveLength(2);
  });

  it('moves one, clamping to the ends', () => {
    expect(moveParam(PARAMS, 'label', 0).map((p) => p.name)).toEqual(['label', 'factor']);
    expect(moveParam(PARAMS, 'factor', 9).map((p) => p.name)).toEqual(['label', 'factor']);
    expect(moveParam(PARAMS, 'nope', 0).map((p) => p.name)).toEqual(['factor', 'label']);
  });
});
