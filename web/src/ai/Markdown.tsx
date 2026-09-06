import { useMemo, useState, type JSX } from 'react';
import { Icon } from '../components/Icon';
import { parseMarkdown, type Block, type Inline } from './markdown';
import styles from './Markdown.module.css';

/**
 * The assistant's words. `markdown.ts` does the reading; this only draws it.
 *
 * It re-parses on every delta while a turn streams, which is cheap for a few hundred
 * characters and means a fenced block becomes a code block the moment its fence opens,
 * rather than flickering from prose to code when it closes.
 */
export function Markdown({
  text,
  writing = false,
}: {
  text: string;
  /** The words are still arriving: a caret sits at the end of the last block. */
  writing?: boolean;
}): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={styles.prose}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} caret={writing && index === blocks.length - 1} />
      ))}
    </div>
  );
}

/** The one thing on screen that moves, and only while a turn is still being written. */
function Caret(): JSX.Element {
  return <span className={styles.caret} aria-hidden="true" />;
}

function BlockView({ block, caret = false }: { block: Block; caret?: boolean }): JSX.Element {
  switch (block.type) {
    case 'code':
      return (
        <div>
          <CodeBlock lang={block.lang} text={block.text} />
          {caret ? <Caret /> : null}
        </div>
      );
    case 'heading':
      return (
        <p className={styles.heading} data-level={block.level}>
          <Spans spans={block.inline} />
          {caret ? <Caret /> : null}
        </p>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Spans spans={item} />
          {caret && index === block.items.length - 1 ? <Caret /> : null}
        </li>
      ));
      return block.ordered ? (
        <ol className={styles.list}>{items}</ol>
      ) : (
        <ul className={styles.list}>{items}</ul>
      );
    }
    default:
      return (
        <p className={styles.paragraph}>
          <Spans spans={block.inline} />
          {caret ? <Caret /> : null}
        </p>
      );
  }
}

function Spans({ spans }: { spans: readonly Inline[] }): JSX.Element {
  return (
    <>
      {spans.map((span, index) => {
        if (span.type === 'code') {
          return (
            <code key={index} className={styles.code}>
              {span.text}
            </code>
          );
        }
        if (span.type === 'strong') return <strong key={index}>{span.text}</strong>;
        if (span.type === 'em') return <em key={index}>{span.text}</em>;
        return <span key={index}>{span.text}</span>;
      })}
    </>
  );
}

/** A fenced block: the language it says it is, and a way to take the code away. */
function CodeBlock({ lang, text }: { lang: string | null; text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  function copy(): void {
    try {
      void navigator.clipboard?.writeText(text).then(
        () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        },
        () => undefined,
      );
    } catch {
      /* a browser without the clipboard API: the text is still selectable */
    }
  }

  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <span className={styles.lang}>{lang ?? 'code'}</span>
        <button type="button" className={styles.copy} onClick={copy}>
          <Icon name={copied ? 'check' : 'code'} size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={styles.pre}>
        <code>{text}</code>
      </pre>
    </div>
  );
}
