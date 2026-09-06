/**
 * `src/api/schema.d.ts` is generated; this checks it is generated from the file that is
 * checked in beside it.
 *
 * The Python side has the other half of the pair: `tests/web/test_openapi.py` fails when
 * `web/openapi.json` no longer matches the live app. Together they mean a route the
 * server adds cannot reach the frontend as `unknown`: one of the two tests goes red
 * first. Regenerate both with
 *
 *     tolquane web --openapi > web/openapi.json && npm run api:types
 *
 * Both files are read as text (`?raw`) rather than imported: this is about the bytes on
 * disk, and a JSON import would give the checked-in document a type of its own.
 */
import { describe, expect, it } from 'vitest';
import generated from './schema.d.ts?raw';
import documentText from '../../openapi.json?raw';

const document = JSON.parse(documentText) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};

/** Every `operationId` the document names. */
const operationIds = Object.values(document.paths)
  .flatMap((methods) => Object.values(methods))
  .map((operation) => operation.operationId)
  .filter((id): id is string => typeof id === 'string');

/** The keys of the generated `operations` interface, which is the last block of the file. */
function generatedOperations(): string[] {
  const start = generated.indexOf('export interface operations {');
  expect(start, 'schema.d.ts has no operations interface').toBeGreaterThan(-1);
  return [...generated.slice(start).matchAll(/^ {2}(\w+): \{$/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

describe('the generated API types', () => {
  it('covers every operation the server publishes', () => {
    expect(operationIds.length).toBeGreaterThan(20);
    expect(generatedOperations().sort()).toEqual([...operationIds].sort());
  });

  it('names every model the wrappers build on', () => {
    for (const name of ['FlowDetail', 'RunModel', 'ScheduleModel', 'SettingsModel', 'Health']) {
      expect(generated, `${name} is missing from schema.d.ts`).toContain(`${name}: {`);
    }
  });
});
