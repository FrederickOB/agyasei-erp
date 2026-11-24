/**
 * WHO OWES — the credit book this device already holds, as a worklist.
 *
 * Accounts opens the Credit screen to chase money. Before this, the screen
 * opened on a search box: you had to already know whom to look up. Every
 * figure needed to answer "who should I ring first" is already on an
 * accounts device — the `tenant_credit` sync bucket delivers a SERVER-DERIVED
 * position and ageing vector per account (`credit-position.ts` explains why
 * those are authoritative and the local entry log is not).
 *
 * So this is a READ OF SYNCED FIGURES AND A SORT. Nothing here adds money up:
 *
 *  · the balance shown is `credit_position_snapshot.balance_minor`, as synced;
 *  · "how late" is the OLDEST overdue band the server put money in, and the
 *    amount the server put there — picked, never totalled;
 *  · `credit_entry` is not read at all (`tests/credit-no-local-total.test.ts`).
 *
 * The tenant boundary is the sync rule: `tenant_credit` is keyed on the JWT's
 * tenant and gated on a ROOT `credit.view` grant, so a device holds one
 * tenant's book or none. A device holding none gets `null` here — not an empty
 * list, because "nobody owes anything" and "this device cannot know" are
 * different sentences and the screen must not say the first when it means the
 * second.
 */
import type { MinorUnits } from '@erp/money';
import type { DbExecutor } from '../db';

/** The oldest overdue band holding money, exactly as the server labelled it. */
export interface OverdueBand {
  /** The server's band label (`31-60`, `90+`) — tenant policy, rendered verbatim. */
  readonly label: string;
  /** Position in the server's band order. Higher is older. */
  readonly seq: number;
  /** What the server put in that band. One band's figure; never a sum. */
  readonly amountMinor: MinorUnits;
}

export interface Debtor {
  readonly accountId: string;
  readonly customerId: string;
  readonly name: string;
  readonly code: string;
  readonly phone: string | null;
  readonly status: string;
  /** SYNCED balance. Rendered with its "as at", never as a current figure. */
  readonly balanceMinor: MinorUnits;
  /** Limit − trade exposure, as synced. Negative = over the limit. */
  readonly availableMinor: MinorUnits;
  /** Null when nothing owed is past its due date. */
  readonly oldestOverdue: OverdueBand | null;
  readonly asOf: string;
  readonly computedAtMs: number | null;
}

/** Minor units arrive as TEXT (§8.3 — the wasm driver would hand back float64). */
function minor(value: unknown, what: string): MinorUnits {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '');
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`${what}: expected an integer of minor units, got ${JSON.stringify(value)}`);
  }
  return BigInt(text);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Most urgent first: the OLDEST overdue band wins, then the larger amount in
 * that band, then the larger balance. Ties fall back to name so the list does
 * not reshuffle itself between syncs. Comparisons are bigint against bigint.
 */
export function compareDebtors(a: Debtor, b: Debtor): number {
  const aSeq = a.oldestOverdue?.seq ?? -1;
  const bSeq = b.oldestOverdue?.seq ?? -1;
  if (aSeq !== bSeq) return bSeq - aSeq;
  if (a.oldestOverdue !== null && b.oldestOverdue !== null) {
    const x = a.oldestOverdue.amountMinor;
    const y = b.oldestOverdue.amountMinor;
    if (x !== y) return x > y ? -1 : 1;
  }
  if (a.balanceMinor !== b.balanceMinor) return a.balanceMinor > b.balanceMinor ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Every account that owes something, most urgent first — or `null` when this
 * device holds no credit book at all.
 */
export async function loadDebtors(db: DbExecutor): Promise<Debtor[] | null> {
  const rows = await db.getAll(
    `SELECT s.account_id,
            s.customer_id,
            s.status,
            s.as_of,
            s.computed_at,
            CAST(s.balance_minor   AS TEXT) AS balance_minor,
            CAST(s.available_minor AS TEXT) AS available_minor,
            c.name,
            c.code,
            c.phone
       FROM credit_position_snapshot s
       LEFT JOIN customer c ON c.id = s.customer_id`,
  );
  if (rows.length === 0) return null;

  // Overdue bands only: the server writes from_dpd NULL for "not yet due"
  // (migration 0013), so a band with a lower edge of a day or more is late.
  const bandRows = await db.getAll(
    `SELECT account_id, seq, label, CAST(amount_minor AS TEXT) AS amount_minor
       FROM credit_position_bucket
      WHERE from_dpd IS NOT NULL AND from_dpd >= 1
      ORDER BY account_id, seq`,
  );
  const oldest = new Map<string, OverdueBand>();
  for (const [i, band] of bandRows.entries()) {
    const amountMinor = minor(band['amount_minor'], `bands[${String(i)}].amountMinor`);
    if (amountMinor <= 0n) continue;
    const accountId = String(band['account_id']);
    const seq = Number(band['seq']);
    const held = oldest.get(accountId);
    if (held === undefined || seq > held.seq) {
      oldest.set(accountId, { label: String(band['label'] ?? ''), seq, amountMinor });
    }
  }

  const debtors: Debtor[] = [];
  for (const [i, row] of rows.entries()) {
    const balanceMinor = minor(row['balance_minor'], `debtors[${String(i)}].balanceMinor`);
    if (balanceMinor <= 0n) continue;
    const accountId = String(row['account_id']);
    const code = textOrNull(row['code']) ?? '';
    const computedAt = textOrNull(row['computed_at']);
    const computedAtMs = computedAt === null ? Number.NaN : Date.parse(computedAt);
    debtors.push({
      accountId,
      customerId: String(row['customer_id'] ?? ''),
      // A customer row not yet synced still has an account worth chasing; show
      // what identifies it rather than dropping the debt from the list.
      name: textOrNull(row['name']) ?? (code === '' ? 'Unnamed customer' : code),
      code,
      phone: textOrNull(row['phone']),
      status: String(row['status'] ?? ''),
      balanceMinor,
      availableMinor: minor(row['available_minor'], `debtors[${String(i)}].availableMinor`),
      oldestOverdue: oldest.get(accountId) ?? null,
      asOf: String(row['as_of'] ?? ''),
      computedAtMs: Number.isNaN(computedAtMs) ? null : computedAtMs,
    });
  }
  return debtors.sort(compareDebtors);
}
