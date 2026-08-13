import { Capacitor } from '@capacitor/core';

/**
 * Keeps the Android system bars in step with the app's own theme.
 *
 * The generated theme resolves its colours from `values` / `values-night`,
 * which follow the *operating system's* setting. That is right whenever the app
 * is on "system", and wrong the moment someone picks light or dark explicitly:
 * a light app on a dark phone kept a black navigation bar under a white screen.
 * Only the running app knows which theme it actually resolved, so it sets the
 * bars itself.
 *
 * Web is a no-op — a browser tab does not own the system chrome, and
 * `theme-color` already covers what it can influence.
 */

/** Backgrounds, straight from the web theme's tokens. */
const GROUND = { dark: '#080A0F', light: '#F5F7FB' } as const;

export async function applyNativeChrome(theme: 'dark' | 'light'): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const ground = GROUND[theme];
  // Content style is the *inverse* of the ground: dark ground needs light
  // glyphs. Capacitor names the styles after the content, not the background.
  const style = theme === 'dark' ? 'DARK' : 'LIGHT';

  await Promise.all([
    import('@capacitor/status-bar')
      .then(async ({ StatusBar, Style }) => {
        await StatusBar.setStyle({ style: style === 'DARK' ? Style.Dark : Style.Light });
        // Throws on iOS, where the bar is not separately colourable.
        await StatusBar.setBackgroundColor({ color: ground }).catch(() => undefined);
      })
      .catch(() => undefined),

    import('@capgo/capacitor-navigation-bar')
      .then(({ NavigationBar }) => NavigationBar.setNavigationBarColor({ color: ground }))
      .catch(() => undefined),
  ]);
}
