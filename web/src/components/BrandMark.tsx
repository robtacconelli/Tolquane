import type { JSX } from 'react';

/** The wordmark glyph: a node with an input and an output port, the smallest flow. */
export function BrandMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="0.9" y="0.9" width="22.2" height="22.2" rx="6" fill="var(--tq-accent-soft)" />
      <rect
        x="0.9"
        y="0.9"
        width="22.2"
        height="22.2"
        rx="6"
        stroke="var(--tq-accent-line)"
        strokeWidth="1"
      />
      <path
        d="M5.6 12h2.7M15.7 12h2.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <rect
        x="8.4"
        y="8.4"
        width="7.2"
        height="7.2"
        rx="2.4"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
