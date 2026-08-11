import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useUi, type Tab } from './state/ui';
import { useTargets } from './state/useTargets';
import { ensureProfile, readProfile } from './db/repo';
import { ensureCoreData } from './db/seed';
import { ToastHost, cx } from './ui/primitives';
import { IconBody, IconChart, IconFlame, IconMore } from './ui/icons';
import Today from './screens/Today';
import Trends from './screens/Trends';
import Body from './screens/Body';
import More from './screens/More';
import Onboarding from './screens/Onboarding';
import SheetHost from './screens/SheetHost';

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

  const profile = derived?.profile;
  // A brand-new profile still has its factory height and weight, which is the
  // signal that onboarding has never run.
  const needsOnboarding = profile !== undefined && profile.createdAt === profile.updatedAt;

  if (needsOnboarding) return <Onboarding />;

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col">
      <main className="flex-1 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]">
        {tab === 'today' && <Today />}
        {tab === 'trends' && <Trends />}
        {tab === 'body' && <Body />}
        {tab === 'more' && <More />}
      </main>

      {/* Content scrolling under a translucent bar stays legible through it and
          reads as a rendering fault. This fades it out just above the nav so it
          dissolves into the chrome instead of being sliced by it. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto h-24 max-w-2xl"
        style={{
          background: 'linear-gradient(to top, var(--color-bg) 35%, transparent)',
        }}
        aria-hidden="true"
      />

      <nav className="glass safe-b fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-2xl border-t border-border">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
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
        })}
      </nav>

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
        ?.setAttribute('content', resolved === 'dark' ? '#0e1015' : '#f5f7fb');
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
