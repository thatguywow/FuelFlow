import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shell configuration.
 *
 * The same `dist/` that GitHub Pages serves is what Capacitor packages into the
 * iOS and Android apps — one build, two delivery channels. Native gets three
 * things the web build cannot have: ML Kit barcode scanning and text
 * recognition, a settable User-Agent for Open Food Facts (browsers forbid that
 * header, which is why the web build falls back to query parameters), and the
 * OS share sheet for backups.
 */
const config: CapacitorConfig = {
  appId: 'app.fuelflow',
  appName: 'FuelFlow',
  webDir: 'dist',

  // Capacitor serves the bundle from a local origin at the root, so the app
  // must be built with VITE_BASE unset (or "/") before `cap sync` — the
  // "/<repo>/" base used for GitHub Pages would break every asset path here.
  server: {
    androidScheme: 'https',
  },

  android: {
    // Open Food Facts asks every client to identify itself. A browser cannot
    // set User-Agent, but a native WebView can, so the native builds are
    // properly identified for all in-page requests. Direct API calls go through
    // CapacitorHttp, which sets the full header.
    appendUserAgent: 'FuelFlow/0.1.0',

    // The WebView paints its own background between the native launch window
    // going away and the page's first frame. Left at the default that gap is a
    // flash of black between the launch mark and the app — the "then it goes
    // black for a bit" in the middle of an otherwise continuous start.
    backgroundColor: '#080A0F',
  },

  ios: {
    contentInset: 'never',
    appendUserAgent: 'FuelFlow/0.1.0',
  },

  plugins: {
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'DARK',
    },
    Camera: {
      // Only ever used for on-device nutrition-label recognition; no image
      // leaves the device.
      androidxMaterialVersion: '1.12.0',
    },
  },
};

export default config;
