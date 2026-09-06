import { useEffect } from 'react';
import { applyTheme, useUiStore } from '../store/ui';

/**
 * Keeps the `data-theme` attribute in step with the store, and follows the operating
 * system while the mode is `system`. The attribute is also set by an inline script in
 * index.html so the first paint is never the wrong theme; this only handles changes.
 */
export function useSystemTheme(): void {
  const theme = useUiStore((state) => state.theme);
  const syncSystemTheme = useUiStore((state) => state.syncSystemTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const media = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    if (!media) return;
    const listener = () => syncSystemTheme();
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [syncSystemTheme]);
}
