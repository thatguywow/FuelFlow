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
import { EnergyRing, MacroRow, type MacroBarDatum } from '../ui/charts';
import { tapFeedback, useAnimatedNumber, useStagger } from '../ui/motion';
import { useSwipe } from '../ui/gestures';
import { formatCount } from '../core/format';
import { formatVolume } from '../core/units';
import {
  IconBolt,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconDroplet,
  IconFlame,
  IconPlus,
  IconSparkle,
  IconTarget,
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
    // Sections are spaced by the container rather than by margins on each
    // block, so a label can never end up sitting against the card above it.
    <div ref={swipeRef} className="safe-t space-y-5 px-4 pb-6">
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

      {/* ---------- Energy ---------- */}
      {/* Gauge on the left with the figures stacked beside it, rather than a
          big ring with everything underneath: the same information in about
          half the height, so the diary is visible without scrolling. */}
      <section>
      <SectionLabel
        action={
          <button
            onClick={() => openSheet({ kind: 'goals' })}
            className="text-[12.5px] font-semibold text-brand"
          >
            Adjust
          </button>
        }
      >
        Calories
      </SectionLabel>
      <Card glow className="overflow-hidden">
        <div className="flex items-center gap-4">
          <EnergyRing consumed={energy} target={targets.energyKcal + exerciseBonus} />

          <div className="min-w-0 flex-1 space-y-2">
            <StatRow
              icon={<IconFlame size={15} />}
              label="Eaten"
              value={Math.round(energy)}
              tone="carbs"
            />
            <StatRow
              icon={<IconTarget size={15} />}
              label="Target"
              value={Math.round(targets.energyKcal + exerciseBonus)}
              tone="brand"
              onClick={() => openSheet({ kind: 'goals' })}
            />
            <StatRow
              icon={<IconBolt size={15} />}
              label={exerciseBonus > 0 ? 'Exercise' : 'Burned'}
              value={Math.round(dayData.exerciseKcal)}
              tone="fiber"
            />
          </div>
        </div>
      </Card>
      </section>

      {/* ---------- Macros ---------- */}
      <section>
      <SectionLabel
        action={
          <button
            onClick={() => openSheet({ kind: 'nutrient-detail', day })}
            className="text-[12.5px] font-semibold text-brand"
          >
            All nutrients
          </button>
        }
      >
        Macronutrients
      </SectionLabel>
      <Card className="space-y-3.5">
        {macroData.map((macro) => (
          <MacroRow key={macro.key} macro={macro} />
        ))}
      </Card>
      </section>

      <WaterRow
        day={day}
        ml={dayData.waterMl}
        targetMl={derived.nutrientTargets.get(N.WATER)?.target ?? 3000}
      />

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

      {/* ---------- Meals ---------- */}
      <section>
      <SectionLabel>Diary</SectionLabel>
      <div className="space-y-2.5">
        {profile.meals.map((meal) => {
          const entries = dayData.entries.filter((e) => e.mealId === meal.id);
          const mealKcal = entries.reduce((sum, e) => sum + (e.nutrients[N.ENERGY] ?? 0), 0);

          return (
            <Card key={meal.id} padded={false} className="overflow-hidden">
              {/* Header doubles as the add control: the meal name, what it adds
                  up to, and a target big enough to hit without aiming. */}
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-[17px]">
                  {MEAL_GLYPH[meal.id] ?? '🍽️'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold">{meal.name}</span>
                  <span className="block text-[12px] text-faint tnum">
                    {entries.length === 0
                      ? 'Nothing yet'
                      : `${formatCount(mealKcal)} kcal · ${entries.length} ${entries.length === 1 ? 'item' : 'items'}`}
                  </span>
                </span>
                <button
                  onClick={() => openSheet({ kind: 'add-food', mealId: meal.id, day })}
                  aria-label={`Add food to ${meal.name}`}
                  className="brand-gradient grid size-9 shrink-0 place-items-center rounded-full text-brand-contrast shadow-[0_0_12px_-3px_var(--ff-brand-glow)] transition-transform active:scale-90"
                >
                  <IconPlus size={19} strokeWidth={2.25} />
                </button>
              </div>

              {entries.length > 0 && (
                <div className="border-t border-border">
                  {entries.map((entry, index) => (
                    <EntryRow key={entry.id} entry={entry} index={index} mealId={meal.id} day={day} />
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>
      </section>

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

/**
 * A glyph per meal. Purely to give each row an anchor the eye can find while
 * scrolling — the text alone made four identical grey blocks.
 */
const MEAL_GLYPH: Record<string, string> = {
  breakfast: '🍳',
  lunch: '🥗',
  dinner: '🍲',
  snacks: '🍎',
};

const TONE: Record<string, string> = {
  brand: 'var(--color-brand)',
  carbs: 'var(--color-carbs)',
  fiber: 'var(--color-fiber)',
};

/**
 * One figure beside the gauge: tinted glyph, label, value. Stacking these
 * vertically rather than spreading them in a row under the gauge keeps the
 * whole summary to roughly the height of the gauge itself.
 */
function StatRow({
  icon,
  label,
  value,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: keyof typeof TONE;
  onClick?: () => void;
}) {
  const shown = useAnimatedNumber(value, { duration: 650 });
  const color = TONE[tone] ?? 'var(--color-brand)';
  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-[--radius-input] border border-border bg-surface-2 px-2.5 py-2 text-left',
        onClick && 'transition-colors hover:border-brand/40',
      )}
    >
      <span
        className="grid size-7 shrink-0 place-items-center rounded-lg"
        style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-semibold uppercase tracking-[0.09em] text-faint">
          {label}
        </span>
        <span className="block text-[15px] font-semibold tnum">{formatCount(shown)}</span>
      </span>
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
 * Water row, docked inside the summary card rather than floating between the
 * card and the diary where it read as an orphan.
 *
 * The whole row opens the water sheet — where drinks can be reviewed and
 * removed — while the trailing button adds a glass without leaving the screen.
 * Amounts under a litre are shown in millilitres: rendering 250 ml as "0.3 L"
 * looked like the app had rounded the glass up.
 */
function WaterRow({ day, ml, targetMl }: { day: DayKey; ml: number; targetMl: number }) {
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);
  const shown = useAnimatedNumber(ml, { duration: 500 });
  const ratio = targetMl > 0 ? Math.min(1, ml / targetMl) : 0;
  const width = useAnimatedNumber(ratio * 100, { duration: 600, epsilon: 0.2 });

  return (
    <div className="flex w-full items-center gap-3 border-t border-border pt-4">
      <button
        onClick={() => openSheet({ kind: 'water', day })}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
          <IconDroplet size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium">Water</span>
            <span className="text-[12px] text-faint tnum">
              {formatVolume(shown)} / {formatVolume(targetMl)}
            </span>
          </span>
          <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full"
              style={{ width: `${width}%`, background: 'var(--color-brand)' }}
            />
          </span>
        </span>
      </button>
      <button
        onClick={async () => {
          await addWater(day, 250);
          void tapFeedback();
          toast('250 ml logged');
        }}
        aria-label="Add 250 ml of water"
        className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-dim transition-colors hover:border-brand/40 hover:text-brand active:scale-90"
      >
        <IconPlus size={15} />
      </button>
    </div>
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
