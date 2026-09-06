import type { IconName } from './components/Icon';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Matched as a prefix so /flows/demo.py keeps "Flows" lit. */
  match: string;
  /** Administrators only: a member has no such page, so they are not shown a door. */
  adminOnly?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/flows', label: 'Flows', icon: 'flows', match: '/flows' },
  { to: '/runs', label: 'Runs', icon: 'runs', match: '/runs' },
  { to: '/schedules', label: 'Schedules', icon: 'schedules', match: '/schedules' },
  { to: '/users', label: 'Users', icon: 'users', match: '/users', adminOnly: true },
  { to: '/settings', label: 'Settings', icon: 'settings', match: '/settings' },
];

/**
 * The sections this reader has. A member's sidebar has no Users item: the route guard
 * would refuse them anyway, and a door that never opens is worse than no door.
 * Breadcrumbs are made from the whole list, because a page still has a name.
 */
export function navItemsFor(admin: boolean): readonly NavItem[] {
  return admin ? NAV_ITEMS : NAV_ITEMS.filter((item) => !item.adminOnly);
}

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
