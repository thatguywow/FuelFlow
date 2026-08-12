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
  sheet: Sheet;
  toasts: Toast[];
  onboardingComplete: boolean;
  /** The central add-menu, which is chrome rather than a sheet. */
  addMenuOpen: boolean;

  setTab: (tab: Tab) => void;
  setDay: (day: DayKey) => void;
  stepDay: (delta: number) => void;
  openSheet: (sheet: Sheet) => void;
  closeSheet: () => void;
  setAddMenu: (open: boolean) => void;
  toast: (message: string, options?: Omit<Toast, 'id' | 'message'>) => void;
  dismissToast: (id: number) => void;
  setOnboardingComplete: (value: boolean) => void;
}

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
  tab: 'today',
  day: toDayKey(),
  sheet: { kind: 'none' },
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

  // Opening a sheet always dismisses the add menu; leaving it expanded behind a
  // sheet means it is still open when the sheet closes.
  openSheet: (sheet) => set({ sheet, addMenuOpen: false }),
  closeSheet: () => set({ sheet: { kind: 'none' } }),
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
