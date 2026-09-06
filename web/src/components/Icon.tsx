import type { JSX, SVGProps } from 'react';

/* One 24x24 stroked set, drawn on the same grid so icons line up at 16px in menus and
 * at 18px in the top bar. No icon font: the app must work with no network. */
const PATHS = {
  flows: (
    <>
      <rect x="2.5" y="9" width="6" height="6" rx="1.6" />
      <rect x="15.5" y="4" width="6" height="6" rx="1.6" />
      <rect x="15.5" y="14" width="6" height="6" rx="1.6" />
      <path d="M8.5 12h3.2a1.8 1.8 0 0 0 1.8-1.8V8.8A1.8 1.8 0 0 1 15.3 7h.2" />
      <path d="M8.5 12h3.2a1.8 1.8 0 0 1 1.8 1.8v1.4a1.8 1.8 0 0 0 1.8 1.8h.2" />
    </>
  ),
  runs: (
    <>
      <path d="M3 12h3.6l2.2-5.4 3.4 11 2.4-6.4L17 12h4" />
    </>
  ),
  schedules: (
    <>
      <circle cx="12" cy="12.6" r="7.6" />
      <path d="M12 8.6v4.2l2.6 1.6" />
      <path d="M9 2.8h6" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9" />
      <path d="M17 7h3" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.4" />
      <path d="M15.8 15.8 20 20" />
    </>
  ),
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  chevronLeft: <path d="M15 5 8 12l7 7" />,
  chevronUp: <path d="m5 15 7-7 7 7" />,
  panelLeft: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.4" />
      <path d="M9.5 4v16" />
    </>
  ),
  panelRight: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.4" />
      <path d="M14.5 4v16" />
    </>
  ),
  panelBottom: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.4" />
      <path d="M3 14.5h18" />
    </>
  ),
  map: (
    <>
      <path d="M3 6.6 9 4.4l6 2.2 6-2.2v13L15 19.6l-6-2.2-6 2.2v-13Z" />
      <path d="M9 4.4v13M15 6.6v13" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.4V10h-5.6" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.8 7.4 7.6 19a1.4 1.4 0 0 0 1.4 1.3h6a1.4 1.4 0 0 0 1.4-1.3l.8-11.6" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20h4l10-10a2.4 2.4 0 0 0-3.4-3.4L4.6 16.6 4 20Z" />
      <path d="m13.6 7.4 3.4 3.4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.6 21 19.4H3L12 4.6Z" />
      <path d="M12 10.4v3.6" />
      <path d="M12 17h.01" />
    </>
  ),
  offline: (
    <>
      <path d="M3.2 8.6A15 15 0 0 1 8 5.9" />
      <path d="M20.8 8.6a15 15 0 0 0-6.6-3.1" />
      <path d="M6.4 12.4a10 10 0 0 1 2.6-1.6" />
      <path d="M17.6 12.4a10 10 0 0 0-2.2-1.5" />
      <path d="M9.6 16a5 5 0 0 1 4.8 0" />
      <path d="M12 19.4h.01" />
      <path d="m3 3 18 18" />
    </>
  ),
  code: <path d="m8.5 8-4.5 4 4.5 4M15.5 8l4.5 4-4.5 4M13.6 5.4l-3.2 13.2" />,
  canvas: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <path d="M3 9h18" />
      <path d="M9 9v10.5" />
    </>
  ),
  play: <path d="M8 5.4 19 12 8 18.6V5.4Z" />,
  check: <path d="m4.5 12.5 4.8 4.8L19.5 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  command: (
    <path d="M8.5 5.5a2.5 2.5 0 1 0 0 5h7a2.5 2.5 0 1 0 0-5v13a2.5 2.5 0 1 0 0-5h-7a2.5 2.5 0 1 0 0 5Z" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3 1.8" />
    </>
  ),
  folder: (
    <path d="M3 6.6A1.6 1.6 0 0 1 4.6 5h4l2 2.6h6.8A1.6 1.6 0 0 1 19 9.2v8.2a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 17.4V6.6Z" />
  ),
  sparkle: (
    <>
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z" />
      <path d="M18.8 16.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
