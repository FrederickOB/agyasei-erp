/**
 * The trading day a sale belongs to (03-offline-sync §3.4.2; CLAUDE.md §2.5).
 *
 * `businessDate` is not a formatting detail. The server reprices the sale from
 * the price list in force on that date and computes tax from the
 * effective-dated rate row in force on that date — a historical transaction
 * always reprices against the rate row in effect on its transaction date. Get
 * it wrong by a day across a rate change and the receipt and the ledger
 * disagree.
 *
 * The device derives it from the sale's own instant in the LOCATION's
 * timezone, which is synced tenant data (`location.timezone`), never a
 * platform constant and never the tablet's own locale — a tablet that has
 * wandered onto the wrong timezone must not silently move the trading day.
 *
 * Honest about what this is NOT: §3.4.2 makes `business_date` a human-asserted
 * value constrained by an open cash session, and `app.cash_session` does not
 * exist yet (migration 0004 defers it). Until it does, the derived value is
 * the device's best assertion, and `checkout()` takes an explicit override so
 * the day-open control can supply the asserted one without touching this file.
 */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export class BusinessDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessDateError';
  }
}

function utcYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The calendar date of `iso` as observed at `timeZone` (an IANA zone id from
 * the synced location row). A null or unusable zone falls back to UTC — the
 * counter never stops trading over a configuration gap, and the fallback is
 * deterministic rather than dependent on the tablet's own settings.
 */
export function businessDateFor(iso: string, timeZone: string | null): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new BusinessDateError(`unparseable instant for a business date: ${iso}`);
  }
  if (timeZone === null || timeZone.length === 0) return utcYmd(ms);

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
  } catch {
    return utcYmd(ms);
  }

  const find = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const ymd = `${find('year').padStart(4, '0')}-${find('month')}-${find('day')}`;
  // Assembled from parts rather than trusting a locale pattern; if the
  // assembly is not a plain calendar date, UTC is the safe, stated answer.
  return YMD_RE.test(ymd) ? ymd : utcYmd(ms);
}

/** Shape guard for a business date supplied from outside (a day-open control). */
export function assertBusinessDate(value: string): string {
  if (!YMD_RE.test(value)) {
    throw new BusinessDateError(`business date must be YYYY-MM-DD, got: ${value}`);
  }
  return value;
}
