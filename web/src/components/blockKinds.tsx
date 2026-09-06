import type { ReactNode } from 'react';

/* The block kinds of the Tolquane API. Kept apart from the card component so both the
 * canvas and the palette can read the table without importing a component. */
export type BlockKind =
  'source' | 'node' | 'sink' | 'raw' | 'farm' | 'comb' | 'feedback' | 'all2all';

interface KindInfo {
  label: string;
  hint: string;
  /* The stripe colour. Structural blocks (farm, comb, feedback, all-to-all) take the
   * accent; plain stages stay neutral so a canvas is not a rainbow. */
  accent: string;
  glyph: ReactNode;
}

export const BLOCK_KINDS: Record<BlockKind, KindInfo> = {
  source: {
    label: 'Source',
    hint: 'tq.source',
    accent: 'var(--tq-node-done)',
    glyph: (
      <>
        <path d="M5 6v12" />
        <path d="M9 12h8" />
        <path d="m13 8 4 4-4 4" />
      </>
    ),
  },
  node: {
    label: 'Node',
    hint: 'tq.node',
    accent: 'var(--tq-border-strong)',
    glyph: (
      <>
        <rect x="8" y="8" width="8" height="8" rx="2.4" />
        <path d="M3 12h5M16 12h5" />
      </>
    ),
  },
  sink: {
    label: 'Sink',
    hint: 'tq.sink',
    accent: 'var(--tq-node-failed)',
    glyph: (
      <>
        <path d="M6 12h8" />
        <path d="m10 8 4 4-4 4" />
        <path d="M19 6v12" />
      </>
    ),
  },
  raw: {
    label: 'Raw',
    hint: 'tq.raw',
    accent: 'var(--tq-border-strong)',
    glyph: (
      <>
        <path d="M3 12h3M10.5 12h3M18 12h3" />
        <rect x="7.5" y="9" width="9" height="6" rx="2" opacity="0.45" />
      </>
    ),
  },
  farm: {
    label: 'Farm',
    hint: 'tq.farm',
    accent: 'var(--tq-accent)',
    glyph: (
      <>
        <path d="M3 12h4" />
        <path d="M7 12h3l3-5h5M7 12h10M7 12h3l3 5h5" />
      </>
    ),
  },
  comb: {
    label: 'Comb',
    hint: 'tq.comb',
    accent: 'var(--tq-accent)',
    glyph: (
      <>
        <rect x="3" y="8.5" width="7.5" height="7" rx="2" />
        <rect x="13.5" y="8.5" width="7.5" height="7" rx="2" />
        <path d="M10.5 12h3" />
      </>
    ),
  },
  feedback: {
    label: 'Feedback',
    hint: 'tq.feedback',
    accent: 'var(--tq-accent)',
    glyph: (
      <>
        <rect x="6.5" y="11" width="11" height="7" rx="2" />
        <path d="M6.5 14.5H4.2a2.2 2.2 0 0 1-2.2-2.2V8.4A2.2 2.2 0 0 1 4.2 6.2h15.6A2.2 2.2 0 0 1 22 8.4v3.9a2.2 2.2 0 0 1-2.2 2.2h-2.3" />
        <path d="m15.5 12.5 2 2-2 2" />
      </>
    ),
  },
  all2all: {
    label: 'All-to-all',
    hint: 'tq.all2all',
    accent: 'var(--tq-accent)',
    glyph: (
      <>
        <path d="M8 7h8M8 7l8 10M8 17h8M8 17 16 7" />
        <circle cx="6" cy="7" r="1.8" />
        <circle cx="6" cy="17" r="1.8" />
        <circle cx="18" cy="7" r="1.8" />
        <circle cx="18" cy="17" r="1.8" />
      </>
    ),
  },
};
