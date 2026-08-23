/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CREDIT POSITION THIS DEVICE ALREADY HOLDS — and what it may say about it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `data/api/credit.ts` is the ONLINE path and stays exactly as honest as it
 * was: it caches nothing, and a failed refresh discards the previous answer.
 * This module is the other half — the `tenant_credit` sync bucket
 * (`infra/powersync/sync_rules.yaml`, migration 0013) puts a bounded, gated,
 * SERVER-DERIVED position on the device, so a partitioned accounts device can
 * now answer "what does this customer owe" with a real figure and a date on it
 * instead of only "not available".
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE COMPUTES A CREDIT BALANCE OR AN AGEING BUCKET. EVER.
 * ---------------------------------------------------------------------------
 * That is arithmetic, not preference (`docs/credit-offline-plan.md` R2). The
 * entry log on this device is WINDOWED, so
 *
 *     Σ(local credit_entry rows)  ≠  balance          — by construction
 *
 * and the gap grows with the age of the account. A device that summed its own
 * log would produce a confidently wrong number at exactly the moment nobody
 * can check it. So:
 *
 *   · `balance_minor` is SYNCED and authoritative;
 *   · the ageing vector is SYNCED, rendered server-side against the tenant's
 *     own band edges — which are policy, and policy is not on this device;
 *   · `credit_entry` rows are a STATEMENT LISTING. Displayed, never totalled.
 *
 * There is deliberately no exported function in this module (or anywhere in
 * `apps/web`) that reduces credit entry amounts to a total, and
 * `tests/credit-no-local-total.test.ts` fails if one appears.
 *
 * ---------------------------------------------------------------------------
 * THE ONE ARITHMETIC THAT IS DONE HERE, AND WHY IT IS THE SHARED ONE
 * ---------------------------------------------------------------------------
 * `checkAgreement` — the SAME function `data/api/credit.ts` runs against the
 * server's own online answer — is run against the synced snapshot:
 *
 *     balance = Σ(buckets) − on-account credit + fee outstanding
 *
 * If the server's projection ever drifted from the server's ageing route, this
 * renders as *"these do not add up"* rather than as a headline with a
 * breakdown under it that disagrees. One implementation of the identity, used
 * on both paths, so the two cannot diverge without saying so.
 *
 * ---------------------------------------------------------------------------
 * WHEN THE DEVICE HOLDS ENTRIES THE SNAPSHOT DOES NOT: SHOWN, NOT FOLDED IN
 * ---------------------------------------------------------------------------
 * `as_of_hlc` is the server HLC the position was evaluated through. An entry
 * on this device whose (server-stamped) `hlc` is greater than that is a
 * movement the snapshot does not include. It is LISTED — *"2 movements
 * recorded since, not yet included"* — and never added to the balance. Two
 * server-generated HLCs are compared; a device clock is never compared against
 * a server one. This is the D6/D9 precedent one layer up: the till's claimed
 * `clientTotalMinor: "1"` lost to the server's 618,000, and a device-adjusted
 * balance is the same kind of claim.
 */
import type { MinorUnits } from '@erp/money';
import {
  checkAgreement,
  type AgeingBucket,
  type CreditAgeing,
  type CreditExposure,
  type PositionAgreement,
} from '../api/credit';
import type { DbExecutor } from '../db';

// ---------------------------------------------------------------------------
// Provenance — three states, never four (credit-offline-plan R3)
// ---------------------------------------------------------------------------

/**
 * How current a credit figure is. There are exactly three states and there is
 * NO "last known":
 *
 *  · `verified_online` — this interaction round-tripped to the server. It is
 *    produced by `data/api/credit.ts` and never by this module.
 *  · `synced_as_of`    — from a synced snapshot, with its age stated in the
 *    same sentence as the number.
 *  · `unavailable`     — no snapshot at all. The screen says so and shows no
 *    figure, no zero and no empty table.
 *
 * The types enforce the separation that R3 states in prose: a
 * `SyncedCreditPosition` is NOT a `CreditPosition`, so it cannot be passed to
 * a component that renders a verified figure. "Never rendered in the place a
 * verified figure uses" is a compile error here, not a review note.
 */
export type CreditProvenance = 'verified_online' | 'synced_as_of' | 'unavailable';

/** A movement this device holds that the synced position does not include. */
export interface MovementSinceSnapshot {
  readonly id: string;
  readonly kind: string;
  /** SIGNED minor units. Rendered on its own line; never summed here. */
  readonly amountMinor: MinorUnits;
  readonly businessDate: string;
  /** The SERVER-stamped HLC. Greater than the snapshot's `as_of_hlc`. */
  readonly hlc: string;
}

/**
 * One account's position as this device holds it.
 *
 * Deliberately a DIFFERENT type from `CreditPosition`: every figure on it is
 * `synced_as_of` and none of it may be rendered as current.
 */
export interface SyncedCreditPosition {
  readonly accountId: string;
  readonly customerId: string;
  readonly status: string;
  readonly termsDays: number;
  /** SYNCED. Σ over every entry the SERVER holds, archived ones included. */
  readonly balanceMinor: MinorUnits;
  readonly creditLimitMinor: MinorUnits;
  /** Limit − trade exposure. May be NEGATIVE: already over the limit. */
  readonly availableMinor: MinorUnits;
  readonly onAccountCreditMinor: MinorUnits;
  /** Fee receivable, kept apart from trade receivable (06 §6.4.4). */
  readonly feeOutstandingMinor: MinorUnits;
  /** TRUE while the tenant's fee policy is unconfirmed — nothing is chargeable. */
  readonly feeProvisional: boolean;
  /**
   * Σ over the entries this device does NOT hold. It exists so the window can
   * never be mistaken for the whole account: a statement listing that starts
   * part-way through says what came before it, by amount.
   */
  readonly openingBeforeWindowMinor: MinorUnits;
  /** How many days of statement this device is entitled to hold. */
  readonly entryWindowDays: number;
  /** SYNCED, rendered server-side. The device cannot recompute these. */
  readonly buckets: readonly AgeingBucket[];
  /** The server's own word for what the buckets measure. Rendered verbatim. */
  readonly agedBy: string;
  /** The trading date the server aged against. */
  readonly asOf: string;
  /** The server HLC this was evaluated through. Never a wall clock. */
  readonly asOfHlc: string;
  /** When the server computed it, for "as at 06:40" wording. */
  readonly computedAtMs: number | null;
  readonly limitVersionId: string | null;
  /** The shared identity check — the same one the online path runs. */
  readonly agreement: PositionAgreement;
  /** Held here, absent from the figures above. Listed, never added. */
  readonly movementsSince: readonly MovementSinceSnapshot[];
}

/** What a local read can answer. `unavailable` carries no figures at all. */
export type SyncedCreditRead =
  | { readonly kind: 'synced_as_of'; readonly position: SyncedCreditPosition }
  | { readonly kind: 'unavailable' };

const UNAVAILABLE: SyncedCreditRead = { kind: 'unavailable' };

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** Minor units arrive as TEXT (§8.3 — the wasm driver would hand back float64). */
function money(value: unknown, what: string): MinorUnits {
  if (typeof value === 'bigint') return value;
  const text = typeof value === 'string' ? value.trim() : String(value ?? '');
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`${what}: expected an integer of minor units, got ${JSON.stringify(value)}`);
  }
  return BigInt(text);
}

function count(value: unknown, what: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${what}: expected a whole number, got ${JSON.stringify(value)}`);
  }
  return n;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function msOrNull(value: unknown): number | null {
  const text = textOrNull(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The account this device believes belongs to a customer.
 *
 * `customer_account` syncs only to holders of `credit.view`; a counter device
 * holds none of it and gets `null` here, which is the correct answer for a
 * device that is not entitled to the book.
 */
export async function loadAccountIdForCustomer(
  db: DbExecutor,
  customerId: string,
): Promise<string | null> {
  const rows = await db.getAll(`SELECT id FROM customer_account WHERE customer_id = ? LIMIT 1`, [
    customerId,
  ]);
  const row = rows[0];
  return row === undefined ? null : String(row['id']);
}

/**
 * The synced position for one account, or `unavailable`.
 *
 * `unavailable` is returned when there is no snapshot row — a device that is
 * not entitled to the book, or one that has never synced it. It is NOT
 * returned merely because the bucket vector is empty: an account that owes
 * nothing has a zero vector and a real, current balance of zero, and calling
 * that "unavailable" would be its own small lie.
 */
export async function loadSyncedCreditPosition(
  db: DbExecutor,
  accountId: string,
): Promise<SyncedCreditRead> {
  const rows = await db.getAll(
    `SELECT account_id,
            customer_id,
            status,
            terms_days,
            aged_by,
            as_of,
            as_of_hlc,
            computed_at,
            fee_confirmed_at,
            limit_version_id,
            entry_window_days,
            CAST(credit_limit_minor          AS TEXT) AS credit_limit_minor,
            CAST(balance_minor               AS TEXT) AS balance_minor,
            CAST(available_minor             AS TEXT) AS available_minor,
            CAST(on_account_credit_minor     AS TEXT) AS on_account_credit_minor,
            CAST(fee_outstanding_minor       AS TEXT) AS fee_outstanding_minor,
            CAST(opening_before_window_minor AS TEXT) AS opening_before_window_minor
       FROM credit_position_snapshot
      WHERE account_id = ?
      LIMIT 1`,
    [accountId],
  );
  const row = rows[0];
  if (row === undefined) return UNAVAILABLE;

  const asOfHlc = String(row['as_of_hlc'] ?? '');
  const bucketRows = await db.getAll(
    `SELECT label, CAST(amount_minor AS TEXT) AS amount_minor
       FROM credit_position_bucket
      WHERE account_id = ?
      ORDER BY seq`,
    [accountId],
  );
  const buckets: AgeingBucket[] = bucketRows.map((b, i) => ({
    label: String(b['label'] ?? ''),
    amountMinor: money(b['amount_minor'], `buckets[${String(i)}].amountMinor`),
  }));

  // Movements this device holds that the snapshot does not include. The
  // comparison is HLC > HLC — two values the SERVER stamped. `app.hlc` is
  // fixed-width text under collation "C" precisely so lexicographic order is
  // causal order, so a string comparison is the correct one here.
  const sinceRows = await db.getAll(
    `SELECT id, kind, business_date, hlc,
            CAST(amount_minor AS TEXT) AS amount_minor
       FROM credit_entry
      WHERE account_id = ? AND hlc > ?
      ORDER BY hlc`,
    [accountId, asOfHlc],
  );
  const movementsSince: MovementSinceSnapshot[] = sinceRows.map((m, i) => ({
    id: String(m['id']),
    kind: String(m['kind'] ?? ''),
    amountMinor: money(m['amount_minor'], `movementsSince[${String(i)}].amountMinor`),
    businessDate: String(m['business_date'] ?? ''),
    hlc: String(m['hlc'] ?? ''),
  }));

  const balanceMinor = money(row['balance_minor'], 'balanceMinor');
  const onAccountCreditMinor = money(row['on_account_credit_minor'], 'onAccountCreditMinor');
  const feeOutstandingMinor = money(row['fee_outstanding_minor'], 'feeOutstandingMinor');
  const asOf = String(row['as_of'] ?? '');

  // The SHARED identity check. `checkAgreement` is `data/api/credit.ts`'s own
  // function and it is given the same two shapes it is given online, so the
  // synced position is held to exactly the standard the live answer is held to.
  const asExposure: CreditExposure = {
    accountId,
    exposureMinor: balanceMinor,
    creditLimitMinor: money(row['credit_limit_minor'], 'creditLimitMinor'),
    availableMinor: money(row['available_minor'], 'availableMinor'),
    status: String(row['status'] ?? ''),
    termsDays: count(row['terms_days'], 'termsDays'),
    limitVersionId: textOrNull(row['limit_version_id']),
  };
  const asAgeing: CreditAgeing = {
    accountId,
    asOf,
    agedBy: String(row['aged_by'] ?? ''),
    buckets,
    onAccountCreditMinor,
    feeOutstandingMinor,
    invoices: [],
  };

  return {
    kind: 'synced_as_of',
    position: {
      accountId,
      customerId: String(row['customer_id'] ?? ''),
      status: asExposure.status,
      termsDays: asExposure.termsDays,
      balanceMinor,
      creditLimitMinor: asExposure.creditLimitMinor,
      availableMinor: asExposure.availableMinor,
      onAccountCreditMinor,
      feeOutstandingMinor,
      feeProvisional: textOrNull(row['fee_confirmed_at']) === null,
      openingBeforeWindowMinor: money(
        row['opening_before_window_minor'],
        'openingBeforeWindowMinor',
      ),
      entryWindowDays: count(row['entry_window_days'], 'entryWindowDays'),
      buckets,
      agedBy: asAgeing.agedBy,
      asOf,
      asOfHlc,
      computedAtMs: msOrNull(row['computed_at']),
      limitVersionId: asExposure.limitVersionId,
      agreement: checkAgreement(asExposure, asAgeing),
      movementsSince,
    },
  };
}

/** One statement line as this device holds it. DISPLAY ONLY — never totalled. */
export interface StatementLine {
  readonly id: string;
  readonly kind: string;
  /** SIGNED minor units. Rendered per line. */
  readonly amountMinor: MinorUnits;
  readonly businessDate: string;
  readonly dueDate: string | null;
}

/**
 * The statement lines this device holds, newest first.
 *
 * A caller MUST render `openingBeforeWindowMinor` and `entryWindowDays` beside
 * this list. An empty or short list means "the window starts here", never "no
 * activity" — R3 rule 6 names that confusion by name.
 */
export async function loadStatementLines(
  db: DbExecutor,
  accountId: string,
  limit = 50,
): Promise<StatementLine[]> {
  const rows = await db.getAll(
    `SELECT id, kind, business_date, due_date,
            CAST(amount_minor AS TEXT) AS amount_minor
       FROM credit_entry
      WHERE account_id = ?
      ORDER BY business_date DESC, hlc DESC
      LIMIT ?`,
    [accountId, limit],
  );
  return rows.map((row, i) => ({
    id: String(row['id']),
    kind: String(row['kind'] ?? ''),
    amountMinor: money(row['amount_minor'], `statement[${String(i)}].amountMinor`),
    businessDate: String(row['business_date'] ?? ''),
    dueDate: textOrNull(row['due_date']),
  }));
}
