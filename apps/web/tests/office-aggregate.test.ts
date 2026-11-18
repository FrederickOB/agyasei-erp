/**
 * The office's client-side arithmetic — money category (CLAUDE.md §2.7):
 * week buckets must sum exactly to the range, weekday averages round
 * explicitly, and a comparison against nothing is `null`, never a percentage.
 */
import { describe, expect, it } from 'vitest';
import {
  averageBasket,
  byWeek,
  byWeekday,
  changeBp,
  formatChangeBp,
  inclusiveDays,
  previousRange,
  shiftYmd,
  toCsv,
  topN,
  weekdayIndex,
  type DayFigures,
} from '../src/features/office/aggregate';

function day(date: string, net: bigint, sales = 1n): DayFigures {
  return { date, netRevenueMinor: net, saleCount: sales, totalMinor: net + net / 10n };
}

describe('dates', () => {
  it('shifts by whole days without a timezone', () => {
    expect(shiftYmd('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftYmd('2027-02-28', 1)).toBe('2027-03-01');
    expect(inclusiveDays('2027-01-01', '2027-01-01')).toBe(1);
    expect(inclusiveDays('2027-01-01', '2027-01-28')).toBe(28);
  });
  it('the previous range is the same length, ending the day before', () => {
    expect(previousRange('2027-01-04', '2027-01-31')).toEqual({ from: '2026-12-07', to: '2027-01-03' });
    expect(previousRange('2027-01-10', '2027-01-10')).toEqual({ from: '2027-01-09', to: '2027-01-09' });
  });
  it('weekday index is Monday-first', () => {
    expect(weekdayIndex('2027-01-04')).toBe(0); // a Monday
    expect(weekdayIndex('2027-01-03')).toBe(6); // a Sunday
  });
});

describe('byWeek', () => {
  it('buckets by Monday and the buckets sum exactly to the range', () => {
    // Fri 1 Jan 2027 … Thu 14 Jan: three partial/complete weeks.
    const series: DayFigures[] = [];
    for (let i = 0; i < 14; i += 1) series.push(day(shiftYmd('2027-01-01', i), BigInt(1000 + i), 2n));
    const weeks = byWeek(series);
    expect(weeks.map((w) => w.weekOf)).toEqual(['2026-12-28', '2027-01-04', '2027-01-11']);
    expect(weeks.map((w) => w.days)).toEqual([3, 7, 4]);
    expect(weeks.map((w) => w.complete)).toEqual([false, true, false]);
    const sum = weeks.reduce((s, w) => s + w.netRevenueMinor, 0n);
    expect(sum).toBe(series.reduce((s, d) => s + d.netRevenueMinor, 0n));
    expect(weeks.reduce((s, w) => s + w.saleCount, 0n)).toBe(28n);
  });
});

describe('byWeekday', () => {
  it('averages over the calendar days of that weekday, closed days included, rounding half-up', () => {
    const series = [
      day('2027-01-04', 100n), // Mon
      day('2027-01-11', 101n), // Mon
      day('2027-01-18', 0n), // Mon, closed
      day('2027-01-05', 7n), // Tue
    ];
    const w = byWeekday(series);
    expect(w[0]!.label).toBe('Mon');
    expect(w[0]!.days).toBe(3);
    expect(w[0]!.netRevenueMinor).toBe(201n);
    expect(w[0]!.averageMinor).toBe(67n); // 201 / 3 = 67
    expect(w[1]!.averageMinor).toBe(7n);
    expect(w[6]!.days).toBe(0);
    expect(w[6]!.averageMinor).toBe(0n);
  });
});

describe('comparisons', () => {
  it('is basis points against the previous figure, and null against nothing', () => {
    expect(changeBp(1_100n, 1_000n)).toBe(1_000);
    expect(changeBp(900n, 1_000n)).toBe(-1_000);
    expect(changeBp(5n, 0n)).toBeNull();
    expect(formatChangeBp(1_000)).toBe('+10.0%');
    expect(formatChangeBp(-250)).toBe('−2.5%');
    expect(formatChangeBp(0)).toBe('0.0%');
  });
  it('average basket is null when nothing was sold', () => {
    expect(averageBasket(1_000n, 0n)).toBeNull();
    expect(averageBasket(1_001n, 2n)).toBe(501n); // half-up
  });
  it('topN keeps the largest and folds the rest', () => {
    const r = topN([{ v: 1n }, { v: 9n }, { v: 5n }, { v: 3n }], 2, (x) => x.v);
    expect(r.top.map((x) => x.v)).toEqual([9n, 5n]);
    expect(r.otherMinor).toBe(4n);
    expect(r.otherCount).toBe(2);
  });
});

describe('toCsv', () => {
  it('quotes what needs quoting and writes bigint as digits', () => {
    const csv = toCsv(['a', 'b'], [['plain', 12n], ['has, comma', 'say "hi"'], [null, 'line\nbreak']]);
    expect(csv).toBe('a,b\r\nplain,12\r\n"has, comma","say ""hi"""\r\n,"line\nbreak"\r\n');
  });
});
