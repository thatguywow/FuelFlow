import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { useUi } from '../state/ui';

/**
 * Android's back gesture and button.
 *
 * Capacitor does not wire these to anything by default: the WebView has no
 * history to go back through, so every press did nothing at all. The app has to
 * define what "back" means at each depth.
 *
 * Innermost first — a sheet, then the add menu, then the tab you came from —
 * and only when there is nothing left to dismiss does back leave the app. That
 * last step asks for confirmation by requiring a second press, because on
 * Android the back button is also how people idly navigate, and closing a
 * half-finished diary entry by accident is a bad way to lose work.
 */
export function useAndroidBackButton(): void {
  const pendingExit = useRef(false);
  const exitTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let remove: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const { App } = await import('@capacitor/app');
      const handle = await App.addListener('backButton', () => {
        const state = useUi.getState();

        // 1. A sheet is open: step back through the stack it was opened from.
        if (state.sheet.kind !== 'none') {
          state.backSheet();
          return;
        }

        // 2. The add menu is expanded.
        if (state.addMenuOpen) {
          state.setAddMenu(false);
          return;
        }

        // 3. Anywhere but the first tab: back returns to Today.
        if (state.tab !== 'today') {
          state.setTab('today');
          return;
        }

        // 4. On Today with nothing open — press again to leave.
        if (pendingExit.current) {
          void App.exitApp();
          return;
        }
        pendingExit.current = true;
        state.toast('Press back again to exit');
        window.clearTimeout(exitTimer.current);
        exitTimer.current = window.setTimeout(() => {
          pendingExit.current = false;
        }, 2000);
      });

      if (cancelled) {
        void handle.remove();
        return;
      }
      remove = () => void handle.remove();
    })();

    return () => {
      cancelled = true;
      remove?.();
      window.clearTimeout(exitTimer.current);
    };
  }, []);
}
