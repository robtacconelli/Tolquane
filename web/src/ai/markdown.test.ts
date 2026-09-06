import { describe, expect, it } from 'vitest';
import { inlineText, parseInline, parseMarkdown, type Block, type Inline } from './markdown';

function inlineOf(block: Block | undefined): Inline[] {
  if (block?.type !== 'paragraph' && block?.type !== 'heading') {
    throw new Error(`not a block with inline spans: ${String(block?.type)}`);
  }
  return block.inline;
}

function itemsOf(block: Block | undefined): Inline[][] {
  if (block?.type !== 'list') throw new Error(`not a list: ${String(block?.type)}`);
  return block.items;
}

describe('parseInline', () => {
  it('leaves plain text alone', () => {
    expect(parseInline('a plain sentence')).toEqual([{ type: 'text', text: 'a plain sentence' }]);
  });

  it('reads inline code', () => {
    expect(parseInline('call `tq.farm(double, 4)` here')).toEqual([
      { type: 'text', text: 'call ' },
      { type: 'code', text: 'tq.farm(double, 4)' },
      { type: 'text', text: ' here' },
    ]);
  });

  it('reads strong before emphasis', () => {
    expect(parseInline('**both** and *one*')).toEqual([
      { type: 'strong', text: 'both' },
      { type: 'text', text: ' and ' },
      { type: 'em', text: 'one' },
    ]);
    expect(parseInline('__also strong__')).toEqual([{ type: 'strong', text: 'also strong' }]);
  });

  it('leaves an unfinished span as the text it is so far', () => {
    expect(parseInline('half a **bold')).toEqual([{ type: 'text', text: 'half a **bold' }]);
    expect(parseInline('an open `code')).toEqual([{ type: 'text', text: 'an open `code' }]);
  });

  it('gives the plain text back', () => {
    expect(inlineText(parseInline('run `tq.check` **now**'))).toBe('run tq.check now');
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines', () => {
    const blocks = parseMarkdown('First one.\nstill first\n\nSecond one.');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'paragraph' });
    expect(inlineText(inlineOf(blocks[0]))).toBe('First one.\nstill first');
  });

  it('reads a fenced block with its language', () => {
    const blocks = parseMarkdown(
      'Here:\n\n```python\nimport tolquane as tq\n\nx = 1\n```\n\nDone.',
    );
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'code', 'paragraph']);
    expect(blocks[1]).toEqual({
      type: 'code',
      lang: 'python',
      text: 'import tolquane as tq\n\nx = 1',
      open: false,
    });
  });

  it('treats a fence still being written as an open code block', () => {
    const blocks = parseMarkdown('```python\nimport tolquane as tq\nx =');
    expect(blocks).toEqual([
      { type: 'code', lang: 'python', text: 'import tolquane as tq\nx =', open: true },
    ]);
  });

  it('keeps a fence with no language', () => {
    expect(parseMarkdown('```\nplain\n```')[0]).toMatchObject({ lang: null, text: 'plain' });
  });

  it('reads headings', () => {
    const blocks = parseMarkdown('## What changed\n\nA farm.');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 });
    expect(inlineText(inlineOf(blocks[0]))).toBe('What changed');
  });

  it('reads bullet and numbered lists', () => {
    const bullets = parseMarkdown('- one\n* two\n+ three');
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toMatchObject({ type: 'list', ordered: false });
    expect(itemsOf(bullets[0])).toHaveLength(3);

    const numbers = parseMarkdown('1. first\n2. second');
    expect(numbers[0]).toMatchObject({ type: 'list', ordered: true });
  });

  it('folds a wrapped bullet back into its item', () => {
    const blocks = parseMarkdown('- a long item\n  that wrapped\n- another');
    expect(itemsOf(blocks[0]).map((item) => inlineText(item))).toEqual([
      'a long item that wrapped',
      'another',
    ]);
  });

  it('does not read a fence inside a list as a bullet', () => {
    const blocks = parseMarkdown('- one\n\n```python\nx = 1\n```');
    expect(blocks.map((block) => block.type)).toEqual(['list', 'code']);
  });

  it('gives nothing back for nothing', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n  \n')).toEqual([]);
  });

  /* Streaming: every prefix of an answer has to parse into something sensible, because
   * the panel re-parses on every delta. */
  it('parses every prefix of a real answer', () => {
    const answer = [
      'I widened the farm to eight workers.',
      '',
      '```python',
      'tq.farm(fetch, 8)',
      '```',
      '',
      '- `check_flow` passed',
      '- the run took **1.2 s**',
    ].join('\n');
    for (let cut = 0; cut <= answer.length; cut += 1) {
      expect(() => parseMarkdown(answer.slice(0, cut))).not.toThrow();
    }
    expect(parseMarkdown(answer).map((block) => block.type)).toEqual(['paragraph', 'code', 'list']);
  });
});
