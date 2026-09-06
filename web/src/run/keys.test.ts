import { describe, expect, it } from 'vitest';
import { normalizeModel } from '../model';
import { FIXTURES } from '../test/fixtures';
import { pathOfNode, runAliases } from './keys';

/*
 * The map between what the canvas calls things and what a run calls them, against the
 * real flows: `hello.py` for a plain farm, `newton` for a feedback loop, `word_frequency`
 * for three farms in a row.
 */

function flowOf(name: string) {
  const response = FIXTURES[name];
  if (!response?.model) throw new Error(`${name} has no model`);
  return { model: normalizeModel(response.model), graph: response.graph };
}

describe('runAliases', () => {
  it('gives a farm card the threads of its group', () => {
    const { model, graph } = flowOf('hello.py');
    const aliases = runAliases(model, graph);
    // Thread by thread, never the group as well: `stateOfGroup` adds up everything
    // under `double farm.`, so an aggregate there too would count each thread twice.
    expect(aliases.nodes['double farm']).toBeUndefined();
    expect(aliases.nodes['double farm.emitter']).toEqual(['double.emitter']);
    expect(aliases.nodes['double farm.collector']).toEqual(['double.collector']);
    expect(aliases.nodes['double farm.0']).toEqual(['double.0']);
    expect(aliases.nodes['double farm.2']).toEqual(['double.2']);
  });

  it('never aliases a name the run answers to itself', () => {
    const { model, graph } = flowOf('hello.py');
    const aliases = runAliases(model, graph);
    expect(aliases.nodes.numbers).toBeUndefined();
    expect(aliases.nodes.show).toBeUndefined();
    expect(aliases.nodes.double).toBeUndefined();
  });

  it('maps a `>>` between two stages onto the real edges', () => {
    const { model, graph } = flowOf('hello.py');
    const aliases = runAliases(model, graph);
    expect(aliases.edges['stages.0->stages.1']).toEqual(['numbers->double.emitter']);
    expect(aliases.edges['stages.1->stages.2']).toEqual(['double.collector->show']);
  });

  it('maps a farm’s own edges, emitter to worker and worker to collector', () => {
    const { model, graph } = flowOf('hello.py');
    const aliases = runAliases(model, graph);
    expect(aliases.edges['stages.1#emitter->stages.1.worker']).toEqual([
      'double.emitter->double.0',
    ]);
    expect(aliases.edges['stages.1.worker#3->stages.1#collector']).toEqual([
      'double.3->double.collector',
    ]);
  });

  it('follows three farms in a row', () => {
    const { model, graph } = flowOf('word_frequency/flow.py');
    const aliases = runAliases(model, graph);
    const names = graph?.nodes.map((node) => node.name) ?? [];
    for (const [key, mapped] of Object.entries(aliases.nodes)) {
      expect(mapped.length, key).toBeGreaterThan(0);
      for (const name of mapped) expect(names, key).toContain(name);
    }
    for (const [key, mapped] of Object.entries(aliases.edges)) {
      expect(mapped.length, key).toBeGreaterThan(0);
    }
  });

  it('maps a feedback block onto the edge that loops back', () => {
    const { model, graph } = flowOf('newton_sqrt_feedback/flow.py');
    const aliases = runAliases(model, graph);
    const loops = Object.entries(aliases.edges).filter(([key]) => {
      const [src, dst] = key.split('->');
      return src === dst;
    });
    expect(loops.length).toBeGreaterThan(0);
  });

  it('answers with nothing when there is no graph to map to', () => {
    const { model } = flowOf('hello.py');
    expect(runAliases(model, null)).toEqual({ nodes: {}, edges: {} });
    expect(runAliases(null, null)).toEqual({ nodes: {}, edges: {} });
  });
});

describe('pathOfNode', () => {
  it('finds the card a failing thread belongs to', () => {
    const { model, graph } = flowOf('hello.py');
    expect(pathOfNode(model, graph, 'double.1')).toBe('stages.1');
    expect(pathOfNode(model, graph, 'numbers')).toBe('stages.0');
    expect(pathOfNode(model, graph, 'show')).toBe('stages.2');
  });

  it('falls back to the whole flow for a name it does not know', () => {
    const { model, graph } = flowOf('hello.py');
    expect(pathOfNode(model, graph, 'nothing')).toBe('');
  });
});
