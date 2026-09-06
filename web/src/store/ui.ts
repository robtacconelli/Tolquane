import { create } from 'zustand';
import { readStorage, writeStorage } from './storage';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_KEY = 'tolquane.theme';
export const SIDEBAR_KEY = 'tolquane.sidebar';

export function prefersLight(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return prefersLight() ? 'light' : 'dark';
  return mode;
}

export function applyTheme(theme: ResolvedTheme): void {
  globalThis.document?.documentElement?.setAttribute('data-theme', theme);
}

function readThemeMode(): ThemeMode {
  const saved = readStorage(THEME_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

export interface UiState {
  themeMode: ThemeMode;
  /** The theme actually painted: `themeMode` with `system` resolved. */
  theme: ResolvedTheme;
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  /** The top-bar button: flips to the opposite of what is on screen and pins it. */
  toggleTheme: () => void;
  /** Re-resolves after the OS preference changed; a no-op unless the mode is `system`. */
  syncSystemTheme: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setPaletteOpen: (open: boolean) => void;
}

const initialMode = readThemeMode();

export const useUiStore = create<UiState>((set, get) => ({
  themeMode: initialMode,
  theme: resolveTheme(initialMode),
  sidebarCollapsed: readStorage(SIDEBAR_KEY) === 'collapsed',
  paletteOpen: false,

  setThemeMode: (mode) => {
    const theme = resolveTheme(mode);
    writeStorage(THEME_KEY, mode);
    applyTheme(theme);
    set({ themeMode: mode, theme });
  },

  toggleTheme: () => {
    get().setThemeMode(get().theme === 'dark' ? 'light' : 'dark');
  },

  syncSystemTheme: () => {
    if (get().themeMode !== 'system') return;
    const theme = resolveTheme('system');
    applyTheme(theme);
    set({ theme });
  },

  setSidebarCollapsed: (collapsed) => {
    writeStorage(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
    set({ sidebarCollapsed: collapsed });
  },

  toggleSidebar: () => {
    get().setSidebarCollapsed(!get().sidebarCollapsed);
  },

  setPaletteOpen: (open) => set({ paletteOpen: open }),
}));
