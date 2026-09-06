/**
 * The inputs saved with a flow, as text and back.
 *
 * A sample is a list of items handed to `build(source=...)` instead of the flow's own
 * source node, which is how a flow is tried on three lines before it is pointed at three
 * million. They live in the layout sidecar (S1) next to the card positions, so they
 * travel with the file and never touch the Python.
 *
 * One item per line. A line that is valid JSON is that value -- a number, an object, a
 * quoted string -- and anything else is the line itself, because the common case is a
 * few lines of text and typing quotes around them would be a tax.
 */

import type { Sample } from '../model';

/** Text to items: JSON where it parses, the line itself where it does not. */
export function parseItems(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return line;
      }
    });
}

/** Items back to text, one per line, the way they were typed. */
export function itemsToText(items: readonly unknown[]): string {
  return items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
}

/** A name no other sample of this flow has. */
export function uniqueName(samples: readonly Sample[], wanted: string): string {
  let name = wanted;
  let n = 2;
  while (samples.some((sample) => sample.name === name)) {
    name = `${wanted} ${String(n)}`;
    n += 1;
  }
  return name;
}
