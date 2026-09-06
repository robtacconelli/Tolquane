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

/**
 * The top bar's title: the section, then every folder of the open file, then the file.
 *
 * A flow lives at a path inside the workspace, so `reports/weekly/word_count.py` reads
 * `Flows › reports › weekly › word_count.py` rather than one long string. Only the
 * section is a link: there is no page for a folder, and a crumb that looks like a link
 * and does nothing is worse than one that does not.
 */
export function crumbsFor(pathname: string): Crumb[] {
  const item = NAV_ITEMS.find(
    (candidate) => pathname === candidate.match || pathname.startsWith(`${candidate.match}/`),
  );
  if (!item) return [{ label: 'Tolquane' }];
  if (pathname === item.match) return [{ label: item.label }];

  const rest = decodeURIComponent(pathname.slice(item.match.length + 1));
  const parts = rest.split('/').filter((part) => part !== '');
  if (parts.length === 0) return [{ label: item.label }];
  return [{ label: item.label, to: item.to }, ...parts.map((label) => ({ label }))];
}
