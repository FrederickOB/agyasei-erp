/**
 * Device setup, part three: WHAT THIS TILL PRICES IN.
 *
 * THE THIRD DEAD ENTRY POINT. `writeCurrencySpec` (data/queries/config.ts) was
 * exported and called from nowhere in `src` — found by the same audit that
 * found `writeActivePriceListId`. The only thing that ever wrote a
 * `CurrencySpec` was the dev seed, and the seed writes a DELIBERATE
 * PLACEHOLDER: the ISO test code `XTS` and the generic currency sign
 * (data/seed.ts, §8.9 — the glyph itself is not repeated here, because the
 * §8.9 conformance test bans it from every file but that one). So a real
 * device — synced, trading, printing receipts — would have shown the
 * placeholder glyph to a customer forever, because the code that replaces it
 * with the tenant's own currency was written and never wired.
 *
 * WHERE THE ANSWER COMES FROM. The jurisdiction pack, over the sync stream:
 * the `jurisdiction` row the `jurisdiction_pack` bucket streams for this
 * tenant (infra/powersync/sync_rules.yaml), carrying `currency_code`,
 * `currency_symbol` and `minor_units_per_major`. That row IS the pack
 * (ADR-0007). Nothing here knows a currency, a symbol, or a scale — CLAUDE.md
 * §2.3 is explicit that 100 minor units to the major unit is never assumed,
 * and `minor_units_per_major` is read, not guessed.
 *
 * WHY THIS ONE NEVER CLEARS. Unlike the location and the price list, a wrong
 * currency does not get a sale refused by the server — the wire carries minor
 * units and a decimal string, never a symbol. Blocking a working till over a
 * pack row that has not arrived would take a counter down for a presentation
 * problem. So this reconciler is strictly additive: it upgrades a placeholder
 * to the tenant's real pack the moment the row lands, and otherwise leaves
 * whatever the device has. The residual — a device that never receives its
 * pack shows the placeholder sign — is recorded as a gap, not hidden.
 */
import { assertCurrencySpec, type CurrencySpec } from '@erp/money';
import type { DbExecutor, LocalDb } from '../db';
import { readCurrencySpec, writeCurrencySpec } from '../queries/config';

export type CurrencySpecStatus =
  /** No session: the dev seed's placeholder stands (§8.1). */
  | 'local-only'
  /** The stored spec already matches the pack this device holds. */
  | 'confirmed'
  /** The pack arrived and this device had no spec. Written. */
  | 'provisioned'
  /** The placeholder (or an older pack) was replaced by the current one. */
  | 'reconciled'
  /** No jurisdiction row on this device yet. Whatever is stored is left alone. */
  | 'pack-absent'
  /** A pack row this device cannot turn into a spec. Reported, never guessed. */
  | 'pack-unreadable';

export interface CurrencySpecState {
  readonly status: CurrencySpecStatus;
  readonly spec: CurrencySpec | null;
  /** One sentence naming what is wrong, or `null`. Never blocks the counter. */
  readonly message: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Minor-unit DIGITS from minor units per major unit: 100 → 2, 1000 → 3, 1 → 0.
 * A pack that is not an exact power of ten has no digit count, and inventing
 * one would silently misplace a decimal point on every receipt — so it is
 * refused instead. (`scale` is a digit count, not a monetary magnitude, which
 * is why it is a `number`; the amounts themselves never are — ADR-0004.)
 */
function scaleFromMinorUnits(minorUnitsPerMajor: unknown): 0 | 1 | 2 | 3 | 4 | null {
  const raw =
    typeof minorUnitsPerMajor === 'number'
      ? minorUnitsPerMajor
      : typeof minorUnitsPerMajor === 'string'
        ? Number(minorUnitsPerMajor)
        : typeof minorUnitsPerMajor === 'bigint'
          ? Number(minorUnitsPerMajor)
          : Number.NaN;
  if (!Number.isInteger(raw) || raw < 1) return null;
  for (const digits of [0, 1, 2, 3, 4] as const) {
    if (raw === 10 ** digits) return digits;
  }
  return null;
}

/** The jurisdiction pack's currency, as this device currently holds it. */
export async function readPackCurrencySpec(db: DbExecutor): Promise<CurrencySpec | null> {
  const rows = await db.getAll(
    `SELECT currency_code, currency_symbol, minor_units_per_major FROM jurisdiction`,
  );
  // One tenant, one jurisdiction (CLAUDE.md §2.5). More than one row means the
  // device is holding something nobody designed for; refusing beats picking.
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (row === undefined) return null;
  const code = text(row['currency_code']);
  const symbol = text(row['currency_symbol']);
  const scale = scaleFromMinorUnits(row['minor_units_per_major']);
  if (code === null || symbol === null || scale === null) return null;
  const spec: CurrencySpec = { code, symbol, scale };
  assertCurrencySpec(spec);
  return spec;
}

function same(a: CurrencySpec | null, b: CurrencySpec): boolean {
  return a !== null && a.code === b.code && a.symbol === b.symbol && a.scale === b.scale;
}

export async function reconcileCurrencySpec(
  db: LocalDb,
  hasSession: boolean,
): Promise<CurrencySpecState> {
  let stored: CurrencySpec | null = null;
  try {
    stored = await readCurrencySpec(db);
  } catch {
    // A stored value that is not a spec at all. Treated as absent so the pack
    // can replace it, rather than throwing on the startup path.
    stored = null;
  }

  if (!hasSession) return { status: 'local-only', spec: stored, message: null };

  const rows = await db.getAll(`SELECT code FROM jurisdiction`);
  if (rows.length === 0) {
    return { status: 'pack-absent', spec: stored, message: null };
  }

  const pack = await readPackCurrencySpec(db);
  if (pack === null) {
    return {
      status: 'pack-unreadable',
      spec: stored,
      message:
        'This device cannot read the currency out of its organisation’s jurisdiction ' +
        'settings, so amounts are still shown in placeholder units.',
    };
  }

  if (same(stored, pack)) return { status: 'confirmed', spec: pack, message: null };

  await writeCurrencySpec(db, pack);
  return { status: stored === null ? 'provisioned' : 'reconciled', spec: pack, message: null };
}
