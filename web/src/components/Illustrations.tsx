import type { JSX } from 'react';

/* Illustrations are inline SVG on the theme tokens, so they follow the theme and cost
 * no request. They quote the visual language of the canvas: rounded cards, a port dot
 * on each side, a dashed edge between them. */

const CARD_FILL = 'var(--tq-surface-raised)';
const CARD_LINE = 'var(--tq-border)';
const DIM = 'var(--tq-text-subtle)';

export function EmptyFlowsArt(): JSX.Element {
  return (
    <svg width="188" height="104" viewBox="0 0 188 104" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="tq-empty-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--tq-accent)" stopOpacity="0.5" />
          <stop offset="1" stopColor="var(--tq-accent)" stopOpacity="0.08" />
        </linearGradient>
      </defs>

      <path
        d="M46 52h22M120 52h22"
        stroke={CARD_LINE}
        strokeWidth="1.5"
        strokeDasharray="3 4"
        strokeLinecap="round"
      />

      <rect x="4" y="36" width="42" height="32" rx="8" fill={CARD_FILL} stroke={CARD_LINE} />
      <rect x="12" y="45" width="18" height="3" rx="1.5" fill={DIM} opacity="0.55" />
      <rect x="12" y="52" width="12" height="3" rx="1.5" fill={DIM} opacity="0.3" />

      <rect
        x="68"
        y="24"
        width="52"
        height="56"
        rx="10"
        fill="url(#tq-empty-fade)"
        stroke="var(--tq-accent-line)"
      />
      <rect x="76" y="33" width="36" height="18" rx="6" fill={CARD_FILL} stroke={CARD_LINE} />
      <rect x="76" y="55" width="36" height="18" rx="6" fill={CARD_FILL} stroke={CARD_LINE} />
      <rect x="82" y="40" width="16" height="3" rx="1.5" fill={DIM} opacity="0.5" />
      <rect x="82" y="62" width="16" height="3" rx="1.5" fill={DIM} opacity="0.5" />

      <rect x="142" y="36" width="42" height="32" rx="8" fill={CARD_FILL} stroke={CARD_LINE} />
      <rect x="150" y="45" width="18" height="3" rx="1.5" fill={DIM} opacity="0.55" />
      <rect x="150" y="52" width="12" height="3" rx="1.5" fill={DIM} opacity="0.3" />

      <circle cx="46" cy="52" r="3" fill="var(--tq-accent)" opacity="0.7" />
      <circle cx="120" cy="52" r="3" fill="var(--tq-accent)" opacity="0.7" />
      <circle cx="4" cy="52" r="3" fill={CARD_LINE} />
      <circle cx="184" cy="52" r="3" fill={CARD_LINE} />
    </svg>
  );
}

export function EmptyRunsArt(): JSX.Element {
  return (
    <svg width="178" height="100" viewBox="0 0 178 100" fill="none" aria-hidden="true">
      <path d="M6 82h166" stroke={CARD_LINE} strokeWidth="1.5" strokeLinecap="round" />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          x={16 + i * 32}
          y={72 - i * 4}
          width="18"
          height={8 + i * 4}
          rx="4"
          fill="var(--tq-accent)"
          opacity={0.1 + i * 0.06}
        />
      ))}
      <path
        d="M16 46c14 0 14-18 28-18s14 26 28 26 14-22 28-22 14 16 28 16 14-10 28-10"
        stroke="var(--tq-accent)"
        strokeOpacity="0.55"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeDasharray="4 5"
      />
      <circle cx="16" cy="46" r="3.4" fill="var(--tq-accent)" opacity="0.75" />
      <circle cx="156" cy="38" r="3.4" fill="var(--tq-accent)" opacity="0.75" />
    </svg>
  );
}

export function EmptySchedulesArt(): JSX.Element {
  return (
    <svg width="150" height="100" viewBox="0 0 150 100" fill="none" aria-hidden="true">
      <circle cx="75" cy="50" r="34" fill={CARD_FILL} stroke={CARD_LINE} />
      <circle cx="75" cy="50" r="44" stroke="var(--tq-accent-line)" strokeDasharray="2 8" />
      {[0, 1, 2, 3].map((i) => (
        <path
          key={i}
          d="M75 20v6"
          stroke={DIM}
          strokeWidth="2"
          strokeLinecap="round"
          transform={`rotate(${i * 90} 75 50)`}
          opacity="0.5"
        />
      ))}
      <path
        d="M75 32v18l12 8"
        stroke="var(--tq-accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="75" cy="50" r="2.6" fill="var(--tq-accent)" />
    </svg>
  );
}
