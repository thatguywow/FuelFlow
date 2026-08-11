/**
 * Number formatting.
 *
 * Deliberately *not* `toLocaleString()` for the headline figures. In many
 * European locales that renders 1835 as "1.835", which is correct for the
 * locale but reads as a decimal to half the world and sits badly next to an
 * ungrouped "660" in the same row. Calorie and macro values are at most four
 * digits, where grouping buys nothing, so they are simply left ungrouped.
 * Grouping only appears above five figures, where it genuinely aids reading.
 */

const GROUPING_THRESHOLD = 10_000;

/** Headline integers: calories, grams, counts. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const abs = Math.abs(rounded);
  if (abs < GROUPING_THRESHOLD) return String(rounded);
  // A narrow no-break space is unambiguous in every locale, unlike "." or ",".
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Signed variant, for deltas where the direction is the point. */
export function formatDelta(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${formatCount(Math.abs(rounded))}`;
}

/** Decimals that trim trailing zeros: 82.50 → "82.5", 3.00 → "3". */
export function formatDecimal(value: number, places = 1): string {
  if (!Number.isFinite(value)) return '—';
  return value
    .toFixed(places)
    .replace(/\.?0+$/, '')
    .replace(/^-0$/, '0');
}
