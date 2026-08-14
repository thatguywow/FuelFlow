import { useEffect } from 'react';
import { useUi } from '../state/ui';
import { useTargets } from '../state/useTargets';
import { cx } from '../ui/primitives';
import { tapFeedback } from '../ui/motion';
import { IconBolt, IconCompose, IconLabel, IconPlus, IconScan, IconSearch } from '../ui/icons';

/**
 * The central add button and its menu.
 *
 * Every way of getting food into the diary lives behind one control, in the one
 * place a thumb naturally rests. Previously these were tiles stranded in the
 * middle of the Today screen, which pushed the actual diary below the fold and
 * made the most-used actions the hardest to reach one-handed.
 *
 * Items fan upward with a stagger so the menu reads as unfolding from the
 * button rather than appearing on top of it.
 */

interface Action {
  id: string;
  label: string;
  detail: string;
  icon: React.ReactElement;
  run: () => void;
}

/** Nearest meal to the current time, so the sheet opens on the likely one. */
function currentMeal(meals: { id: string; defaultTime: number }[]): string {
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  let best = meals[0];
  let bestDistance = Infinity;
  for (const meal of meals) {
    const distance = Math.abs(meal.defaultTime - now);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = meal;
    }
  }
  return best?.id ?? 'snacks';
}

export default function AddMenu() {
  const open = useUi((s) => s.addMenuOpen);
  const setOpen = useUi((s) => s.setAddMenu);
  const openSheet = useUi((s) => s.openSheet);
  const day = useUi((s) => s.day);
  const derived = useTargets();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  const mealId = derived ? currentMeal(derived.profile.meals) : 'snacks';

  const actions: Action[] = [
    {
      id: 'search',
      label: 'Search foods',
      detail: 'The full database',
      icon: <IconSearch size={19} />,
      run: () => openSheet({ kind: 'add-food', mealId, day }),
    },
    {
      id: 'barcode',
      label: 'Scan barcode',
      detail: 'Packaged products',
      icon: <IconScan size={19} />,
      run: () => openSheet({ kind: 'scanner', mealId, day }),
    },
    {
      id: 'label',
      label: 'Scan label',
      detail: 'Read a nutrition panel',
      icon: <IconLabel size={19} />,
      run: () => openSheet({ kind: 'label-scanner', mealId, day }),
    },
    {
      id: 'quick-add',
      label: 'Quick calories',
      detail: 'Type the numbers',
      icon: <IconPlus size={19} />,
      run: () => openSheet({ kind: 'quick-add', mealId, day }),
    },
    {
      id: 'quick-log',
      label: 'Log a whole meal',
      detail: 'Write it out, log it in one go',
      icon: <IconCompose size={19} />,
      run: () => openSheet({ kind: 'quick-log', mealId, day }),
    },
    {
      id: 'exercise',
      label: 'Log exercise',
      detail: 'Calories you burned',
      icon: <IconBolt size={19} />,
      run: () => openSheet({ kind: 'log-exercise', day }),
    },
    // Water is deliberately absent: it has its own row on the Today card, one
    // tap away, and having it in both places made the menu look padded.
  ];

  return (
    <>
      {/* Scrim. Sits above the page but below the nav so the button itself
          stays visible and can be tapped again to close.
          Heavily dimmed and blurred on purpose: a light scrim over an already
          dark page leaves the diary perfectly readable in the gaps between menu
          items, and the menu stops reading as a layer of its own. */}
      <div
        className={cx(
          'fixed inset-0 z-40 transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        style={{
          background: 'color-mix(in oklab, var(--color-bg) 82%, transparent)',
          backdropFilter: 'blur(10px) saturate(120%)',
          WebkitBackdropFilter: 'blur(10px) saturate(120%)',
        }}
        onClick={() => setOpen(false)}
        aria-hidden={!open}
      />

      <div
        className="pointer-events-none fixed inset-x-0 z-[41] mx-auto flex max-w-2xl flex-col items-center gap-2 px-4"
        style={{ bottom: 'calc(6rem + env(safe-area-inset-bottom, 0px))' }}
        role="menu"
        aria-hidden={!open}
      >
        {actions.map((action, index) => (
          <button
            key={action.id}
            role="menuitem"
            tabIndex={open ? 0 : -1}
            onClick={() => {
              void tapFeedback();
              action.run();
            }}
            className={cx(
              'panel flex w-full max-w-[17rem] items-center gap-3 px-3.5 py-2 text-left shadow-(--shadow-e2)',
              'transition-[opacity,transform] duration-300 ease-(--ease-out-quint)',
              'active:scale-[0.97] hover:border-border-strong',
              open ? 'pointer-events-auto translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
            )}
            style={{
              // Reverse the stagger so the item nearest the button leads, which
              // is the direction the menu appears to grow from.
              transitionDelay: open ? `${(actions.length - 1 - index) * 28}ms` : '0ms',
            }}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
              {action.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] font-medium">{action.label}</span>
              <span className="block truncate text-[12px] text-faint">{action.detail}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

/** The button itself, rendered inside the tab bar so it sits in the notch. */
export function AddButton() {
  const open = useUi((s) => s.addMenuOpen);
  const setOpen = useUi((s) => s.setAddMenu);

  return (
    <div className="relative flex w-16 shrink-0 justify-center">
      <button
        onClick={() => {
          void tapFeedback();
          setOpen(!open);
        }}
        aria-label={open ? 'Close add menu' : 'Add to diary'}
        aria-expanded={open}
        className={cx(
          'brand-gradient glow-brand absolute -top-6 grid size-14 place-items-center rounded-2xl',
          'text-brand-contrast transition-transform duration-200 ease-(--ease-spring) active:scale-90',
        )}
      >
        {/* Only the glyph rotates. Rotating the button turns a rounded square
            into a diamond, which reads as a glitch rather than a state. */}
        <span
          className={cx(
            'grid place-items-center transition-transform duration-300 ease-(--ease-spring)',
            open && 'rotate-45',
          )}
        >
          <IconPlus size={26} strokeWidth={2.25} />
        </span>
      </button>
    </div>
  );
}
