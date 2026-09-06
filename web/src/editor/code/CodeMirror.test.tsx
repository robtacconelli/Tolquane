/**
 * The component itself, mounted: the document it is given, the text it reports, and the
 * read-only mode the panel uses for a body nobody may edit.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../store/ui';
import { CodeMirror } from './CodeMirror';

describe('the code editor', () => {
  it('shows the document it is given', () => {
    render(<CodeMirror value="x = 1" ariaLabel="Flow source" />);
    const editor = screen.getByRole('group', { name: 'Flow source' });
    expect(editor.querySelector('.cm-content')?.textContent).toBe('x = 1');
  });

  it('reports typing, and not text that came in through the value', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CodeMirror value="a" onChange={onChange} />);
    rerender(<CodeMirror value="# generated" onChange={onChange} />);
    expect(document.querySelector('.cm-content')?.textContent).toBe('# generated');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('will not be typed into when it is read-only', () => {
    render(<CodeMirror value="x = 1" readOnly ariaLabel="Body of x" />);
    const content = screen.getByRole('group', { name: 'Body of x' }).querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).not.toBe('true');
  });

  it('follows the app theme', () => {
    useUiStore.setState({ theme: 'light' });
    render(<CodeMirror value="x = 1" ariaLabel="Flow source" />);
    expect(document.querySelector('.cm-editor')?.className).not.toContain('cm-dark');
    useUiStore.setState({ theme: 'dark' });
  });
});
