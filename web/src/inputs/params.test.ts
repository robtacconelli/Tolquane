import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowParam } from '../model/types';
import {
  blankEnvRow,
  envNameError,
  envRecord,
  envRows,
  paramDefault,
  paramError,
  paramFieldType,
  paramInitial,
  paramText,
  paramValue,
  paramsToSend,
  pythonLiteral,
  readRunInputs,
  toPythonLiteral,
  writeRunInputs,
} from './params';

const param = (name: string, value: string, annotation: string | null = null): FlowParam => ({
  name,
  default: value,
  annotation,
});

describe('reading a literal the way the file wrote it', () => {
  it('knows the three words, numbers and both kinds of quote', () => {
    expect(pythonLiteral('True')).toEqual({ ok: true, value: true });
    expect(pythonLiteral('False')).toEqual({ ok: true, value: false });
    expect(pythonLiteral('None')).toEqual({ ok: true, value: null });
    expect(pythonLiteral('8')).toEqual({ ok: true, value: 8 });
    expect(pythonLiteral('-0.5')).toEqual({ ok: true, value: -0.5 });
    expect(pythonLiteral('1e3')).toEqual({ ok: true, value: 1000 });
    expect(pythonLiteral('"x"')).toEqual({ ok: true, value: 'x' });
    expect(pythonLiteral("'x y'")).toEqual({ ok: true, value: 'x y' });
  });

  it('reads a list and an object, with Python’s words in them', () => {
    expect(pythonLiteral('[1, 2]').value).toEqual([1, 2]);
    expect(pythonLiteral('{"a": True, "b": None}').value).toEqual({ a: true, b: null });
  });

  it('says so rather than guessing when it is not one', () => {
    expect(pythonLiteral('open("x")').ok).toBe(false);
    expect(pythonLiteral('{1, 2}').ok).toBe(false);
    expect(pythonLiteral('').ok).toBe(false);
  });

  it('writes a value back as the source a file would hold', () => {
    expect(toPythonLiteral(true)).toBe('True');
    expect(toPythonLiteral(null)).toBe('None');
    expect(toPythonLiteral(2)).toBe('2');
    expect(toPythonLiteral('x')).toBe('"x"');
    expect(toPythonLiteral([1, true, null])).toBe('[1,True,None]');
  });
});

describe('which field a parameter gets', () => {
  it('is read from the default the author wrote', () => {
    expect(paramFieldType(param('factor', '2'))).toBe('number');
    expect(paramFieldType(param('rate', '0.5'))).toBe('number');
    expect(paramFieldType(param('loud', 'False'))).toBe('boolean');
    expect(paramFieldType(param('label', '"x"'))).toBe('text');
    expect(paramFieldType(param('rows', '[1, 2]'))).toBe('code');
  });

  it('falls back to the annotation when the default is None', () => {
    expect(paramFieldType(param('path', 'None', 'str'))).toBe('text');
    expect(paramFieldType(param('n', 'None', 'int'))).toBe('number');
    expect(paramFieldType(param('on', 'None', 'bool'))).toBe('boolean');
    expect(paramFieldType(param('anything', 'None', 'dict[str, int]'))).toBe('code');
    expect(paramFieldType(param('maybe', 'None', 'str | None'))).toBe('text');
  });

  it('is a code field for a default nothing can read', () => {
    expect(paramFieldType(param('made', 'Path.cwd()'))).toBe('code');
  });
});

describe('a field’s text, its value and what is wrong with it', () => {
  it('starts at the default, and at what was remembered when there is one', () => {
    expect(paramDefault(param('factor', '2'))).toBe(2);
    expect(paramInitial(param('factor', '2'), {})).toBe(2);
    expect(paramInitial(param('factor', '2'), { factor: 9 })).toBe(9);
  });

  it('turns what is typed into the value that is sent', () => {
    expect(paramValue('number', ' 8 ')).toBe(8);
    expect(paramValue('text', ' hello ')).toBe(' hello ');
    expect(paramValue('boolean', 'True')).toBe(true);
    expect(paramValue('code', '[1, 2]')).toEqual([1, 2]);
  });

  it('shows a value as the text of its own kind of field', () => {
    expect(paramText('number', 8)).toBe('8');
    expect(paramText('text', 'x')).toBe('x');
    expect(paramText('boolean', true)).toBe('True');
    expect(paramText('code', { a: 1 })).toBe('{"a":1}');
  });

  it('refuses a number that is not one and a literal it cannot read', () => {
    expect(paramError('number', 'eight')).toBe('A number, like 8 or 0.5.');
    expect(paramError('number', '')).toBe('Enter a number.');
    expect(paramError('number', '0.5')).toBeNull();
    expect(paramError('code', 'open()')).toMatch(/literal/);
    expect(paramError('code', '{"a": 1}')).toBeNull();
    // Text is never wrong: any string is a string.
    expect(paramError('text', '')).toBeNull();
  });

  it('sends every parameter the flow declares, and nothing it does not', () => {
    const params = [param('factor', '2'), param('label', '"x"')];
    expect(paramsToSend(params, { factor: 9, stale: 1 })).toEqual({ factor: 9, label: 'x' });
  });
});

describe('the environment rows', () => {
  it('go to an object and back, ignoring a row with no name yet', () => {
    const rows = envRows({ TZ: 'UTC' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'TZ', value: 'UTC' });
    expect(envRecord([...rows, blankEnvRow()])).toEqual({ TZ: 'UTC' });
  });

  it('give every row an id of its own, so typing does not reorder them', () => {
    const rows = [blankEnvRow(), blankEnvRow(), blankEnvRow()];
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  });

  it('refuses a name a shell could not export, and lets an empty row be', () => {
    expect(envNameError('MY_VAR')).toBeNull();
    expect(envNameError('')).toBeNull();
    expect(envNameError('2COOL')).toMatch(/not starting with a digit/);
    expect(envNameError('a-b')).toMatch(/underscores/);
  });
});

describe('what this browser remembers, per flow', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('gives back what was written, for that flow only', () => {
    writeRunInputs('a.py', { params: { factor: 3 }, env: { TZ: 'UTC' } });
    expect(readRunInputs('a.py')).toEqual({ params: { factor: 3 }, env: { TZ: 'UTC' } });
    expect(readRunInputs('b.py')).toEqual({ params: {}, env: {} });
    expect(readRunInputs(null)).toEqual({ params: {}, env: {} });
  });

  it('is empty rather than broken when the stored text is junk', () => {
    localStorage.setItem('tolquane.run.inputs.a.py', 'not json');
    expect(readRunInputs('a.py')).toEqual({ params: {}, env: {} });
  });
});
