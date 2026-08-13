import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTargets } from '../state/useTargets';
import { useUi } from '../state/ui';
import { formatCount } from '../core/format';
import { dailySummaries } from '../db/repo';
import { addDays, daysBetween, formatDayLabel, lastNDays, toDayKey } from '../core/dates';
import { N } from '../core/nutrients';
import { describeConfidence } from '../core/adaptive';
import { fromKg } from '../core/units';
import { Card, EmptyState, SectionLabel, Segmented, cx , ScreenHeader } from '../ui/primitives';
import { BarChart, LineChart } from '../ui/charts';
import { IconChart, IconInfo } from '../ui/icons';

type Range = 14 | 30 | 90;

/**
 * Trends.
 *
 * The centrepiece is the expenditure chart: your measured metabolic rate over
 * time with its uncertainty band. No other consumer tracker shows you this,
 * and it is the number every target in the app is built on, so it should be
 * inspectable rather than hidden behind a formula.
 */
export default function Trends() {
  const derived = useTargets();
  const openSheet = useUi((s) => s.openSheet);
  const [range, setRange] = useState<Range>(30);

  const days = useMemo(() => lastNDays(range), [range]);
  const summaries = useLiveQuery(
    () => dailySummaries(addDays(toDayKey(), -(range - 1)), toDayKey()),
    [range],
  );

  if (!derived || !summaries) return <div className="safe-t p-4"><div className="skeleton h-64 rounded-(--radius-card)" /></div>;

  const { targets, adaptive, formulaTdee, profile, trend, rate } = derived;
  const confidence = describeConfidence(adaptive);
  const unit = profile.display.massUnit;

  const loggedDays = summaries.filter((s) => s.entryCount > 0);
  const averageIntake =
    loggedDays.length > 0
      ? loggedDays.reduce((sum, s) => sum + (s.nutrients[N.ENERGY] ?? 0), 0) / loggedDays.length
      : 0;

  const adherence = loggedDays.length / days.length;

  // Expenditure series, clipped to the selected window.
  const expenditureSeries = (adaptive?.series ?? []).filter(
    (point) => daysBetween(days[0]!, point.day) >= 0,
  );

  return (
    <div className="safe-t space-y-5 px-4 pb-8">
      <div className="flex items-start justify-between gap-3">
        <ScreenHeader title="Trends" />
        <Segmented
          value={String(range) as '14' | '30' | '90'}
          onChange={(value) => setRange(Number(value) as Range)}
          options={[
            { value: '14', label: '2w' },
            { value: '30', label: '1m' },
            { value: '90', label: '3m' },
          ]}
          className="w-40"
        />
      </div>

      {/* ---------- Expenditure ---------- */}
      <section>
        <SectionLabel>Energy expenditure</SectionLabel>
        <Card className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[30px] font-semibold tnum">
              {formatCount(adaptive?.expenditureKcal ?? formulaTdee)}
            </span>
            <span className="text-[14px] text-faint">kcal/day</span>
            {adaptive && (
              <span className="ml-auto text-[12.5px] text-faint tnum">
                ± {Math.round(adaptive.sdKcal)}
              </span>
            )}
          </div>

          {expenditureSeries.length > 2 ? (
            <LineChart
              height={160}
              series={[
                {
                  points: expenditureSeries.map((p) => ({
                    x: daysBetween(days[0]!, p.day),
                    y: p.expenditureKcal,
                  })),
                  band: expenditureSeries.map((p) => ({
                    upper: p.expenditureKcal + p.sdKcal,
                    lower: p.expenditureKcal - p.sdKcal,
                  })),
                  color: 'var(--color-brand)',
                  width: 2.5,
                },
                {
                  points: expenditureSeries.map((p) => ({
                    x: daysBetween(days[0]!, p.day),
                    y: formulaTdee,
                  })),
                  color: 'var(--color-faint)',
                  width: 1,
                  dashed: true,
                },
              ]}
              formatY={(v) => formatCount(v)}
              unit="kcal"
              scrubLabel={(x) => formatDayLabel(addDays(days[0]!, Math.round(x)))}
            />
          ) : (
            <div className="grid h-32 place-items-center rounded-xl bg-surface-2 text-[13px] text-faint">
              Not enough data to plot yet
            </div>
          )}

          <div className="flex items-start gap-2.5 rounded-xl bg-surface-2 p-3">
            <IconInfo size={16} className="mt-0.5 shrink-0 text-faint" />
            <div className="text-[12.5px] leading-relaxed">
              <p className="font-medium">{confidence.headline}</p>
              <p className="mt-0.5 text-faint">{confidence.detail}</p>
              <p className="mt-1.5 text-faint">
                Dashed line is the textbook formula estimate
                {' '}({formatCount(formulaTdee)} kcal). The solid line is measured from your
                own intake and weight.
              </p>
            </div>
          </div>
        </Card>
      </section>

      {/* ---------- Weight ---------- */}
      <section>
        <SectionLabel
          action={
            rate && Number.isFinite(rate.confidenceKgPerWeek) ? (
              <span className={cx('text-[12px] font-medium tnum', rate.kgPerWeek < 0 ? 'text-ok' : 'text-info')}>
                {rate.kgPerWeek >= 0 ? '+' : ''}
                {fromKg(rate.kgPerWeek, unit).toFixed(2)} {unit}/wk
              </span>
            ) : undefined
          }
        >
          Weight trend
        </SectionLabel>
        <Card>
          {trend.length >= 2 ? (
            <>
              <LineChart
                height={160}
                series={[
                  {
                    points: trend
                      .filter((p) => daysBetween(days[0]!, p.day) >= 0)
                      .map((p) => ({ x: daysBetween(days[0]!, p.day), y: fromKg(p.trendKg, unit) })),
                    color: 'var(--color-brand)',
                    width: 2.5,
                    fill: true,
                  },
                ]}
                scatter={{
                  points: trend
                    .filter((p) => p.rawKg !== undefined && daysBetween(days[0]!, p.day) >= 0)
                    .map((p) => ({ x: daysBetween(days[0]!, p.day), y: fromKg(p.rawKg!, unit) })),
                  color: 'var(--color-dim)',
                }}
                formatY={(v) => v.toFixed(1)}
                unit={unit}
                scrubLabel={(x) => formatDayLabel(addDays(days[0]!, Math.round(x)))}
              />
              <p className="mt-2 text-[12px] leading-relaxed text-faint">
                Drag across either chart to read a specific day. Dots are individual weigh-ins; the
                line is the trend — judge progress by the line, since a single reading is mostly water.
                {rate && rate.rSquared < 0.25 && ' The trend is still noisy, so treat the rate as provisional.'}
              </p>
            </>
          ) : (
            <EmptyState
              title={trend.length === 1 ? 'One weigh-in so far' : 'No weigh-ins yet'}
              detail="Log your weight a few times a week and the trend line, your rate of change and your measured expenditure all come to life."
            />
          )}
        </Card>
      </section>

      {/* ---------- Intake ---------- */}
      <section>
        <SectionLabel
          action={
            <span className="text-[12px] text-faint tnum">
              avg {formatCount(averageIntake)} kcal
            </span>
          }
        >
          Daily intake
        </SectionLabel>
        <Card>
          {loggedDays.length > 0 ? (
            <BarChart
              height={130}
              target={targets.energyKcal}
              bars={summaries.map((s, index) => ({
                label: index % Math.ceil(range / 8) === 0 ? s.day.slice(8) : '',
                value: s.nutrients[N.ENERGY] ?? 0,
                highlight: index === summaries.length - 1,
              }))}
            />
          ) : (
            <EmptyState icon={<IconChart size={28} />} title="Nothing logged in this window" />
          )}
        </Card>
      </section>

      {/* ---------- Consistency ---------- */}
      <section>
        <SectionLabel>Consistency</SectionLabel>
        <Card className="grid grid-cols-3 gap-3 text-center">
          <Metric label="Days logged" value={`${loggedDays.length}/${days.length}`} />
          <Metric label="Adherence" value={`${Math.round(adherence * 100)}%`} />
          <Metric
            label="Avg protein"
            value={`${Math.round(
              loggedDays.reduce((sum, s) => sum + (s.nutrients[N.PROTEIN] ?? 0), 0) /
                Math.max(1, loggedDays.length),
            )} g`}
          />
        </Card>
        <p className="mt-2 px-1 text-[11.5px] leading-relaxed text-faint">
          Adherence is days logged, not days you hit the target. Logging honestly on a bad day is
          what keeps the expenditure estimate accurate — hiding it is what breaks it.
        </p>
      </section>

      <button
        onClick={() => openSheet({ kind: 'goals' })}
        className="w-full rounded-(--radius-card) border border-border bg-surface p-4 text-left"
      >
        <p className="text-[15px] font-medium">Adjust goal and targets</p>
        <p className="mt-0.5 text-[12.5px] text-faint">
          Currently {goalSentence(profile.goal.rateKgPerWeek, unit)} · {formatCount(targets.energyKcal)} kcal/day
        </p>
      </button>
    </div>
  );
}

function goalSentence(rateKgPerWeek: number, unit: 'kg' | 'lb' | 'st'): string {
  if (Math.abs(rateKgPerWeek) < 0.01) return 'maintaining';
  const amount = Math.abs(fromKg(rateKgPerWeek, unit)).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${rateKgPerWeek < 0 ? 'losing' : 'gaining'} ${amount} ${unit}/week`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[19px] font-semibold tnum">{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-[0.06em] text-faint">{label}</div>
    </div>
  );
}
