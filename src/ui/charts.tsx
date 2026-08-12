import { useId, useMemo, useRef } from 'react';
import { cx } from './primitives';
import { useAnimatedNumber, useScrub } from './motion';
import { formatCount } from '../core/format';

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

/** Point on the ring at a given fraction of a full turn, starting at 12 o'clock. */
function pointOnRing(cx: number, cy: number, r: number, turn: number) {
  const angle = -Math.PI / 2 + turn * 2 * Math.PI;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/** Arc between two positions on the ring, both as fractions of a full turn. */
function arcBetween(cx: number, cy: number, r: number, fromTurn: number, toTurn: number): string {
  const start = pointOnRing(cx, cy, r, fromTurn);
  const end = pointOnRing(cx, cy, r, toTurn);
  const large = Math.abs(toTurn - fromTurn) > 0.5 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

/**
 * The gauge is an open 270° arc rather than a closed ring: the gap at the
 * bottom gives the eye a start and an end, so a nearly-empty gauge reads as
 * "barely begun" instead of as a broken circle.
 */
const GAUGE_START = -0.375;
const GAUGE_SWEEP = 0.75;

export function EnergyRing({
  consumed,
  target,
  size = 168,
  stroke = 12,
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
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size - stroke) / 2;

  const ratio = target > 0 ? consumed / target : 0;
  const over = ratio > 1;
  const fill = over ? Math.min(1, ratio - 1) : Math.min(1, Math.max(0, ratio));

  const progress = useAnimatedNumber(fill, { duration: 900, epsilon: 0.0015 });
  const remaining = target - consumed;
  const shownRemaining = useAnimatedNumber(Math.abs(remaining), { duration: 700 });

  const primary = label ?? formatCount(shownRemaining);
  const secondary = sublabel ?? (remaining >= 0 ? 'kcal left' : 'kcal over');
  const arcColor = over ? 'var(--color-warn)' : `url(#ring-${uid})`;

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          {/* Anchored to the gauge's own box in user space and running top to
              bottom, so the arc deepens from cyan to indigo as it sweeps — the
              same travel as the app mark. A gradient defined in percentages
              sampled only its middle, which flattened the whole arc to one blue. */}
          <linearGradient id={`ring-${uid}`} gradientUnits="userSpaceOnUse" x1={cx} y1={0} x2={cx} y2={size}>
            <stop offset="0%" stopColor="var(--ff-brand)" />
            <stop offset="50%" stopColor="var(--ff-brand-2)" />
            <stop offset="100%" stopColor="var(--ff-brand-3)" />
          </linearGradient>
          {/* The filter region must be in user space covering the whole gauge.
              As a percentage it is relative to the *path's* bounding box, and a
              short arc has a tiny box — so the glow was being clipped square,
              which is what produced the notch at the start of the progress. */}
          <filter
            id={`glow-${uid}`}
            filterUnits="userSpaceOnUse"
            x={-size * 0.25}
            y={-size * 0.25}
            width={size * 1.5}
            height={size * 1.5}
          >
            <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="var(--ff-brand)" floodOpacity="0.45" />
          </filter>
        </defs>

        <path
          d={arcBetween(cx, cy, radius, GAUGE_START, GAUGE_START + GAUGE_SWEEP)}
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />

        {/* Past the target the whole track turns amber and the overshoot rides
            on top, so the eye reads "past the line" rather than "back at zero". */}
        {over && (
          <path
            d={arcBetween(cx, cy, radius, GAUGE_START, GAUGE_START + GAUGE_SWEEP)}
            fill="none"
            stroke="var(--color-warn)"
            strokeWidth={stroke}
            strokeLinecap="round"
            opacity={0.3}
          />
        )}

        {/* Below this the arc is shorter than its own round cap, which renders
            as a stray dot floating at the start rather than as progress. */}
        {progress > 0.012 && (
          <path
            d={arcBetween(cx, cy, radius, GAUGE_START, GAUGE_START + GAUGE_SWEEP * progress)}
            fill="none"
            stroke={arcColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            filter={`url(#glow-${uid})`}
          />
        )}
      </svg>

      <div className="absolute inset-0 grid place-content-center text-center">
        <div className="text-[34px] font-semibold leading-none tracking-[-0.035em] tnum">{primary}</div>
        <div className="mt-2 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-faint">
          {secondary}
        </div>
      </div>
    </div>
  );
}

/**
 * Macro row: label, value, and a bar. Concentric arcs inside the gauge looked
 * dense but were hard to read at a glance — three nested strokes a few pixels
 * apart do not tell you which is which, and the numbers had to be repeated
 * underneath anyway. A labelled bar says the same thing in one pass.
 */
export function MacroRow({ macro }: { macro: MacroBarDatum }) {
  const ratio = macro.target > 0 ? macro.consumed / macro.target : 0;
  const over = ratio > 1.02;
  const color = over ? 'var(--color-warn)' : MACRO_COLOR[macro.key];
  const width = useAnimatedNumber(Math.min(100, ratio * 100), { duration: 800, epsilon: 0.2 });
  const shown = useAnimatedNumber(macro.consumed, { duration: 700 });

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="flex items-center gap-2">
          <span
            className="size-[7px] rounded-full"
            style={{ background: color, boxShadow: `0 0 8px -1px ${color}` }}
          />
          <span className="text-[13.5px] font-medium">{macro.label}</span>
        </span>
        <span className="text-[13px] tnum">
          <span className="font-semibold">{formatCount(shown)}</span>
          <span className="text-faint"> / {formatCount(macro.target)} g</span>
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        style={{ boxShadow: 'inset 0 1px 2px rgb(0 0 0 / 0.25)' }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${width}%`, background: color, boxShadow: `0 0 8px -1px ${color}` }}
        />
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
      {data.map((item) => (
        <MacroBar key={item.key} item={item} compact={compact} />
      ))}
    </div>
  );
}

function MacroBar({ item, compact }: { item: MacroBarDatum; compact?: boolean }) {
  const ratio = item.target > 0 ? item.consumed / item.target : 0;
  const over = ratio > 1.02;
  const color = over ? 'var(--color-warn)' : MACRO_COLOR[item.key];

  const width = useAnimatedNumber(Math.min(100, ratio * 100), { duration: 800, epsilon: 0.2 });
  const shown = useAnimatedNumber(item.consumed, { duration: 700 });

  return (
    <div className={compact ? '' : 'flex items-center gap-3'}>
      {!compact && <span className="w-16 shrink-0 text-[13px] text-dim">{item.label}</span>}
      <div className={compact ? '' : 'flex-1'}>
        {compact && (
          <div className="mb-2 flex items-center gap-1.5">
            <span className="size-[7px] rounded-full" style={{ background: color, boxShadow: `0 0 8px -1px ${color}` }} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
              {item.label}
            </span>
          </div>
        )}
        {/* An inset track rather than a flat fill: the shadow inside the groove
            is what makes the bar look recessed instead of painted on. */}
        <div
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
          style={{ boxShadow: 'inset 0 1px 2px rgb(0 0 0 / 0.25)' }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${width}%`,
              background: color,
              boxShadow: `0 0 8px -1px ${color}`,
            }}
          />
        </div>
        <div className="mt-2 flex items-baseline gap-1 text-[12.5px] tnum">
          <span className="font-semibold text-text">{formatCount(shown)}</span>
          <span className="text-faint">/ {formatCount(item.target)} g</span>
        </div>
      </div>
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
  return formatCount(value);
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
  scrubLabel,
  unit,
}: {
  series: LineSeries[];
  scatter?: { points: LinePoint[]; color: string };
  height?: number;
  yTicks?: number;
  formatY?: (value: number) => string;
  xLabels?: { x: number; label: string }[];
  className?: string;
  /** Caption for the scrub readout, e.g. a date for the hovered x. */
  scrubLabel?: (x: number) => string;
  unit?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const svgRef = useRef<SVGSVGElement>(null);
  // Drag anywhere on the chart to inspect a specific day. Charts you can
  // interrogate feel like instruments; charts you can only look at feel like
  // pictures.
  const scrub = useScrub(svgRef);
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

  // Snap the scrub position to the nearest real sample on the primary series,
  // so the readout always names an actual day rather than a point between two.
  const primary = series[0]?.points ?? [];
  let hovered: LinePoint | null = null;
  if (scrub !== null && primary.length > 0) {
    const targetX = bounds.minX + scrub * (bounds.maxX - bounds.minX);
    hovered = primary.reduce((best, p) =>
      Math.abs(p.x - targetX) < Math.abs(best.x - targetX) ? p : best,
    );
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className={cx('w-full touch-none select-none', className)}
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

      {hovered && (
        <g pointerEvents="none">
          <line
            x1={sx(hovered.x)}
            x2={sx(hovered.x)}
            y1={padding.top}
            y2={height - padding.bottom}
            stroke="var(--color-border-strong)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={sx(hovered.x)} cy={sy(hovered.y)} r={4} fill={series[0]?.color ?? 'var(--color-brand)'} />
          <circle cx={sx(hovered.x)} cy={sy(hovered.y)} r={7} fill={series[0]?.color ?? 'var(--color-brand)'} opacity={0.25} />

          {/* Readout flips to the other side near the right edge so it never
              runs off the chart. */}
          <g transform={`translate(${sx(hovered.x) + (scrub! > 0.62 ? -84 : 6)}, ${padding.top + 2})`}>
            <rect width={78} height={scrubLabel ? 32 : 19} rx={6} fill="var(--color-surface-3)" opacity={0.96} />
            <text x={7} y={13} fontSize={11} fontWeight={600} fill="var(--color-text)">
              {formatY(hovered.y)}
              {unit ? ` ${unit}` : ''}
            </text>
            {scrubLabel && (
              <text x={7} y={26} fontSize={9} fill="var(--color-faint)">
                {scrubLabel(hovered.x)}
              </text>
            )}
          </g>
        </g>
      )}
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
            {formatCount(target)}
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
            title={`${bar.label}: ${formatCount(bar.value)}`}
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
    // Explicit flex sizing: inside a flex row the intrinsic width attribute is
    // only a hint, and the sparkline stretches into whatever space is going.
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 opacity-70"
      style={{ width, height }}
      aria-hidden="true"
    >
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
