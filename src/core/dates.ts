/**
 * Date handling.
 *
 * A diary day is identified by a local-calendar key `YYYY-MM-DD`. Never use a
 * UTC timestamp for this: a meal logged at 22:00 in UTC+13 belongs to that
 * user's day, not to the previous UTC day. Everything user-facing keys off
 * `DayKey`; timestamps are only kept for ordering and merge resolution.
 */

export type DayKey = string & { readonly __brand?: 'DayKey' };

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

export function toDayKey(date: Date = new Date()): DayKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fromDayKey(key: DayKey): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function addDays(key: DayKey, days: number): DayKey {
  const date = fromDayKey(key);
  date.setDate(date.getDate() + days);
  return toDayKey(date);
}

export function daysBetween(a: DayKey, b: DayKey): number {
  // Compare at noon so a DST transition between the two dates cannot shift the
  // difference by a fraction of a day and round the wrong way.
  const da = fromDayKey(a);
  const db = fromDayKey(b);
  da.setHours(12, 0, 0, 0);
  db.setHours(12, 0, 0, 0);
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export function isToday(key: DayKey): boolean {
  return key === toDayKey();
}

/** Inclusive range of day keys, oldest first. */
export function dayRange(from: DayKey, to: DayKey): DayKey[] {
  const out: DayKey[] = [];
  const total = daysBetween(from, to);
  for (let i = 0; i <= total; i++) out.push(addDays(from, i));
  return out;
}

/** The last `count` days ending at `end` (inclusive), oldest first. */
export function lastNDays(count: number, end: DayKey = toDayKey()): DayKey[] {
  return dayRange(addDays(end, -(count - 1)), end);
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "Today" / "Yesterday" / "Mon 4 Aug" — the header format used across screens. */
export function formatDayLabel(key: DayKey, today: DayKey = toDayKey()): string {
  const delta = daysBetween(today, key);
  if (delta === 0) return 'Today';
  if (delta === -1) return 'Yesterday';
  if (delta === 1) return 'Tomorrow';
  const date = fromDayKey(key);
  const weekday = WEEKDAY[date.getDay()];
  const month = date.toLocaleDateString(undefined, { month: 'short' });
  const includeYear = Math.abs(delta) > 300;
  return `${weekday} ${date.getDate()} ${month}${includeYear ? ` ${date.getFullYear()}` : ''}`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Duration in ms rendered as `H:MM:SS` — used by the fasting timer. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${pad(m)}:${pad(s)}`;
}

/** ISO week key `YYYY-Www`, used to group weekly check-ins. */
export function toWeekKey(key: DayKey): string {
  const date = fromDayKey(key);
  date.setHours(0, 0, 0, 0);
  // Shift to the Thursday of the current ISO week, then count weeks from Jan 4.
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  const weekNo =
    1 +
    Math.round(
      ((date.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getDay() + 6) % 7)) / 7,
    );
  return `${date.getFullYear()}-W${pad(weekNo)}`;
}
