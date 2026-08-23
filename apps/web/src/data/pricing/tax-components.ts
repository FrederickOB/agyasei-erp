/**
 * The device's own copy of the jurisdiction pack's tax composition, read from
 * the synced `tax_rate` rows and turned into `@erp/money`'s `TaxComponent`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE COUNTER NEEDS THIS AT ALL.
 * ═══════════════════════════════════════════════════════════════════════════
 * A tax-INCLUSIVE price list quotes what the customer hands over. Splitting
 * that shelf price back into a net and its component amounts is not one
 * division — it inverts whatever composition the pack declares (`base_kind`,
 * `base_includes`, `rounding_level`, `rounding_mode`; 07 §7.2.4), and two
 * regimes of the SAME jurisdiction can differ only in that composition with no
 * rate changing at all. So the components are DATA, read here, never a
 * constant and never a branch on a jurisdiction (ADR-0002, ADR-0007).
 *
 * They already reach the device: `sync_rules.yaml`'s `jurisdiction_pack`
 * bucket streams `platform.tax_rate` for the tenant's jurisdiction, keyed
 * server-side from the token. A device therefore holds exactly one pack, which
 * is why nothing here filters by jurisdiction — asking "which jurisdiction?"
 * on the client would be the client asserting a boundary the sync rules own.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ORDER IS THE SERVER'S ORDER, DELIBERATELY.
 * ═══════════════════════════════════════════════════════════════════════════
 * `apps/api/src/tax.ts` sorts components so every `net` component computes
 * before any `net_plus` one that folds it into its base, tie-broken by code.
 * This mirrors that sort exactly. A different order is a different set of
 * rounded amounts, and the whole value of the client's figure is that it
 * agrees with the figure the server will write.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENS WHEN THE ROWS ARE ABSENT OR UNUSABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 * This returns an EMPTY set and a stated `problem`, and never throws at a
 * till. It does not mean "no tax": it means this device cannot state the
 * split, so the counter shows what the list's own convention says the customer
 * pays and the breakdown is reported as unavailable (see `cart-pricing.ts`).
 * The server remains the pricing authority in both directions and any
 * disagreement is surfaced by `clientTotalMinor`, never swallowed.
 */
import type { RoundingMode, TaxComponent } from '@erp/money';
import type { DbExecutor } from '../db';

/** The pack's `rounding_mode` vocabulary, as the column stores it. */
const MODES: Readonly<Record<string, RoundingMode>> = {
  half_up: 'half-up',
  half_even: 'half-even',
  down: 'down',
};

export interface TaxComponentSet {
  /** In the server's evaluation order. Empty when the pack cannot be read. */
  readonly components: readonly TaxComponent[];
  /**
   * Why the set is empty, in words a support call can use — `null` when the
   * set was read cleanly (including a clean read of no rows at all, which is
   * a device still receiving its pack rather than a fault).
   */
  readonly problem: string | null;
}

const EMPTY: TaxComponentSet = { components: [], problem: null };

/**
 * `base_includes` arrives as text. Three encodings are accepted because the
 * column crosses a wire this module does not own: a JSON array, a Postgres
 * array literal (`{A,B}`), and a bare comma-separated list. Anything else
 * yields no members, which — per §7.2.4's rule that an absent member simply
 * contributes nothing — is the fail-quiet direction only for a `net` component
 * and is caught by the `net_plus` validity check below.
 */
export function parseBaseIncludes(raw: unknown): readonly string[] {
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (text.length === 0 || text === '{}' || text === '[]') return [];
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
    } catch {
      return [];
    }
  }
  const inner = text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : text;
  return inner
    .split(',')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .filter((part) => part.length > 0);
}

/**
 * Is a serialized range in force on a business date?
 *
 * The column carries the pack's `effective` daterange verbatim — `[from,to)`
 * with an optional unbounded upper. Bounds are compared as calendar dates:
 * a lexicographic compare on a zero-padded date IS a chronological compare,
 * the same reasoning `device-price-list.ts` states for price-list windows, and
 * the same half-open `[from, to)` the pack itself uses so the off-by-one-day
 * argument cannot come back.
 *
 * An unparseable range is NOT in force. A row whose window cannot be read is a
 * row whose applicability is unknown, and applying it anyway would price
 * against a rate nobody can date.
 */
export function rangeCoversDate(raw: unknown, businessDate: string): boolean {
  if (typeof raw !== 'string') return false;
  const text = raw.trim();
  const match = /^([[(])([^,]*),([^)\]]*)([)\]])$/.exec(text);
  if (match === null) return false;
  const [, lowerBound, lowerRaw, upperRaw, upperBound] = match;
  const lower = (lowerRaw ?? '').trim().replace(/^"(.*)"$/, '$1').slice(0, 10);
  const upper = (upperRaw ?? '').trim().replace(/^"(.*)"$/, '$1').slice(0, 10);
  const day = businessDate.slice(0, 10);
  if (lower.length > 0) {
    if (lowerBound === '[' ? day < lower : day <= lower) return false;
  }
  if (upper.length > 0) {
    if (upperBound === ']' ? day > upper : day >= upper) return false;
  }
  return true;
}

interface Draft {
  readonly component: TaxComponent;
  readonly code: string;
}

/**
 * Every component in force on `businessDate`, in the server's order.
 *
 * @param businessDate the trading day the sale reprices and taxes against —
 *        never "today", which is a different day at a counter working past
 *        midnight and the reason 07 §7.2.4 dates every lookup.
 */
export async function readTaxComponentsInForce(
  db: DbExecutor,
  businessDate: string,
): Promise<TaxComponentSet> {
  let rows;
  try {
    rows = await db.getAll(
      `SELECT tax_code, CAST(rate_bp AS TEXT) AS rate_bp, base_kind, base_includes,
              rounding_level, rounding_mode, effective
         FROM tax_rate`,
    );
  } catch {
    // The table is part of the synced schema; a device whose local schema has
    // not caught up must still be able to ring a sale.
    return { components: [], problem: 'This device has no tax table yet.' };
  }

  const drafts: Draft[] = [];
  for (const row of rows) {
    if (!rangeCoversDate(row['effective'], businessDate)) continue;
    const code = row['tax_code'];
    const baseKind = row['base_kind'];
    const level = row['rounding_level'];
    const mode = MODES[String(row['rounding_mode'])];
    if (typeof code !== 'string' || code.length === 0) {
      return { components: [], problem: 'A tax rate on this device has no code.' };
    }
    if (baseKind !== 'net' && baseKind !== 'net_plus') {
      return { components: [], problem: `Tax rate ${code} has a base this app does not know.` };
    }
    if (level !== 'line' && level !== 'document') {
      return { components: [], problem: `Tax rate ${code} rounds in a way this app does not know.` };
    }
    if (mode === undefined) {
      return { components: [], problem: `Tax rate ${code} rounds in a way this app does not know.` };
    }
    let rateBp: bigint;
    try {
      // TEXT -> bigint, once, here. A rate is basis points, never a float.
      rateBp = BigInt(String(row['rate_bp']));
    } catch {
      return { components: [], problem: `Tax rate ${code} has an unreadable rate.` };
    }
    drafts.push({
      code,
      component: {
        code,
        rateBp,
        baseKind,
        baseIncludes: baseKind === 'net_plus' ? parseBaseIncludes(row['base_includes']) : [],
        roundingLevel: level,
        roundingMode: mode,
      },
    });
  }

  if (drafts.length === 0) return EMPTY;

  // The server's sort, mirrored: `net` before `net_plus`, then by code. It is
  // also what makes `base_includes` name only EARLIER codes, which @erp/money
  // requires and which 07 §7.2.4 asserts at publish time.
  drafts.sort((a, b) => {
    if (a.component.baseKind !== b.component.baseKind) {
      return a.component.baseKind === 'net' ? -1 : 1;
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  return { components: drafts.map((d) => d.component), problem: null };
}
