import { useEffect } from 'react';

/** True for the modifier that means "application command" on this platform. */
export function isCommandKey(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

/**
 * Cmd/Ctrl+K anywhere, and Escape to back out. Registered on the window so it works
 * from the canvas and from the code editor's own key handling in wave 2.
 */
export function useCommandPaletteHotkey(open: () => void, close: () => void): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isCommandKey(event) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open();
        return;
      }
      if (event.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);
}
