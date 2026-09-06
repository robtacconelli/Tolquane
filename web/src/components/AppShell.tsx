import { Fragment, useCallback, type JSX } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useHealth } from '../hooks/useHealth';
import { useCommandPaletteHotkey } from '../hooks/useHotkeys';
import { useSystemTheme } from '../hooks/useSystemTheme';
import { crumbsFor, NAV_ITEMS } from '../nav';
import { MOD_KEY_K } from '../platform';
import { useUiStore } from '../store/ui';
import { AppShellContext } from './AppShellContext';
import { BrandMark } from './BrandMark';
import { Button } from './Button';
import { CommandPalette } from './CommandPalette';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';
import styles from './AppShell.module.css';

export function AppShell(): JSX.Element {
  useSystemTheme();

  const location = useLocation();
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const paletteOpen = useUiStore((state) => state.paletteOpen);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);

  const openPalette = useCallback(() => setPaletteOpen(true), [setPaletteOpen]);
  const closePalette = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);
  useCommandPaletteHotkey(openPalette, closePalette);

  const server = useHealth();
  const crumbs = crumbsFor(location.pathname);
  const last = crumbs[crumbs.length - 1];

  return (
    <div className={styles.shell} data-collapsed={collapsed}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <BrandMark />
          </span>
          <span className={styles.wordmark}>Tolquane</span>
        </div>

        <nav className={styles.nav} aria-label="Sections">
          <div className={styles.navLabel}>Workspace</div>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                isActive ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem
              }
            >
              <Icon name={item.icon} />
              <span className={styles.navText}>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className={styles.sidebarFoot}>
          <div
            className={styles.serverRow}
            title={server.status === 'online' ? 'Server online' : 'Server offline'}
          >
            <StatusDot
              state={
                server.status === 'online'
                  ? 'done'
                  : server.status === 'checking'
                    ? 'new'
                    : 'waiting'
              }
              title={server.status === 'online' ? 'Server online' : 'Server offline'}
            />
            <span className={styles.serverText}>
              {server.status === 'online'
                ? `Server ${server.info?.version ?? 'online'}`
                : server.status === 'checking'
                  ? 'Connecting…'
                  : 'Server offline'}
            </span>
          </div>
          <button
            type="button"
            className={styles.collapseButton}
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          >
            <Icon name="panelLeft" />
            <span className={styles.navText}>Collapse</span>
          </button>
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.crumbs}>
            {crumbs.slice(0, -1).map((crumb) => (
              <Fragment key={crumb.label}>
                {crumb.to ? (
                  <Link className={styles.crumbLink} to={crumb.to}>
                    {crumb.label}
                  </Link>
                ) : (
                  <span className={styles.crumbLink}>{crumb.label}</span>
                )}
                <span className={styles.crumbSep}>
                  <Icon name="chevronRight" size={14} />
                </span>
              </Fragment>
            ))}
            <h1 className={styles.crumbCurrent}>{last?.label ?? 'Tolquane'}</h1>
          </div>

          <div className={styles.topbarActions}>
            <button type="button" className={styles.omnibox} onClick={openPalette}>
              <Icon name="search" size={14} />
              <span className={styles.omniboxText}>Search or run a command</span>
              <span className={styles.kbd}>{MOD_KEY_K}</span>
            </button>
            <Button
              variant="ghost"
              iconOnly
              onClick={toggleTheme}
              aria-label={
                theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'
              }
              title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
            </Button>
          </div>
        </header>

        {/* Quiet, not alarming: the server is simply not there yet. */}
        {server.status === 'offline' && server.failures > 0 ? (
          <div className={styles.banner} role="status">
            <span className={styles.bannerIcon}>
              <Icon name="offline" size={15} />
            </span>
            <span>
              The Tolquane server is not reachable. Start it with <code>tolquane web</code>
            </span>
            <span className={styles.bannerDetail}>Retrying every 5 seconds.</span>
          </div>
        ) : null}

        <main className={styles.content}>
          <AppShellContext value={{ server }}>
            <Outlet />
          </AppShellContext>
        </main>
      </div>

      {paletteOpen ? <CommandPalette onClose={closePalette} /> : null}
    </div>
  );
}
