import { useLiveQuery } from 'dexie-react-hooks';
import { useUi } from '../state/ui';
import { useDay, useTargets } from '../state/useTargets';
import { formatDayLabel, isToday, toDayKey } from '../core/dates';
import { N, sumNutrients } from '../core/nutrients';
import { describeConfidence } from '../core/adaptive';
import { addWater, currentStreak, deleteEntry, restoreEntry, setDayComplete } from '../db/repo';
import { getFood } from '../db/repo';
import type { DiaryEntry } from '../db/schema';
import type { DayKey } from '../core/dates';
import { Button, Card, IconButton, SectionLabel, cx } from '../ui/primitives';
import { EnergyRing, type MacroBarDatum } from '../ui/charts';
import { tapFeedback, useAnimatedNumber, useStagger } from '../ui/motion';
import { useSwipe } from '../ui/gestures';
import { formatCount } from '../core/format';
import {
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDroplet,
  IconPlus,
  IconSparkle,
  IconTrash,
} from '../ui/icons';

export default function Today() {
  const day = useUi((s) => s.day);
  const stepDay = useUi((s) => s.stepDay);
  const setDay = useUi((s) => s.setDay);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);

  const derived = useTargets();
  const dayData = useDay(day);
  const streak = useLiveQuery(() => currentStreak(), [], 0);

  // Swiping is how people move through days on a phone; the chevrons stay for
  // pointer users. Forward is blocked on today so you cannot swipe into
  // tomorrow.
  const swipeRef = useSwipe<HTMLDivElement>({
    onSwipeLeft: () => {
      if (!isToday(day)) stepDay(1);
    },
    onSwipeRight: () => stepDay(-1),
  });

  if (!derived || !dayData) return <TodaySkeleton />;

  const { targets, profile, adaptive } = derived;
  const consumed = sumNutrients(dayData.entries.map((e) => e.nutrients));
  const exerciseBonus = profile.addExerciseCalories ? dayData.exerciseKcal : 0;
  const energy = consumed[N.ENERGY] ?? 0;
  const confidence = describeConfidence(adaptive);
  const showLearning = profile.useAdaptiveTdee && confidence.level !== 'good';

  const macroData: MacroBarDatum[] = [
    { key: 'protein', label: 'Protein', consumed: consumed[N.PROTEIN] ?? 0, target: targets.macros.protein },
    {
      key: 'carbs',
      label: profile.display.netCarbs ? 'Net carbs' : 'Carbs',
      consumed: profile.display.netCarbs
        ? Math.max(0, (consumed[N.CARBS] ?? 0) - (consumed[N.FIBER] ?? 0))
        : (consumed[N.CARBS] ?? 0),
      target: targets.macros.carbs,
    },
    { key: 'fat', label: 'Fat', consumed: consumed[N.FAT] ?? 0, target: targets.macros.fat },
  ];

  return (
    <div ref={swipeRef} className="safe-t px-4 pb-6">
      {/* ---------- Day navigation ---------- */}
      <header className="flex items-center justify-between py-3">
        <IconButton label="Previous day" onClick={() => stepDay(-1)}>
          <IconChevronLeft />
        </IconButton>

        <button
          onClick={() => setDay(toDayKey())}
          className="flex flex-col items-center px-3"
          title="Jump to today"
        >
          <span className="text-[17px] font-semibold">{formatDayLabel(day)}</span>
          {streak > 1 && !profile.display.hideStreaks && (
            <span className="text-[11px] font-medium text-brand">{streak} day streak</span>
          )}
        </button>

        <IconButton
          label="Next day"
          onClick={() => stepDay(1)}
          className={cx(isToday(day) && 'pointer-events-none opacity-30')}
        >
          <IconChevronRight />
        </IconButton>
      </header>

      {/* ---------- Hero ---------- */}
      <Card glow className="flex flex-col items-center gap-5 overflow-hidden py-6">
        <EnergyRing
          consumed={energy}
          target={targets.energyKcal + exerciseBonus}
          macros={macroData}
        />

        {/* Legend for the inner arcs. The arcs carry the proportions; these
            carry the numbers. */}
        <div className="grid w-full grid-cols-3 gap-2">
          {macroData.map((macro) => (
            <MacroLegend key={macro.key} macro={macro} />
          ))}
        </div>

        <div className="grid w-full grid-cols-3 divide-x divide-border border-t border-border pt-4 text-center">
          <Stat label="Eaten" value={Math.round(energy)} />
          <Stat
            label="Target"
            value={Math.round(targets.energyKcal + exerciseBonus)}
            accent
            onClick={() => openSheet({ kind: 'goals' })}
          />
          <Stat label={exerciseBonus > 0 ? 'Exercise' : 'Burned'} value={Math.round(dayData.exerciseKcal)} />
        </div>

        <button
          onClick={() => openSheet({ kind: 'nutrient-detail', day })}
          className="rounded-full border border-border bg-surface-2 px-4 py-2 text-[13px] font-medium text-brand transition-colors hover:border-brand/40 hover:bg-brand-soft"
        >
          All nutrients →
        </button>
      </Card>

      {/* ---------- Adaptive status ---------- */}
      {showLearning && (
        <button
          onClick={() => useUi.getState().setTab('trends')}
          className="mt-3 flex w-full items-start gap-3 rounded-[--radius-card] border border-border bg-brand-soft/40 p-3.5 text-left"
        >
          <IconSparkle size={18} className="mt-0.5 shrink-0 text-brand" />
          <div>
            <p className="text-[14px] font-medium">{confidence.headline}</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-dim">{confidence.detail}</p>
          </div>
        </button>
      )}

      {targets.warnings.length > 0 && (
        <div className="mt-3 rounded-[--radius-card] border border-warn/30 bg-warn/10 p-3.5">
          {targets.warnings.map((warning) => (
            <p key={warning.code} className="text-[12.5px] leading-relaxed text-dim">
              {warning.message}
            </p>
          ))}
        </div>
      )}

      <WaterStrip
        day={day}
        ml={dayData.waterMl}
        targetMl={derived.nutrientTargets.get(N.WATER)?.target ?? 3000}
      />

      {/* ---------- Meals ---------- */}
      {/* Adding food now lives entirely behind the central button, so the diary
          starts right below the summary instead of being pushed under a row of
          tiles stranded mid-screen. */}
      <div className="mt-6 space-y-5">
        {profile.meals.map((meal) => {
          const entries = dayData.entries.filter((e) => e.mealId === meal.id);
          const mealKcal = entries.reduce((sum, e) => sum + (e.nutrients[N.ENERGY] ?? 0), 0);

          return (
            <section key={meal.id}>
              <SectionLabel
                action={
                  <span className="text-[12px] font-medium text-faint tnum">
                    {formatCount(mealKcal)} kcal
                  </span>
                }
              >
                {meal.name}
              </SectionLabel>

              <Card padded={false} className="overflow-hidden">
                {entries.map((entry, index) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    index={index}
                    mealId={meal.id}
                    day={day}
                  />
                ))}

                <div className={cx('flex items-center', entries.length > 0 && 'border-t border-border')}>
                  <button
                    onClick={() => openSheet({ kind: 'add-food', mealId: meal.id, day })}
                    className="flex flex-1 items-center gap-2 px-4 py-3 text-[14px] font-medium text-brand transition-colors hover:bg-surface-2"
                  >
                    <IconPlus size={17} />
                    Add food
                  </button>
                  {entries.length > 0 && (
                    <IconButton
                      label={`Copy ${meal.name} to another day`}
                      onClick={() => openSheet({ kind: 'add-food', mealId: meal.id, day })}
                      className="mr-2"
                    >
                      <IconCopy size={16} />
                    </IconButton>
                  )}
                </div>
              </Card>
            </section>
          );
        })}
      </div>

      {/* ---------- Complete-log marker ---------- */}
      {dayData.entries.length > 0 && (
        <Button
          variant={dayData.logComplete ? 'primary' : 'secondary'}
          full
          className="mt-6"
          onClick={async () => {
            await setDayComplete(day, !dayData.logComplete);
            toast(
              dayData.logComplete
                ? 'Marked as incomplete'
                : 'Marked complete — this day now counts towards your expenditure estimate',
            );
          }}
        >
          <IconCheck size={18} />
          {dayData.logComplete ? 'Logged everything' : 'Mark day complete'}
        </Button>
      )}

      <p className="mt-3 px-2 text-center text-[11.5px] leading-relaxed text-faint">
        Marking a day complete tells the expenditure model this intake is real, not a half-finished log.
      </p>
    </div>
  );
}

const MACRO_LEGEND_COLOR: Record<MacroBarDatum['key'], string> = {
  protein: 'var(--color-protein)',
  carbs: 'var(--color-carbs)',
  fat: 'var(--color-fat)',
};

function MacroLegend({ macro }: { macro: MacroBarDatum }) {
  const shown = useAnimatedNumber(macro.consumed, { duration: 700 });
  const color = MACRO_LEGEND_COLOR[macro.key];
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1.5">
        <span
          className="size-[7px] rounded-full"
          style={{ background: color, boxShadow: `0 0 8px -1px ${color}` }}
        />
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">
          {macro.label}
        </span>
      </div>
      <div className="mt-1 text-[13.5px] tnum">
        <span className="font-semibold text-text">{formatCount(shown)}</span>
        <span className="text-faint"> / {formatCount(macro.target)} g</span>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  onClick,
}: {
  label: string;
  value: number;
  accent?: boolean;
  onClick?: () => void;
}) {
  const shown = useAnimatedNumber(value, { duration: 650 });
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={cx('py-1', onClick && 'transition-opacity hover:opacity-70')}>
      <div className={cx('text-[20px] font-semibold tracking-[-0.02em] tnum', accent && 'brand-text')}>
        {formatCount(shown)}
      </div>
      <div className="mt-1 text-[10.5px] font-medium uppercase tracking-[0.09em] text-faint">
        {label}
      </div>
    </Tag>
  );
}

/**
 * One diary row. Extracted so each can hold its own stagger state — the meal
 * list cascades in rather than appearing as a single slab.
 */
function EntryRow({
  entry,
  index,
  mealId,
  day,
}: {
  entry: DiaryEntry;
  index: number;
  mealId: string;
  day: DayKey;
}) {
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);
  const shown = useStagger(index, 35);

  return (
    <div
      className={cx(
        'transition-[opacity,transform] duration-300 ease-[--ease-out-quint]',
        shown ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
      )}
    >
      {index > 0 && <div className="ml-4 h-px bg-border" />}
      <div className="group flex items-center gap-2 pr-2">
        <button
          onClick={async () => {
            const food = entry.foodId ? await getFood(entry.foodId) : undefined;
            if (food) openSheet({ kind: 'food-detail', food, mealId, day, entryId: entry.id });
          }}
          className="min-w-0 flex-1 px-4 py-3 text-left transition-colors hover:bg-surface-2"
        >
          <div className="truncate text-[15px]">{entry.name}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-faint">
            {entry.brand ? `${entry.brand} · ` : ''}
            {entry.quickAdd ? 'Quick add' : entry.portionLabel ?? `${Math.round(entry.grams)} g`}
          </div>
        </button>

        <span className="shrink-0 text-[14px] font-medium text-dim tnum">
          {formatCount(entry.nutrients[N.ENERGY] ?? 0)}
        </span>

        <IconButton
          label={`Remove ${entry.name}`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={async () => {
            await deleteEntry(entry.id);
            toast(`Removed ${entry.name}`, {
              action: { label: 'Undo', run: () => void restoreEntry(entry.id) },
            });
          }}
        >
          <IconTrash size={16} />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * Slim water strip. Logging water moved into the add menu, but the running
 * total is still worth seeing at a glance, and a one-tap top-up next to it
 * saves a trip through the menu for the most repeated action of the day.
 */
function WaterStrip({ day, ml, targetMl }: { day: DayKey; ml: number; targetMl: number }) {
  const toast = useUi((s) => s.toast);
  const shown = useAnimatedNumber(ml, { duration: 500 });
  const ratio = targetMl > 0 ? Math.min(1, ml / targetMl) : 0;
  const width = useAnimatedNumber(ratio * 100, { duration: 600, epsilon: 0.2 });

  return (
    <button
      onClick={async () => {
        await addWater(day, 250);
        void tapFeedback();
        toast('250 ml logged');
      }}
      className="panel mt-3 flex w-full items-center gap-3 px-4 py-3 text-left transition-[border-color,transform] duration-150 hover:border-border-strong active:scale-[0.99]"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
        <IconDroplet size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between">
          <span className="text-[13.5px] font-medium">Water</span>
          <span className="text-[12.5px] text-faint tnum">
            {(shown / 1000).toFixed(1)} / {(targetMl / 1000).toFixed(1)} L
          </span>
        </span>
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-2">
          <span
            className="block h-full rounded-full"
            style={{ width: `${width}%`, background: 'var(--color-brand)' }}
          />
        </span>
      </span>
      <IconPlus size={16} className="shrink-0 text-faint" />
    </button>
  );
}

function TodaySkeleton() {
  return (
    <div className="safe-t space-y-3 px-4 pt-6">
      <div className="skeleton h-10 rounded-xl" />
      <div className="skeleton h-80 rounded-[--radius-card]" />
      <div className="skeleton h-24 rounded-[--radius-card]" />
      <div className="skeleton h-24 rounded-[--radius-card]" />
    </div>
  );
}
