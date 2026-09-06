import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FlowParam } from '../model/types';
import { EnvironmentRows } from './EnvironmentRows';
import { ParameterFields } from './ParameterFields';
import { blankEnvRow, paramDefault, paramFieldType, paramText, type EnvRow } from './params';

/* The two editors the Run popover and the schedule dialog share. */

const PARAMS: FlowParam[] = [
  { name: 'factor', default: '2', annotation: 'int' },
  { name: 'label', default: '"x"', annotation: 'str' },
  { name: 'loud', default: 'False', annotation: 'bool' },
  { name: 'rows', default: '[1, 2]', annotation: null },
];

function Harness({
  params = PARAMS,
  onValue,
}: {
  params?: FlowParam[];
  onValue?: (name: string, value: unknown, error: string | null) => void;
}): React.JSX.Element {
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      params.map((param) => [param.name, paramText(paramFieldType(param), paramDefault(param))]),
    ),
  );
  return (
    <ParameterFields
      params={params}
      values={texts}
      idPrefix="t"
      onChange={(name, text, value, error) => {
        setTexts((current) => ({ ...current, [name]: text }));
        onValue?.(name, value, error);
      }}
    />
  );
}

describe('a field per parameter, typed from its default', () => {
  it('draws a number, a text field, a switch and a code field', () => {
    render(<Harness />);
    expect(screen.getByLabelText('factor')).toHaveValue('2');
    expect(screen.getByLabelText('label')).toHaveValue('x');
    expect(screen.getByRole('switch', { name: 'loud' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('rows').tagName).toBe('TEXTAREA');
  });

  it('says what the file’s own default is, under every field', () => {
    render(<Harness />);
    expect(screen.getByText('int · the file says 2')).toBeInTheDocument();
    expect(screen.getByText('str · the file says "x"')).toBeInTheDocument();
  });

  it('hands back the value and the error on every stroke', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness onValue={seen} />);

    await user.clear(screen.getByLabelText('factor'));
    await user.type(screen.getByLabelText('factor'), '9');
    expect(seen).toHaveBeenLastCalledWith('factor', 9, null);

    await user.type(screen.getByLabelText('factor'), 'x');
    expect(seen).toHaveBeenLastCalledWith('factor', NaN, 'A number, like 8 or 0.5.');
    expect(screen.getByText('A number, like 8 or 0.5.')).toBeInTheDocument();
  });

  it('turns the switch into True and False', async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    render(<Harness onValue={seen} />);
    await user.click(screen.getByRole('switch', { name: 'loud' }));
    expect(seen).toHaveBeenLastCalledWith('loud', true, null);
  });

  it('refuses a code field that is not a literal', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(screen.getByLabelText('rows'));
    await user.type(screen.getByLabelText('rows'), 'open()');
    expect(screen.getByText(/A Python or JSON literal/)).toBeInTheDocument();
  });

  it('says so when build() takes none', () => {
    render(<Harness params={[]} />);
    expect(screen.getByText(/takes no parameters/)).toBeInTheDocument();
  });
});

function EnvHarness({ initial = [] as EnvRow[] }): React.JSX.Element {
  const [rows, setRows] = useState<EnvRow[]>(initial);
  return (
    <>
      <EnvironmentRows rows={rows} onChange={setRows} idPrefix="e" />
      <output>{JSON.stringify(rows.map((row) => [row.name, row.value]))}</output>
    </>
  );
}

describe('the environment rows', () => {
  it('adds a row, takes a name and a value, and removes it again', async () => {
    const user = userEvent.setup();
    render(<EnvHarness />);

    await user.click(screen.getByRole('button', { name: 'Add a variable' }));
    await user.type(screen.getByLabelText('Variable 1 name'), 'GREETING');
    await user.type(screen.getByLabelText('Value of GREETING'), 'hello');
    expect(screen.getByRole('status')).toHaveTextContent('[["GREETING","hello"]]');

    await user.click(screen.getByRole('button', { name: 'Remove GREETING' }));
    expect(screen.getByRole('status')).toHaveTextContent('[]');
  });

  it('marks a name a shell could not export', async () => {
    const user = userEvent.setup();
    render(<EnvHarness initial={[{ ...blankEnvRow(), name: '', value: '' }]} />);
    await user.type(screen.getByLabelText('Variable 1 name'), '2COOL');
    expect(screen.getByText(/not starting with a digit/)).toBeInTheDocument();
  });
});
