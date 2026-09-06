/** Finding a node in the file, a line in an error, and a card's place after a re-parse. */

import { describe, expect, it } from 'vitest';
import type { FlowResponse, Tree } from '../../model';
import { FIXTURES } from '../../test/fixtures';
import { lineOfNode, parseErrorLine, relayout } from './locate';

const WORD_COUNT = FIXTURES['word_count.py'] as FlowResponse;

const ref = (id: string): Tree => ({ type: 'ref', id });
const pipeline = (...stages: Tree[]): Tree => ({ type: 'pipeline', stages });

describe('finding a node in the file', () => {
  it('gives the line its decorator starts on', () => {
    const node = WORD_COUNT.model?.nodes.find((entry) => entry.id === 'words');
    const line = lineOfNode(WORD_COUNT.source, node?.source ?? '', 'words');
    expect(line).not.toBeNull();
    expect(WORD_COUNT.source.split('\n')[(line as number) - 1]).toBe('@tq.node');
  });

  it('falls back to the definition when the body has been edited', () => {
    const line = lineOfNode(WORD_COUNT.source, '# not in the file any more', 'words');
    expect(WORD_COUNT.source.split('\n')[(line as number) - 1]).toBe('@tq.node');
  });

  it('finds a class as readily as a function', () => {
    const line = lineOfNode(WORD_COUNT.source, 'nothing like it', 'Count');
    expect(WORD_COUNT.source.split('\n')[(line as number) - 1]).toBe('class Count:');
  });

  it('says nothing when the name is not there', () => {
    expect(lineOfNode(WORD_COUNT.source, 'x', 'missing')).toBeNull();
  });
});

describe('the line an error names', () => {
  it('reads Python own way of saying it', () => {
    expect(parseErrorLine("the file does not parse: expected ':' (<unknown>, line 19)")).toBe(19);
    expect(parseErrorLine('a Graph.link topology cannot be modelled')).toBeNull();
  });
});

describe('the layout after a re-parse', () => {
  const positions = { 'stages.0': { x: 0, y: 0 }, 'stages.1': { x: 260, y: 0 } };

  it('leaves the sidecar alone when nothing moved', () => {
    const tree = pipeline(ref('lines'), ref('words'));
    expect(relayout(tree, pipeline(ref('lines'), ref('words')), positions)).toBe(positions);
  });

  it('follows a stage that moved along by name', () => {
    const before = pipeline(ref('lines'), ref('words'));
    const after = pipeline(ref('lines'), ref('clean'), ref('words'));
    expect(relayout(before, after, positions)).toEqual({
      'stages.0': { x: 0, y: 0 },
      'stages.2': { x: 260, y: 0 },
    });
  });

  it('drops the position of a block that is gone', () => {
    const before = pipeline(ref('lines'), ref('words'));
    const after = pipeline(ref('lines'));
    expect(relayout(before, after, positions)).toEqual({ 'stages.0': { x: 0, y: 0 } });
  });

  it('keeps a farm that is still wrapped round the same worker', () => {
    const farm = (workers: number): Tree => ({
      type: 'farm',
      worker: ref('words'),
      workers,
      options: {
        emit: 'round_robin',
        collect: null,
        ordered: false,
        emitter: null,
        collector: null,
        key: null,
        prefetch: 1,
        window: null,
        name: null,
        capacity: null,
        runtime: null,
      },
    });
    const before = pipeline(ref('lines'), farm(2));
    const after = pipeline(ref('lines'), farm(4));
    expect(relayout(before, after, positions)).toBe(positions);
  });
});
