/**
 * Real flows, as the server would answer for them.
 *
 * Made from the repository's own examples with the model command, so the shapes here are
 * exactly the ones the canvas will meet:
 *
 *     .venv/bin/python -m tolquane.web.model parse examples/word_count.py
 *     .venv/bin/python -m tolquane.web.model graph examples/word_count.py
 *
 * `showcase` is the one flow written for this: it is the only place a comb, an
 * all-to-all and a feedback loop appear together, and the canvas has to draw all three.
 * `som` is a file the model cannot represent, so it opens code-only.
 *
 * The unit tests import these directly; the editor loads them through a dev-only picker
 * (`import.meta.env.DEV`), so none of this reaches the production bundle.
 */

import type { FlowResponse } from '../../model';
import hello from './hello.json';
import newton from './newton.json';
import showcase from './showcase.json';
import som from './som.json';
import urlStatus from './url_status.json';
import wordCount from './word_count.json';
import wordFrequency from './word_frequency.json';

function flow(raw: unknown): FlowResponse {
  return raw as FlowResponse;
}

export const FIXTURES: Record<string, FlowResponse> = {
  'hello.py': flow(hello),
  'word_count.py': flow(wordCount),
  'showcase.py': flow(showcase),
  'newton_sqrt_feedback/flow.py': flow(newton),
  'word_frequency/flow.py': flow(wordFrequency),
  'url_status_report/flow.py': flow(urlStatus),
  'som.py': flow(som),
};

export const FIXTURE_NAMES: readonly string[] = Object.keys(FIXTURES);

export function fixture(name: string): FlowResponse {
  const found = FIXTURES[name];
  if (!found) throw new Error(`no fixture named ${name}`);
  return found;
}
