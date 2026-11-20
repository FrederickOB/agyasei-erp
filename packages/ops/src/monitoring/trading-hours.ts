/**
 * Trading time, in a location's own timezone.
 *
 * §9.4: a device that is silent is only alarming while its outlet is trading.
 * "No sale since Saturday 18:00" is normal at 07:30 on Monday and alarming at
 * 15:00. So darkness is measured in TRADING time elapsed since the last
 * accepted write, not wall-clock time.
 *
 * The window is a platform DEFAULT from configuration, applied to every
 * location in its own `app.location.timezone`. It is an interim stand-in for
 * §9.4's per-location `app.location_sync_expectation` (tenant-owned trading
 * days and hours), which does not exist yet. Nothing here knows a country.
 */

export interface TradingWindow {
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  readonly days: readonly number[];
  /** Minutes after local midnight. */
  readonly openMinute: number;
  readonly closeMinute: number;
}

function hhmm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`expected HH:MM, got ${JSON.stringify(s)}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`not a time of day: ${s}`);
  return h * 60 + min;
}

/** `days` as '1-6' or '1,2,3,4,5'; times as 'HH:MM'. */
export function parseTradingWindow(days: string, open: string, close: string): TradingWindow {
  const set = new Set<number>();
  for (const part of days.split(',').map((p) => p.trim()).filter(Boolean)) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      for (let d = Number(range[1]); d <= Number(range[2]); d += 1) set.add(d);
    } else if (/^\d$/.test(part)) {
      set.add(Number(part));
    } else {
      throw new Error(`bad trading day spec ${JSON.stringify(part)}`);
    }
  }
  for (const d of set) if (d < 1 || d > 7) throw new Error(`ISO weekday out of range: ${d}`);
  const w = { days: [...set].sort(), openMinute: hhmm(open), closeMinute: hhmm(close) };
  if (w.closeMinute <= w.openMinute) throw new Error('trading close must be after open (overnight windows are not supported)');
  return w;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

const ISO_DAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** A valid IANA zone name, or the fallback. Never throws on tenant data. */
export function safeTimezone(tz: string | null | undefined, fallback = 'UTC'): string {
  if (!tz) return fallback;
  try {
    formatter(tz);
    return tz;
  } catch {
    return fallback;
  }
}

export function isTrading(at: Date, tz: string, w: TradingWindow): boolean {
  const parts = formatter(tz).formatToParts(at);
  const day = ISO_DAY[parts.find((p) => p.type === 'weekday')?.value ?? ''] ?? 0;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 'NaN');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 'NaN');
  const m = hour * 60 + minute;
  return w.days.includes(day) && m >= w.openMinute && m < w.closeMinute;
}

const STEP_MS = 5 * 60_000;

/**
 * Trading milliseconds in [from, to], at 5-minute resolution, walking back
 * from `to`. Stops early once `capMs` is exceeded — callers only ever need to
 * know "more than the threshold".
 */
export function tradingMsBetween(from: Date, to: Date, tz: string, w: TradingWindow, capMs = Infinity): number {
  let acc = 0;
  for (let t = to.getTime() - STEP_MS; t >= from.getTime(); t -= STEP_MS) {
    if (isTrading(new Date(t), tz, w)) {
      acc += STEP_MS;
      if (acc > capMs) return acc;
    }
  }
  return acc;
}
