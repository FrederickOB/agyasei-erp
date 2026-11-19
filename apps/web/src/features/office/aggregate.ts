/**
 * Client-side aggregation for the office — the arithmetic behind the derived
 * charts (week on week, by weekday, average basket, previous-period deltas)
 * and the CSV a manager downloads.
 *
 * Everything money is `bigint` (ADR-0004). Sums are exact. The only divisions
 * are explicit `divRound(…, 'half-up')` averages, and a ratio in basis points
 * that is a `number` because it is a share, never a figure. Dates are
 * `YYYY-MM-DD` business dates and never touch the device's timezone: every
 * calculation goes through `Date.UTC`.
 */
import { divRound } from '@erp/money';

export interface DayFigures {
  readonly date: string;
  readonly netRevenueMinor: bigint;
  readonly saleCount: bigint;
  readonly totalMinor: bigint;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function utc(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00Z`);
}

export function shiftYmd(ymd: string, days: number): string {
  return new Date(utc(ymd) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `2027-01-26` → `26 Jan`. Product copy; no locale table. */
export function shortDay(ymd: string): string {
  const d = new Date(utc(ymd));
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ''}`;
}

/** Inclusive days in a range. A one-day range is 1. */
export function inclusiveDays(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS) + 1;
}

/** The range of the same length that ends the day before `from`. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const days = inclusiveDays(from, to);
  const prevTo = shiftYmd(from, -1);
  return { from: shiftYmd(prevTo, -(days - 1)), to: prevTo };
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(ymd: string): number {
  return (new Date(utc(ymd)).getUTCDay() + 6) % 7;
}

export interface WeekdayFigures {
  readonly label: (typeof WEEKDAYS)[number];
  readonly days: number;
  readonly netRevenueMinor: bigint;
  /** Average per calendar day of that weekday in the range — a closed day counts. */
  readonly averageMinor: bigint;
}

/** Which days carry the week: totals and averages per weekday, Monday first. */
export function byWeekday(series: readonly DayFigures[]): readonly WeekdayFigures[] {
  const totals: bigint[] = [0n, 0n, 0n, 0n, 0n, 0n, 0n];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of series) {
    const i = weekdayIndex(d.date);
    totals[i] = (totals[i] ?? 0n) + d.netRevenueMinor;
    counts[i] = (counts[i] ?? 0) + 1;
  }
  return WEEKDAYS.map((label, i) => ({
    label,
    days: counts[i] ?? 0,
    netRevenueMinor: totals[i] ?? 0n,
    averageMinor: (counts[i] ?? 0) === 0 ? 0n : divRound(totals[i] ?? 0n, BigInt(counts[i] ?? 1), 'half-up'),
  }));
}

export interface WeekFigures {
  /** Monday of the week, `YYYY-MM-DD`. */
  readonly weekOf: string;
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly netRevenueMinor: bigint;
  readonly saleCount: bigint;
  /** True when the range covers all seven days of this week. */
  readonly complete: boolean;
}

/** Week on week: buckets by the Monday each day belongs to, in order. */
export function byWeek(series: readonly DayFigures[]): readonly WeekFigures[] {
  const buckets = new Map<string, { from: string; to: string; days: number; net: bigint; count: bigint }>();
  for (const d of series) {
    const monday = shiftYmd(d.date, -weekdayIndex(d.date));
    const b = buckets.get(monday);
    if (b === undefined) {
      buckets.set(monday, { from: d.date, to: d.date, days: 1, net: d.netRevenueMinor, count: d.saleCount });
    } else {
      b.to = d.date;
      b.days += 1;
      b.net += d.netRevenueMinor;
      b.count += d.saleCount;
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekOf, b]) => ({
      weekOf,
      from: b.from,
      to: b.to,
      days: b.days,
      netRevenueMinor: b.net,
      saleCount: b.count,
      complete: b.days === 7,
    }));
}

/**
 * Change from `previous` to `current`, in basis points: +1 000 is +10.0%.
 * `null` when there is nothing to compare against — a rise from zero is not
 * a percentage, and must not be drawn as one.
 */
export function changeBp(current: bigint, previous: bigint): number | null {
  if (previous <= 0n) return null;
  return Number(((current - previous) * 10_000n) / previous); // lint-money-ignore: a share, not a figure
}

/** `+12.3%` / `−4.0%` for a change in basis points. */
export function formatChangeBp(bp: number): string {
  const sign = bp > 0 ? '+' : bp < 0 ? '−' : '';
  return `${sign}${(Math.abs(bp) / 100).toFixed(1)}%`;
}

/** Average basket: net revenue per sale, or null when nothing was sold. */
export function averageBasket(netRevenueMinor: bigint, saleCount: bigint): bigint | null {
  if (saleCount <= 0n) return null;
  return divRound(netRevenueMinor, saleCount, 'half-up');
}

/** The largest `n` by `value`, and everything else folded into one remainder. */
export function topN<T>(
  rows: readonly T[],
  n: number,
  value: (row: T) => bigint,
): { readonly top: readonly T[]; readonly otherMinor: bigint; readonly otherCount: number } {
  const sorted = [...rows].sort((a, b) => (value(a) === value(b) ? 0 : value(a) > value(b) ? -1 : 1));
  const top = sorted.slice(0, n);
  const rest = sorted.slice(n);
  return { top, otherMinor: rest.reduce((s, r) => s + value(r), 0n), otherCount: rest.length };
}

// ---------------------------------------------------------------------------
// CSV — what a manager actually opens
// ---------------------------------------------------------------------------

export type CsvCell = string | number | bigint | null;

function csvField(cell: CsvCell): string {
  if (cell === null) return '';
  const text = typeof cell === 'bigint' ? cell.toString(10) : String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 rows with a header. Money cells are the caller's formatted strings. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Hand the browser a file. Nothing here runs on the server or in a test. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
