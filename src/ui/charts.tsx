import { useId, useMemo } from 'react';
import { cx } from './primitives';

/**
 * Charts.
 *
 * All hand-drawn SVG. A charting library would add far more to the bundle than
 * these six shapes cost to write, and none would inherit the theme tokens
 * without a wrapper anyway. Every colour comes from a CSS variable, so light
 * and dark are handled by the stylesheet rather than by JavaScript.
 */

// ---------------------------------------------------------------------------
// Energy ring
// ---------------------------------------------------------------------------

export function EnergyRing({
  consumed,
  target,
  size = 200,
  stroke = 15,
  label,
  sublabel,
}: {
  consumed: number;
  target: number;
  size?: number;
  stroke?: number;
  label?: string;
  sublabel?: string;
}) {
  // Gradient and filter ids must be unique per instance or a second ring on the
  // page silently reuses the first one's definitions.
  const uid = useId().replace(/:/g, '');
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = target > 0 ? consumed / target : 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  const over = ratio > 1;
  const sweep = over ? Math.min(1, ratio - 1) : clamped;

  const remaining = Math.round(target - consumed);
  const primary = label ?? Math.abs(remaining).toLocaleString();
  const secondary = sublabel ?? (remaining >= 0 ? 'kcal left' : 'kcal over');

  const arcColor = over ? 'var(--color-warn)' : `url(#ring-${uid})`;

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90 overflow-visible" aria-hidden="true">
        <defs>
          <linearGradient id={`ring-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--ff-brand)" />
            <stop offset="55%" stopColor="var(--ff-brand-2)" />
            <stop offset="100%" stopColor="var(--ff-brand-3)" />
          </linearGradient>
          <filter id={`glow-${uid}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation={stroke * 0.45} result="blur" />
            <feComposite in="blur" operator="over" />
          </filter>
        </defs>

        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-surface-2)"
          strokeWidth={stroke}
        />

        {/* When intake exceeds the target, the full ring is drawn in the warning
            colour and the overshoot rides on top, so the eye reads "past the
            line" rather than "back near the start". */}
        {over && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--color-warn)"
            strokeWidth={stroke}
            opacity={0.3}
          />
        )}

        {/* A blurred copy of the arc underneath is what makes the ring glow
            rather than just being a coloured line. */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={arcColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - sweep)}
          filter={`url(#glow-${uid})`}
          opacity={0.55}
          style={{ transition: 'stroke-dashoffset 700ms var(--ease-out-quint)' }}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={arcColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - sweep)}
          style={{ transition: 'stroke-dashoffset 700ms var(--ease-out-quint), stroke 240ms' }}
        />
      </svg>

      <div className="absolute inset-0 grid place-content-center text-center">
        <div className="text-[44px] font-semibold leading-none tracking-[-0.035em] tnum">{primary}</div>
        <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
          {secondary}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Macro bars
// ---------------------------------------------------------------------------

export interface MacroBarDatum {
  key: 'protein' | 'carbs' | 'fat';
  label: string;
  consumed: number;
  target: number;
}

const MACRO_COLOR: Record<MacroBarDatum['key'], string> = {
  protein: 'var(--color-protein)',
  carbs: 'var(--color-carbs)',
  fat: 'var(--color-fat)',
};

export function MacroBars({ data, compact }: { data: MacroBarDatum[]; compact?: boolean }) {
  return (
    <div className={cx('grid gap-3.5', compact ? 'grid-cols-3' : 'grid-cols-1')}>
      {data.map((item) => {
        const ratio = item.target > 0 ? item.consumed / item.target : 0;
        const over = ratio > 1.02;
        const color = over ? 'var(--color-warn)' : MACRO_COLOR[item.key];
        return (
          <div key={item.key} className={compact ? '' : 'flex items-center gap-3'}>
            {!compact && <span className="w-16 shrink-0 text-[13px] text-dim">{item.label}</span>}
            <div className={compact ? '' : 'flex-1'}>
              {compact && (
                <div className="mb-2 flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full" style={{ background: color }} />
                  <span className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">
                    {item.label}
                  </span>
                </div>
              )}
              <div className="h-[5px] overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full transition-[width] duration-700 ease-[--ease-out-quint]"
                  style={{
                    width: `${Math.min(100, ratio * 100)}%`,
                    background: `linear-gradient(90deg, color-mix(in oklab, ${color} 65%, transparent), ${color})`,
                    boxShadow: `0 0 10px -2px ${color}`,
                  }}
                />
              </div>
              <div className="mt-2 flex items-baseline gap-1 text-[12.5px] tnum">
                <span className="font-semibold text-text">{Math.round(item.consumed)}</span>
                <span className="text-faint">/ {Math.round(item.target)} g</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nutrient progress row
// ---------------------------------------------------------------------------

export function NutrientBar({
  label,
  amount,
  target,
  unit,
  status,
}: {
  label: string;
  amount: number;
  target?: number;
  unit: string;
  status: 'low' | 'ok' | 'high' | 'over-limit' | 'unknown';
}) {
  const ratio = target && target > 0 ? amount / target : 0;
  const color =
    status === 'over-limit'
      ? 'var(--color-danger)'
      : status === 'low'
        ? 'var(--color-warn)'
        : status === 'high'
          ? 'var(--color-info)'
          : 'var(--color-ok)';

  return (
    <div className="flex items-center gap-3 py-2">
      <span className="w-28 shrink-0 truncate text-[13px] text-dim">{label}</span>
      <div className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, ratio * 100)}%`, background: color }}
        />
      </div>
      <span className="w-24 shrink-0 text-right text-[12px] text-faint tnum">
        <span className="text-text">{formatCompact(amount)}</span>
        {target ? ` / ${formatCompact(target)}` : ''} {unit}
      </span>
    </div>
  );
}

function formatCompact(value: number): string {
  if (value === 0) return '0';
  if (value < 1) return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toLocaleString();
}

// ---------------------------------------------------------------------------
// Line chart
// ---------------------------------------------------------------------------

export interface LinePoint {
  x: number;
  y: number;
}

export interface LineSeries {
  points: LinePoint[];
  color: string;
  width?: number;
  dashed?: boolean;
  /** Draws a shaded ± band around the line, e.g. a confidence interval. */
  band?: { upper: number; lower: number }[];
  fill?: boolean;
}

/**
 * Generic line chart with an optional uncertainty band. Used for the weight
 * trend (raw dots + smoothed line) and for adaptive expenditure (estimate plus
 * its ±1 SD band, which is the honest way to show a filtered quantity).
 */
export function LineChart({
  series,
  scatter,
  height = 180,
  yTicks = 4,
  formatY = (v: number) => String(Math.round(v)),
  xLabels,
  className,
}: {
  series: LineSeries[];
  scatter?: { points: LinePoint[]; color: string };
  height?: number;
  yTicks?: number;
  formatY?: (value: number) => string;
  xLabels?: { x: number; label: string }[];
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const width = 320;
  const padding = { top: 8, right: 8, bottom: 20, left: 38 };

  const bounds = useMemo(() => {
    const all: number[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        all.push(p.y);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
      }
      for (const b of s.band ?? []) all.push(b.upper, b.lower);
    }
    for (const p of scatter?.points ?? []) {
      all.push(p.y);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    if (all.length === 0) return null;
    let minY = Math.min(...all);
    let maxY = Math.max(...all);
    // A flat series would collapse to a zero-height range and divide by zero.
    if (maxY - minY < 1e-6) {
      minY -= 1;
      maxY += 1;
    }
    const pad = (maxY - minY) * 0.12;
    return { minX, maxX: maxX === minX ? minX + 1 : maxX, minY: minY - pad, maxY: maxY + pad };
  }, [series, scatter]);

  if (!bounds) return <div style={{ height }} className="skeleton" />;

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const sx = (x: number) => padding.left + ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * plotW;
  const sy = (y: number) => padding.top + (1 - (y - bounds.minY) / (bounds.maxY - bounds.minY)) * plotH;

  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => bounds.minY + ((bounds.maxY - bounds.minY) * i) / yTicks);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cx('w-full', className)}
      preserveAspectRatio="none"
      role="img"
    >
      <defs>
        {series.map((s, index) => (
          <linearGradient key={index} id={`fill-${uid}-${index}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={s.color} stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>

      {ticks.map((tick, i) => (
        <g key={i}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={sy(tick)}
            y2={sy(tick)}
            stroke="var(--color-border)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={padding.left - 6}
            y={sy(tick) + 3}
            textAnchor="end"
            fontSize={9}
            fill="var(--color-faint)"
          >
            {formatY(tick)}
          </text>
        </g>
      ))}

      {series.map((s, index) => (
        <g key={index}>
          {s.band && s.band.length === s.points.length && (
            <path d={bandPath(s.points, s.band, sx, sy)} fill={s.color} opacity={0.14} stroke="none" />
          )}
          {s.fill && s.points.length > 0 && (
            <path
              d={`${linePath(s.points, sx, sy)} L ${sx(s.points[s.points.length - 1]!.x)} ${sy(bounds.minY)} L ${sx(s.points[0]!.x)} ${sy(bounds.minY)} Z`}
              fill={`url(#fill-${uid}-${index})`}
            />
          )}
          <path
            d={linePath(s.points, sx, sy)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width ?? 2}
            strokeDasharray={s.dashed ? '4 4' : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}

      {scatter?.points.map((p, i) => (
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={1.8} fill={scatter.color} opacity={0.55} />
      ))}

      {xLabels?.map((item, i) => (
        <text
          key={i}
          x={sx(item.x)}
          y={height - 6}
          textAnchor="middle"
          fontSize={9}
          fill="var(--color-faint)"
        >
          {item.label}
        </text>
      ))}
    </svg>
  );
}

function linePath(points: LinePoint[], sx: (x: number) => number, sy: (y: number) => number): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(2)} ${sy(p.y).toFixed(2)}`).join(' ');
}

function bandPath(
  points: LinePoint[],
  band: { upper: number; lower: number }[],
  sx: (x: number) => number,
  sy: (y: number) => number,
): string {
  const upper = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(2)} ${sy(band[i]!.upper).toFixed(2)}`);
  const lower = points
    .slice()
    .reverse()
    .map((p, i) => {
      const bandIndex = points.length - 1 - i;
      return `L ${sx(p.x).toFixed(2)} ${sy(band[bandIndex]!.lower).toFixed(2)}`;
    });
  return `${upper.join(' ')} ${lower.join(' ')} Z`;
}

// ---------------------------------------------------------------------------
// Bar chart
// ---------------------------------------------------------------------------

export function BarChart({
  bars,
  target,
  height = 120,
  className,
}: {
  bars: { label: string; value: number; highlight?: boolean }[];
  target?: number;
  height?: number;
  className?: string;
}) {
  const max = Math.max(target ?? 0, ...bars.map((b) => b.value), 1) * 1.1;

  return (
    <div className={cx('relative flex items-end gap-[3px]', className)} style={{ height }}>
      {target !== undefined && target > 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border-strong"
          style={{ bottom: `${(target / max) * 100}%` }}
        >
          <span className="absolute -top-4 right-0 text-[10px] text-faint tnum">
            {Math.round(target).toLocaleString()}
          </span>
        </div>
      )}
      {bars.map((bar, i) => (
        <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div
            className={cx(
              'w-full rounded-[3px] transition-[height] duration-500 ease-[--ease-out-quint]',
              bar.value === 0
                ? 'bg-surface-2'
                : bar.highlight
                  ? 'brand-gradient shadow-[0_0_10px_-2px_var(--ff-brand-glow)]'
                  : target && bar.value > target
                    ? 'bg-warn/70'
                    : 'bg-brand/40',
            )}
            style={{ height: `${Math.max(bar.value === 0 ? 2 : 4, (bar.value / max) * 100)}%` }}
            title={`${bar.label}: ${Math.round(bar.value).toLocaleString()}`}
          />
          <span className="truncate text-[9px] text-faint">{bar.label}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

export function Sparkline({
  values,
  color = 'var(--color-brand)',
  width = 72,
  height = 24,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / span) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
