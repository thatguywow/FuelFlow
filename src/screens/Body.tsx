import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useUi } from '../state/ui';
import { useTargets } from '../state/useTargets';
import { activeFast, endFast, getBiometrics, logBiometric, startFast } from '../db/repo';
import { toDayKey, formatDuration, daysBetween } from '../core/dates';
import { fromKg } from '../core/units';
import { projectGoalDate } from '../core/trend';
import type { BiometricType } from '../db/schema';
import { Button, Card, EmptyState, Input, SectionLabel, Sheet, cx , ScreenHeader } from '../ui/primitives';
import { LineChart, Sparkline } from '../ui/charts';
import { IconClock, IconPlus, IconScale } from '../ui/icons';

const MEASUREMENTS: { type: BiometricType; label: string; unit: string; step: number }[] = [
  { type: 'bodyFatPct', label: 'Body fat', unit: '%', step: 0.1 },
  { type: 'waistCm', label: 'Waist', unit: 'cm', step: 0.5 },
  { type: 'hipCm', label: 'Hips', unit: 'cm', step: 0.5 },
  { type: 'chestCm', label: 'Chest', unit: 'cm', step: 0.5 },
  { type: 'armCm', label: 'Arm', unit: 'cm', step: 0.5 },
  { type: 'thighCm', label: 'Thigh', unit: 'cm', step: 0.5 },
  { type: 'restingHr', label: 'Resting HR', unit: 'bpm', step: 1 },
  { type: 'sleepHours', label: 'Sleep', unit: 'h', step: 0.25 },
];

/** Body composition, measurements and the fasting timer. */
export default function Body() {
  const openSheet = useUi((s) => s.openSheet);
  const derived = useTargets();
  const [editing, setEditing] = useState<BiometricType | null>(null);

  const measurements = useLiveQuery(async () => {
    const entries = await Promise.all(
      MEASUREMENTS.map(async (m) => [m.type, await getBiometrics(m.type)] as const),
    );
    return Object.fromEntries(entries) as Partial<Record<BiometricType, { day: string; value: number }[]>>;
  }, []);

  if (!derived) return <div className="safe-t p-4"><div className="skeleton h-64 rounded-(--radius-card)" /></div>;

  const { profile, currentWeightKg, trend, rate } = derived;
  const unit = profile.display.massUnit;
  const goal = profile.goal.targetWeightKg;
  const projection = goal && rate ? projectGoalDate(currentWeightKg, goal, rate.kgPerWeek) : null;

  return (
    <div className="safe-t space-y-5 px-4 pb-8">
      <ScreenHeader title="Body" />

      {/* ---------- Weight ---------- */}
      <Card className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[34px] font-semibold leading-none tnum">
                {fromKg(currentWeightKg, unit).toFixed(1)}
              </span>
              <span className="text-[15px] text-faint">{unit}</span>
            </div>
            <p className="mt-1 text-[12.5px] text-faint">Trend weight, not your last reading</p>
          </div>
          <Button variant="primary" size="sm" onClick={() => openSheet({ kind: 'log-weight' })}>
            <IconScale size={16} />
            Weigh in
          </Button>
        </div>

        {trend.length >= 2 ? (
          <LineChart
            height={140}
            series={[
              {
                points: trend.map((p) => ({ x: daysBetween(trend[0]!.day, p.day), y: fromKg(p.trendKg, unit) })),
                color: 'var(--color-brand)',
                width: 2.5,
                fill: true,
              },
            ]}
            scatter={{
              points: trend
                .filter((p) => p.rawKg !== undefined)
                .map((p) => ({ x: daysBetween(trend[0]!.day, p.day), y: fromKg(p.rawKg!, unit) })),
              color: 'var(--color-dim)',
            }}
            formatY={(v) => v.toFixed(1)}
          />
        ) : (
          // One reading is not nothing — telling someone who just weighed in to
          // "log your first weight" reads as though the app lost it.
          <EmptyState
            title={trend.length === 1 ? 'One weigh-in so far' : 'No weigh-ins yet'}
            detail={
              trend.length === 1
                ? 'Log another and the trend line starts. A few readings a week is plenty.'
                : 'Log your weight and the trend line, your rate of change and your measured expenditure all come to life.'
            }
          />
        )}

        {rate && Number.isFinite(rate.confidenceKgPerWeek) && (
          <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 text-center">
            <div>
              <div className={cx('text-[17px] font-semibold tnum', rate.kgPerWeek < 0 ? 'text-ok' : 'text-info')}>
                {rate.kgPerWeek >= 0 ? '+' : ''}
                {fromKg(rate.kgPerWeek, unit).toFixed(2)}
              </div>
              <div className="text-[11px] uppercase tracking-[0.06em] text-faint">{unit} / week</div>
            </div>
            <div>
              <div className="text-[17px] font-semibold tnum">
                {projection ? `${projection.days}d` : goal ? '—' : 'No goal'}
              </div>
              <div className="text-[11px] uppercase tracking-[0.06em] text-faint">
                {projection ? 'to goal' : goal ? 'not on track' : 'set one in goals'}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* ---------- Fasting ---------- */}
      <FastingCard />

      {/* ---------- Measurements ---------- */}
      <section>
        <SectionLabel>Measurements</SectionLabel>
        <Card padded={false} className="overflow-hidden">
          {MEASUREMENTS.map((item, index) => {
            const history = measurements?.[item.type] ?? [];
            const latest = history[history.length - 1];
            return (
              <button
                key={item.type}
                onClick={() => setEditing(item.type)}
                className={cx(
                  'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2',
                  index > 0 && 'border-t border-border',
                )}
              >
                <span className="flex-1 text-[15px]">{item.label}</span>
                {history.length >= 3 && (
                  <Sparkline values={history.slice(-14).map((h) => h.value)} width={56} height={20} />
                )}
                <span className="w-20 text-right text-[14px] text-dim tnum">
                  {latest ? `${latest.value} ${item.unit}` : <IconPlus size={16} className="ml-auto text-faint" />}
                </span>
              </button>
            );
          })}
        </Card>
      </section>

      {editing && (
        <MeasurementSheet
          type={editing}
          onClose={() => setEditing(null)}
          config={MEASUREMENTS.find((m) => m.type === editing)!}
          current={measurements?.[editing]?.slice(-1)[0]?.value}
        />
      )}
    </div>
  );
}

/**
 * Fasting timer. Independent of the diary on purpose: a fast is a clock, not a
 * food entry, and it keeps running across app restarts because the start time
 * is persisted rather than held in memory.
 */
function FastingCard() {
  const toast = useUi((s) => s.toast);
  const fast = useLiveQuery(() => activeFast(), []);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!fast) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fast]);

  const elapsed = fast ? now - fast.startTs : 0;
  const progress = fast ? Math.min(1, elapsed / (fast.targetHours * 3_600_000)) : 0;

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <IconClock size={18} className="text-brand" />
        <h2 className="flex-1 text-[15px] font-medium">Fasting</h2>
        {fast && <span className="text-[12.5px] text-faint tnum">target {fast.targetHours}h</span>}
      </div>

      {fast ? (
        <>
          <div className="text-center">
            <div className="text-[34px] font-semibold leading-none tnum">{formatDuration(elapsed)}</div>
            <p className="mt-1.5 text-[12.5px] text-faint">
              {progress >= 1 ? 'Target reached' : `${Math.round(progress * 100)}% of the way there`}
            </p>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${progress * 100}%` }} />
          </div>
          <Button
            full
            onClick={async () => {
              await endFast(fast.id);
              toast(`Fast ended after ${formatDuration(elapsed)}`);
            }}
          >
            End fast
          </Button>
        </>
      ) : (
        <div className="flex gap-2">
          {[16, 18, 20, 24].map((hours) => (
            <Button
              key={hours}
              size="sm"
              className="flex-1"
              onClick={async () => {
                await startFast(hours);
                toast(`${hours}h fast started`);
              }}
            >
              {hours}h
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

function MeasurementSheet({
  type,
  config,
  current,
  onClose,
}: {
  type: BiometricType;
  config: { label: string; unit: string; step: number };
  current?: number;
  onClose: () => void;
}) {
  const toast = useUi((s) => s.toast);
  const [value, setValue] = useState(current !== undefined ? String(current) : '');

  return (
    <Sheet
      open
      onClose={onClose}
      size="auto"
      title={config.label}
      footer={
        <Button
          variant="primary"
          full
          disabled={!Number.isFinite(Number(value)) || value === ''}
          onClick={async () => {
            await logBiometric(toDayKey(), type, Number(value));
            onClose();
            toast(`${config.label} logged`);
          }}
        >
          Save
        </Button>
      }
    >
      <div className="p-4">
        <Input
          type="number"
          inputMode="decimal"
          step={config.step}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="h-14 text-center text-[26px] font-semibold"
          placeholder={config.unit}
        />
        {type === 'bodyFatPct' && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-faint">
            Recording body fat switches your resting-rate estimate to the Katch-McArdle equation,
            which is based on lean mass and is more accurate if you are lean or muscular.
          </p>
        )}
      </div>
    </Sheet>
  );
}
