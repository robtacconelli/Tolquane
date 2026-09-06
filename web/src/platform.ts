/**
 * The one platform question the UI asks: which modifier key to name in a hint. Tolquane
 * Web runs on the machine the flows run on, so this is decided once, at load.
 */
function isApplePlatform(): boolean {
  const nav = globalThis.navigator as
    (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** `⌘` on Apple platforms, `Ctrl` everywhere else. */
export const MOD_KEY = isApplePlatform() ? '⌘' : 'Ctrl';

/** The label for the palette shortcut: `⌘K` or `Ctrl K`. */
export const MOD_KEY_K = MOD_KEY === '⌘' ? '⌘K' : 'Ctrl K';
