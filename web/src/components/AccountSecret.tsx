import { useCallback, useState, type JSX, type ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import styles from './Account.module.css';

/**
 * A string the server will never say again: a new API token, a temporary password.
 *
 * It is shown in full, in the mono face, with a copy button beside it, because the one
 * thing worse than a secret on screen is a secret nobody managed to write down. Copying
 * can fail -- a browser may refuse the clipboard -- so the text stays selectable and the
 * button says only what actually happened.
 */
export function SecretOnce({
  title,
  value,
  hint,
}: {
  title: ReactNode;
  value: string;
  hint?: ReactNode;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = useCallback((): void => {
    const done = (): void => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    const clipboard = globalThis.navigator?.clipboard as Clipboard | undefined;
    if (!clipboard) return;
    clipboard.writeText(value).then(done, () => {
      /* Refused: the text is on screen and selectable, which is the fallback. */
    });
  }, [value]);

  return (
    <div className={styles.secret}>
      <div className={styles.secretHead}>{title}</div>
      <div className={styles.secretValue}>
        <code className={styles.secretText}>{value}</code>
        <Button onClick={copy} aria-label={copied ? 'Copied' : 'Copy'}>
          <Icon name={copied ? 'check' : 'copy'} size={14} />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {hint ? <div className={styles.secretHead}>{hint}</div> : null}
    </div>
  );
}
