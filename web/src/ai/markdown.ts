/**
 * Markdown-lite: the little of it a chat answer actually uses.
 *
 * The builder writes prose, `inline code`, fenced blocks of Python and the occasional
 * list or heading. That is the whole grammar here, and it is parsed rather than pulled
 * in as a dependency: the library ships with none, and neither does its GUI.
 *
 * The parser is written for a stream. Text arrives a few characters at a time and is
 * re-parsed on every delta, so a fence that has been opened and not yet closed is a code
 * block (`open: true`) rather than a paragraph full of backticks, and a half-written
 * `**bold` is left as the literal text it is so far.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string };

export type Block =
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'code'; lang: string | null; text: string; open: boolean }
  | { type: 'list'; ordered: boolean; items: Inline[][] };

/* Order matters: `**` has to be tried before `*`, or every strong span reads as two
 * empty emphases. */
const INLINE = /`([^`\n]+)`|\*\*([^\n]+?)\*\*|\*([^*\n]+)\*|__([^\n]+?)__|_([^_\n]+)_/g;

const FENCE = /^\s*```+\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ type: 'code', text: match[1] });
    else if (match[2] !== undefined) out.push({ type: 'strong', text: match[2] });
    else if (match[4] !== undefined) out.push({ type: 'strong', text: match[4] });
    else if (match[3] !== undefined) out.push({ type: 'em', text: match[3] });
    else if (match[5] !== undefined) out.push({ type: 'em', text: match[5] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split('\n');

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  function closeParagraph(): void {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) });
    paragraph = [];
  }

  function closeList(): void {
    if (!list) return;
    blocks.push({
      type: 'list',
      ordered: list.ordered,
      items: list.items.map((item) => parseInline(item)),
    });
    list = null;
  }

  function close(): void {
    closeParagraph();
    closeList();
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      close();
      const body: string[] = [];
      let closed = false;
      index += 1;
      for (; index < lines.length; index += 1) {
        const next = lines[index] ?? '';
        if (FENCE.test(next)) {
          closed = true;
          break;
        }
        body.push(next);
      }
      blocks.push({
        type: 'code',
        lang: fence[1] ? fence[1] : null,
        text: body.join('\n'),
        open: !closed,
      });
      continue;
    }

    if (line.trim() === '') {
      close();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      close();
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        inline: parseInline(heading[2] ?? ''),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      closeParagraph();
      const ordered = numbered !== null;
      const text = (bullet?.[1] ?? numbered?.[1] ?? '').trim();
      if (list && list.ordered === ordered) list.items.push(text);
      else {
        closeList();
        list = { ordered, items: [text] };
      }
      continue;
    }

    // A line under a bullet that is not one itself belongs to the item above it.
    if (list) {
      const item = list.items[list.items.length - 1];
      if (item !== undefined) list.items[list.items.length - 1] = `${item} ${line.trim()}`;
      continue;
    }
    paragraph.push(line);
  }

  close();
  return blocks;
}

/** The plain text of a run of inline spans, for titles and copy buttons. */
export function inlineText(spans: readonly Inline[]): string {
  return spans.map((span) => span.text).join('');
}
