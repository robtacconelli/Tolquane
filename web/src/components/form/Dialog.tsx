import { useEffect, useId, useRef, type JSX, type ReactNode } from 'react';
import { Button } from '../Button';
import { Icon } from '../Icon';
import styles from './Dialog.module.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal on the shape the command palette established: a scrim, a raised panel, a
 * header, a scrolling body and a footer of actions. Escape and the scrim close it, Tab
 * stays inside it, and the first control marked `data-autofocus` takes the focus.
 */
export function Dialog({
  title,
  description,
  onClose,
  footer,
  children,
  width = 640,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  width?: number;
}): JSX.Element {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    const first = node.querySelector<HTMLElement>('[data-autofocus]') ?? node;
    first.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = panel.current;
      if (!node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={styles.dialog}
        style={{ width: `min(${width}px, calc(100vw - var(--tq-space-8)))` }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title} id={titleId}>
              {title}
            </h2>
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          <Button variant="ghost" iconOnly aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </Button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>
  );
}

/** The one question worth a modal: something is about to be destroyed. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          {error ? <span className={styles.footerError}>{error}</span> : null}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy} data-autofocus>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      <p className={styles.confirmBody}>{body}</p>
    </Dialog>
  );
}
