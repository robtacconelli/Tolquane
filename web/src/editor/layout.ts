import { create } from 'zustand';
import { readNumber, readStorage, writeStorage } from '../store/storage';

/*
 * What the editor's chrome remembers between visits.
 *
 * The canvas is the point of this page and on a 1280-wide screen it is the thing with
 * the least room, so every piece of furniture around it folds away: the palette to an
 * icon rail, the drawer to its tab strip, the right-hand column to nothing at all, and
 * the overview to a button. A person who works in code with the drawer tall and the
 * palette shut should find it that way tomorrow, so all four live in `localStorage`
 * (guarded: a private window throws from the accessor itself).
 *
 * This is deliberately not part of `store/ui.ts`, which is the shell's own state and
 * nothing else (DESIGN.md, "The state store").
 */

export const PALETTE_KEY = 'tolquane.editor.palette';
export const DRAWER_KEY = 'tolquane.editor.drawer';
export const DRAWER_HEIGHT_KEY = 'tolquane.editor.drawerHeight';
export const PANEL_KEY = 'tolquane.editor.panel';
export const MINIMAP_KEY = 'tolquane.editor.minimap';

/** The drawer's tab strip: what is left of it when it is folded down. */
export const DRAWER_COLLAPSED_HEIGHT = 37;
export const DRAWER_MIN_HEIGHT = 120;
export const DRAWER_DEFAULT_HEIGHT = 208;

export interface EditorLayoutState {
  /** The block palette: the full column, or a rail of icons. */
  paletteOpen: boolean;
  /** The run drawer: open at `drawerHeight`, or folded down to its tabs. */
  drawerOpen: boolean;
  drawerHeight: number;
  /** The right-hand column, which holds the properties or the AI builder. */
  panelOpen: boolean;
  /** The canvas overview in the bottom-right corner. */
  minimap: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
  /** Live while a drag is going; `remember` writes it down when the drag ends. */
  setDrawerHeight: (height: number, remember?: boolean) => void;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  toggleMinimap: () => void;
}

/**
 * Whether there is room for the palette's labels on this screen.
 *
 * The canvas is what the page is for, and on a 1280-wide screen the sidebar, the palette
 * and the property panel between them leave it 552px: not enough for three cards. So a
 * narrow screen starts with the palette folded to its rail and gets 132px back. It is
 * only the first answer -- folding or unfolding it once is remembered from then on.
 */
function wideScreen(): boolean {
  return (globalThis.innerWidth ?? 1440) >= 1400;
}

function readFlag(key: string, fallback: boolean): boolean {
  const saved = readStorage(key);
  if (saved === 'on') return true;
  if (saved === 'off') return false;
  return fallback;
}

function writeFlag(key: string, value: boolean): void {
  writeStorage(key, value ? 'on' : 'off');
}

export const useEditorLayout = create<EditorLayoutState>((set, get) => ({
  paletteOpen: readFlag(PALETTE_KEY, wideScreen()),
  drawerOpen: readFlag(DRAWER_KEY, true),
  drawerHeight: readNumber(DRAWER_HEIGHT_KEY, DRAWER_DEFAULT_HEIGHT, DRAWER_MIN_HEIGHT, 900),
  panelOpen: readFlag(PANEL_KEY, true),
  minimap: readFlag(MINIMAP_KEY, true),

  setPaletteOpen: (open) => {
    writeFlag(PALETTE_KEY, open);
    set({ paletteOpen: open });
  },
  togglePalette: () => {
    get().setPaletteOpen(!get().paletteOpen);
  },

  setDrawerOpen: (open) => {
    writeFlag(DRAWER_KEY, open);
    set({ drawerOpen: open });
  },
  toggleDrawer: () => {
    get().setDrawerOpen(!get().drawerOpen);
  },
  setDrawerHeight: (height, remember = false) => {
    const clamped = Math.max(DRAWER_MIN_HEIGHT, Math.round(height));
    if (remember) writeStorage(DRAWER_HEIGHT_KEY, String(clamped));
    set({ drawerHeight: clamped });
  },

  setPanelOpen: (open) => {
    writeFlag(PANEL_KEY, open);
    set({ panelOpen: open });
  },
  togglePanel: () => {
    get().setPanelOpen(!get().panelOpen);
  },

  toggleMinimap: () => {
    const next = !get().minimap;
    writeFlag(MINIMAP_KEY, next);
    set({ minimap: next });
  },
}));
