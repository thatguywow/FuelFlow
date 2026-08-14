import { create } from 'zustand';
import { toDayKey, type DayKey } from '../core/dates';
import type { Food } from '../db/schema';

/**
 * Ephemeral UI state only.
 *
 * Everything durable lives in IndexedDB and reaches components through
 * `useLiveQuery`, so this store never becomes a second source of truth. What is
 * here is the stuff that should vanish on reload: which day you are looking at,
 * which sheet is open, pending toasts.
 */

export type Tab = 'today' | 'trends' | 'body' | 'more';

export type Sheet =
  | { kind: 'none' }
  | { kind: 'add-food'; mealId: string; day: DayKey }
  | { kind: 'food-detail'; food: Food; mealId: string; day: DayKey; entryId?: string }
  | { kind: 'quick-log'; mealId: string; day: DayKey }
  | { kind: 'quick-add'; mealId: string; day: DayKey }
  | { kind: 'scanner'; mealId: string; day: DayKey }
  | { kind: 'label-scanner'; mealId: string; day: DayKey }
  | { kind: 'nutrient-detail'; day: DayKey }
  | { kind: 'log-weight' }
  | { kind: 'log-exercise'; day: DayKey }
  | { kind: 'water'; day: DayKey }
  | { kind: 'create-food'; barcode?: string; mealId?: string; day?: DayKey }
  | { kind: 'recipe-builder'; recipeId?: string }
  | { kind: 'settings' }
  | { kind: 'goals' }
  | { kind: 'data' };

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  tone?: 'default' | 'danger';
}

interface UiState {
  tab: Tab;
  day: DayKey;
  /** The local calendar date as last observed, so a rollover can be detected. */
  todayKey: DayKey;
  sheet: Sheet;
  /** Sheets this one was opened on top of, most recent last. */
  sheetHistory: Sheet[];
  /**
   * The last food search, kept outside the sheet so stepping back to it
   * restores what was typed. Sheets are re-created from their descriptor when
   * reopened, so any state held inside the component is gone by then — which
   * made "back" land on an empty search box.
   */
  foodQuery: string;
  toasts: Toast[];
  onboardingComplete: boolean;
  /** The central add-menu, which is chrome rather than a sheet. */
  addMenuOpen: boolean;

  setTab: (tab: Tab) => void;
  setDay: (day: DayKey) => void;
  stepDay: (delta: number) => void;
  /** Re-read the wall clock and roll the diary over at local midnight. */
  syncToday: () => void;
  openSheet: (sheet: Sheet) => void;
  /** Dismiss the whole stack. */
  closeSheet: () => void;
  /** Return to the sheet this one was opened from, if there was one. */
  backSheet: () => void;
  setFoodQuery: (query: string) => void;
  setAddMenu: (open: boolean) => void;
  toast: (message: string, options?: Omit<Toast, 'id' | 'message'>) => void;
  dismissToast: (id: number) => void;
  setOnboardingComplete: (value: boolean) => void;
}

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
  tab: 'today',
  day: toDayKey(),
  todayKey: toDayKey(),
  sheet: { kind: 'none' },
  sheetHistory: [],
  foodQuery: '',
  toasts: [],
  onboardingComplete: false,
  addMenuOpen: false,

  setTab: (tab) => set({ tab }),
  setDay: (day) => set({ day }),
  stepDay: (delta) => {
    const [y, m, d] = get().day.split('-').map(Number);
    const date = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + delta);
    set({ day: toDayKey(date) });
  },

  /**
   * The diary day is fixed when the store is created, so an app left open
   * across local midnight would keep calling yesterday "Today" and file new
   * entries under it. Following the rollover only applies when the user is
   * sitting on the day that has just stopped being today — if they had
   * navigated elsewhere, moving the screen under them would be worse.
   */
  syncToday: () => {
    // Reads the clock through `toDayKey`, which routes via `now()` — so a test
    // can place the app either side of midnight without patching Date itself.
    const observed = toDayKey();
    const { todayKey, day } = get();
    if (observed === todayKey) return;
    set({ todayKey: observed, day: day === todayKey ? observed : day });
  },

  // Opening a sheet always dismisses the add menu; leaving it expanded behind a
  // sheet means it is still open when the sheet closes.
  //
  // The sheet it replaces is remembered so a nested one can step back to it.
  // Opening a food from search used to overwrite the search outright, so
  // dismissing the food closed everything and a second helping meant starting
  // the search again from the plus button.
  openSheet: (sheet) =>
    set((state) => ({
      sheet,
      sheetHistory:
        state.sheet.kind === 'none' ? [] : [...state.sheetHistory, state.sheet].slice(-4),
      addMenuOpen: false,
    })),

  /** Dismiss everything, for when the task is finished. */
  closeSheet: () => set({ sheet: { kind: 'none' }, sheetHistory: [], foodQuery: '' }),

  setFoodQuery: (foodQuery) => set({ foodQuery }),

  /** Step back one sheet, or dismiss if this is the only one. */
  backSheet: () =>
    set((state) => {
      const previous = state.sheetHistory[state.sheetHistory.length - 1];
      if (!previous) return { sheet: { kind: 'none' as const }, sheetHistory: [] };
      return { sheet: previous, sheetHistory: state.sheetHistory.slice(0, -1) };
    }),
  setAddMenu: (addMenuOpen) => set({ addMenuOpen }),

  toast: (message, options) => {
    const id = ++toastId;
    set((state) => ({ toasts: [...state.toasts, { id, message, ...options }] }));
    // Toasts with an action stay longer — undo needs a real window to act in.
    setTimeout(() => get().dismissToast(id), options?.action ? 6000 : 3000);
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  setOnboardingComplete: (value) => set({ onboardingComplete: value }),
}));
