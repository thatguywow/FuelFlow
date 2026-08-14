import { Fragment, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useUi, type Tab } from './state/ui';
import { useTargets } from './state/useTargets';
import { ensureProfile, readProfile } from './db/repo';
import { ensureCoreData } from './db/seed';
import { dismissBoot } from './main';
import { applyNativeChrome } from './ui/systemChrome';
import { useAndroidBackButton } from './ui/backButton';
import { ToastHost, cx } from './ui/primitives';
import { IconBody, IconChart, IconFlame, IconMore } from './ui/icons';
import Today from './screens/Today';
import Trends from './screens/Trends';
import Body from './screens/Body';
import More from './screens/More';
import Onboarding from './screens/Onboarding';
import SheetHost from './screens/SheetHost';
import AddMenu, { AddButton } from './screens/AddMenu';

const TABS: { id: Tab; label: string; icon: (p: { size?: number }) => React.ReactElement }[] = [
  { id: 'today', label: 'Today', icon: IconFlame },
  { id: 'trends', label: 'Trends', icon: IconChart },
  { id: 'body', label: 'Body', icon: IconBody },
  { id: 'more', label: 'More', icon: IconMore },
];

export default function App() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const derived = useTargets();

  useThemeSync();
  useCoreDataInstall();
  useProfileSeed();
  useMidnightRollover();
  useAndroidBackButton();

  // Hold the launch screen until there is something real to show. Dropping it
  // on mount would just reveal a screen of skeletons.
  useEffect(() => {
    if (derived) dismissBoot();
  }, [derived]);

  const profile = derived?.profile;
  // A brand-new profile still has its factory height and weight, which is the
  // signal that onboarding has never run.
  const needsOnboarding = profile !== undefined && profile.createdAt === profile.updatedAt;

  if (needsOnboarding) return <Onboarding />;

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-2xl flex-col overflow-hidden">
      {/*
        The page scrolls inside <main>, not on the document.

        Android draws the *root* scroller's scrollbar natively, outside the
        page's control — `::-webkit-scrollbar` and `scrollbar-width` do nothing
        to it, which is why a pale overlay bar kept appearing down the edge of
        the diary however many times it was hidden in CSS. A nested scroll
        container is a normal element, so hiding its bar actually works.
      */}
      <main className="no-scrollbar flex-1 overflow-y-auto overscroll-y-contain pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]">
        {tab === 'today' && <Today />}
        {tab === 'trends' && <Trends />}
        {tab === 'body' && <Body />}
        {tab === 'more' && <More />}
      </main>

      {/* Content scrolling under a translucent bar stays legible through it and
          reads as a rendering fault.

          The solid stop has to clear the bar's full height, not just part of
          it: the tab bar is 4rem tall, so a fade that went solid at 34px left
          its top half sitting over a still-transparent ramp, and the diary
          showed through the bar's own 72% tint. Solid to the top of the bar,
          then a soft ramp above it so content dissolves rather than being
          sliced. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto h-36 max-w-2xl"
        style={{
          background:
            'linear-gradient(to top, var(--color-bg) calc(4rem + env(safe-area-inset-bottom, 0px)), transparent 9rem)',
        }}
        aria-hidden="true"
      />

      {/* Layering: fade 30, add-menu scrim 40, add-menu items 41, this bar 42,
          sheets 50, toasts 60. The bar must sit above the scrim so the button
          stays visible and can be tapped again to dismiss — a menu you cannot
          see the way out of is worse than no menu — but below sheets, which
          cover everything. */}
      <nav className="glass safe-b-edge fixed inset-x-0 bottom-0 z-[42] mx-auto flex max-w-2xl border-t border-border">
        {TABS.map(({ id, label, icon: Icon }, index) => {
          const active = tab === id;
          // The add button occupies the middle slot, so the four tabs split
          // two and two around it.
          const button = (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-current={active ? 'page' : undefined}
              className="group relative flex flex-1 flex-col items-center gap-1 py-2.5"
            >
              {/* A lit rail above the active tab, rather than just recolouring
                  the glyph — it gives the bar a sense of state at a glance. */}
              <span
                className={cx(
                  'absolute inset-x-[28%] top-0 h-[2px] rounded-full transition-all duration-300',
                  active
                    ? 'brand-gradient opacity-100 shadow-[0_0_12px_1px_var(--ff-brand-glow)]'
                    : 'opacity-0',
                )}
              />
              <span
                className={cx(
                  'transition-[color,transform] duration-200',
                  active
                    ? 'scale-105 text-brand drop-shadow-[0_0_8px_var(--ff-brand-glow)]'
                    : 'text-faint group-hover:text-dim',
                )}
              >
                <Icon size={22} />
              </span>
              <span
                className={cx(
                  'text-[10px] font-medium tracking-wide transition-colors duration-200',
                  active ? 'text-brand' : 'text-faint group-hover:text-dim',
                )}
              >
                {label}
              </span>
            </button>
          );

          // Slot the add button between the second and third tabs.
          return index === 2 ? (
            <Fragment key={id}>
              <AddButton />
              {button}
            </Fragment>
          ) : (
            button
          );
        })}
      </nav>

      <AddMenu />
      <SheetHost />
      <ToastHost />
    </div>
  );
}

/**
 * Creates the profile row on a fresh install. Writes cannot happen inside a
 * live query, so this is the one place the default row is persisted.
 */
function useProfileSeed() {
  useEffect(() => {
    void ensureProfile();
  }, []);
}

/**
 * Rolls the diary over at local midnight.
 *
 * Polled rather than scheduled for the exact moment: a phone suspends timers
 * while the screen is off, so a single timeout aimed at midnight simply would
 * not fire. Re-checking whenever the app returns to the foreground is what
 * actually catches the common case of opening it the next morning.
 */
function useMidnightRollover() {
  useEffect(() => {
    const sync = () => useUi.getState().syncToday();
    const onVisible = () => {
      if (!document.hidden) sync();
    };
    const id = window.setInterval(sync, 30_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', sync);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', sync);
    };
  }, []);
}

/** Applies the saved theme to <html>, following the OS when set to "system". */
function useThemeSync() {
  const preference = useLiveQuery(
    async () => (await readProfile())?.display.theme ?? 'system',
    [],
    'system' as const,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
      document.documentElement.dataset.theme = resolved;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', resolved === 'dark' ? '#080a0f' : '#f5f7fb');

      // Mirror for the pre-paint script in index.html, which has to pick a
      // ground for the launch screen before IndexedDB can be opened. Written
      // here rather than where the setting is saved so it also tracks the OS
      // flipping under a "system" preference.
      try {
        localStorage.setItem('ff.theme', resolved);
      } catch {
        /* storage disabled; the launch screen falls back to the OS setting */
      }

      // Match the Android system bars to the app rather than to the OS theme.
      // Without this, setting the app to light on a dark phone leaves a black
      // navigation bar under a white app.
      void applyNativeChrome(resolved);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preference]);
}

/**
 * Installs the bundled USDA core dataset on first launch. It runs in the
 * background and chunked, so the app is usable while it seeds; a missing
 * dataset is not an error, just a deployment that has not built one yet.
 */
function useCoreDataInstall() {
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void ensureCoreData();
    };
    // `window.requestIdleCallback` must stay bound to `window`; pulling it off
    // the object and calling it bare throws an illegal-invocation error.
    const supportsIdle = typeof window.requestIdleCallback === 'function';
    const handle = supportsIdle
      ? window.requestIdleCallback(run, { timeout: 3000 })
      : window.setTimeout(run, 400);

    return () => {
      cancelled = true;
      if (supportsIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);
}
