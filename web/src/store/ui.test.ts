import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDEBAR_KEY, THEME_KEY, resolveTheme, useUiStore } from './ui';

function setSystemLight(light: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: light,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

describe('the ui store', () => {
  beforeEach(() => {
    useUiStore.setState({
      themeMode: 'system',
      theme: 'dark',
      sidebarCollapsed: false,
      paletteOpen: false,
    });
  });

  it('resolves `system` against prefers-color-scheme, defaulting to dark', () => {
    setSystemLight(false);
    expect(resolveTheme('system')).toBe('dark');
    setSystemLight(true);
    expect(resolveTheme('system')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('stores the chosen mode and stamps the document', () => {
    useUiStore.getState().setThemeMode('light');
    expect(useUiStore.getState().theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('toggles to the opposite of what is on screen and pins it', () => {
    useUiStore.getState().setThemeMode('system');
    setSystemLight(false);
    useUiStore.getState().syncSystemTheme();
    expect(useUiStore.getState().theme).toBe('dark');

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().themeMode).toBe('light');
    expect(useUiStore.getState().theme).toBe('light');
  });

  it('follows the system only while the mode is `system`', () => {
    useUiStore.getState().setThemeMode('dark');
    setSystemLight(true);
    useUiStore.getState().syncSystemTheme();
    expect(useUiStore.getState().theme).toBe('dark');
  });

  it('remembers the sidebar', () => {
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe('collapsed');
    useUiStore.getState().toggleSidebar();
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe('expanded');
  });

  it('survives a localStorage that throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => useUiStore.getState().setThemeMode('dark')).not.toThrow();
    expect(useUiStore.getState().theme).toBe('dark');
    getItem.mockRestore();
  });
});
