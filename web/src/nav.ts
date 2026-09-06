import type { IconName } from './components/Icon';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Matched as a prefix so /flows/demo.py keeps "Flows" lit. */
  match: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/flows', label: 'Flows', icon: 'flows', match: '/flows' },
  { to: '/runs', label: 'Runs', icon: 'runs', match: '/runs' },
  { to: '/schedules', label: 'Schedules', icon: 'schedules', match: '/schedules' },
  { to: '/settings', label: 'Settings', icon: 'settings', match: '/settings' },
];

export interface Crumb {
  label: string;
  to?: string;
}

/** The top bar's title: the section, plus the flow file when one is open. */
export function crumbsFor(pathname: string): Crumb[] {
  const item = NAV_ITEMS.find(
    (candidate) => pathname === candidate.match || pathname.startsWith(`${candidate.match}/`),
  );
  if (!item) return [{ label: 'Tolquane' }];
  if (pathname === item.match) return [{ label: item.label }];

  const rest = decodeURIComponent(pathname.slice(item.match.length + 1));
  return [{ label: item.label, to: item.to }, { label: rest || item.label }];
}
