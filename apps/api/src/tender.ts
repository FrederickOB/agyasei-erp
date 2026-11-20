/**
 * TENDER LINES ON THE SALE PATH — the two maps the capability check reads, and
 * the one rule that puts a device's split onto the server's total.
 *
 * Pure: no database, no clock. `routers/sales.ts` resolves the methods and
 * prices the sale; this file decides authority and arithmetic, so both can be
 * tested exhaustively (CLAUDE.md §2.7 category 1).
 */
import type { TenderSettlement } from '@erp/contracts';
import type { PermissionCode, SettlementRole } from '@erp/db';

/**
 * WHICH CAPABILITY EACH KIND OF SETTLEMENT NEEDS (02 §2.4; CLAUDE.md §2.6).
 *
 * The boundary the brief draws through the sale path is HOW THE MONEY MOVES:
 * "outlet staff … POS" versus "outlet manager … credit sales up to a set
 * limit". Money received now takes money in; money on account hands out the
 * tenant's own working capital and creates an exposure that outlives the
 * sale. Two acts, two capabilities.
 *
 * TOTAL over the contract's union, and TypeScript proves it: a third kind of
 * settlement added to `TENDER_SETTLEMENTS` without deciding what guards it is
 * a compile error here, not a sale that silently needs nothing.
 */
export const SETTLEMENT_PERMISSION: Record<TenderSettlement, PermissionCode> = {
  IMMEDIATE: 'sale.record',
  ON_ACCOUNT: 'sale.record.credit',
};

/**
 * What each posting role IS, in the contract's vocabulary — the server's half
 * of the two-answer check. A tender line declares its settlement; the plan
 * looks the method up, maps its role through this table, and refuses a line
 * whose two answers disagree. TOTAL over `SettlementRole` (migration 0020's
 * CHECK), so a fifth role cannot arrive without a decision here.
 */
export const ROLE_SETTLEMENT: Record<SettlementRole, TenderSettlement> = {
  TILL_CASH: 'IMMEDIATE',
  MOMO_WALLET: 'IMMEDIATE',
  BANK: 'IMMEDIATE',
  AR_TRADE: 'ON_ACCOUNT',
};

/**
 * The capability the MIDDLEWARE checks, read out of the validated input.
 *
 * Anything unrecognised returns undefined, which the middleware turns into a
 * refusal — never a default, never the weaker code. A sale with any
 * IMMEDIATE line is checked for `sale.record` here; its ON_ACCOUNT line, if
 * it has one, is checked again inside the plan WITH ITS BOUND, against the
 * server's own figure for that line. A sale entirely on account needs only
 * `sale.record.credit` — the boundary the template has always drawn.
 */
export function salePermission(input: Record<string, unknown>): PermissionCode | undefined {
  const tenders = input['tenders'];
  if (!Array.isArray(tenders) || tenders.length === 0) return undefined;
  const codes = new Set<PermissionCode>();
  for (const t of tenders) {
    const settlement = (t as Record<string, unknown> | null)?.['settlement'];
    if (typeof settlement !== 'string') return undefined;
    const code = (SETTLEMENT_PERMISSION as Record<string, PermissionCode | undefined>)[settlement];
    if (code === undefined) return undefined; // one unknown line poisons the request
    codes.add(code);
  }
  return codes.has('sale.record') ? 'sale.record' : 'sale.record.credit';
}

export interface TenderClaim {
  readonly seq: number;
  readonly methodId: string;
  readonly role: SettlementRole;
  /**
   * The device's figure for this line, or NULL for the BALANCE line — the one
   * line (at most) that settles "whatever the others do not". A balance line
   * makes no claim, so giving it the server's remainder overwrites nothing.
   */
  readonly claimedMinor: bigint | null;
  readonly reference?: string | undefined;
}

export interface ReconciledTender extends TenderClaim {
  /** The SERVER's figure — what `app.sale_tender.amount_minor` stores. */
  readonly amountMinor: bigint;
}

export interface Reconciliation {
  readonly lines: readonly ReconciledTender[];
  /**
   * serverTotal − Σ (stated claims), with a balance line counted as claiming
   * whatever it ended up holding. Non-zero exactly when a STATED claim had to
   * move — the case that goes to review.
   */
  readonly deltaMinor: bigint;
}

/** Lower ranks absorb a difference first. See `reconcileTenders`. */
function absorbRank(role: SettlementRole): number {
  switch (role) {
    case 'AR_TRADE':
      return 0;
    case 'TILL_CASH':
      return 1;
    case 'MOMO_WALLET':
    case 'BANK':
      return 2;
  }
}

/**
 * Put the device's split onto the SERVER's total.
 *
 * The server is the pricing authority (packages/contracts/src/sale.ts), and
 * `Σ sale_tender = sale.total_minor` is enforced at commit (migration 0022).
 * A device that priced against a stale list tenders a different total, and
 * refusing the sale would lose it with the goods already gone (CLAUDE.md
 * §2.2). So the difference is placed by a STATED, DETERMINISTIC rule:
 *
 *   1. ON ACCOUNT first. The customer's account is charged what the server
 *      says the goods cost — exactly what the CHARGE has always been
 *      (`credit_entry.amount_minor` was the server total before tenders
 *      existed), so a split changes nothing about that precedent.
 *   2. Then DRAWER CASH. The drawer holds what the cashier took; moving the
 *      server's figure here makes the difference surface at cash-up as a count
 *      variance, in front of a person, the same day.
 *   3. Then the other instruments, largest first (ties by line order). A momo
 *      transaction or a cheque is for an exact amount, so this is last.
 *
 * A positive difference is added to the first line in that order. A negative
 * one is taken from lines in that order, each down to ZERO at most — never
 * below — so every stored amount stays non-negative and the total always
 * reconciles (Σ claimed ≥ |difference| whenever the server total is ≥ 0).
 * A line taken to zero is KEPT: it carries a reference and a claim that are
 * evidence.
 *
 * THE BALANCE LINE comes first of all. A line that stated no amount takes
 * the server's remainder outright — "momo for 50.00, the rest in cash" is how
 * a split is actually tendered — and that is not a reconciliation, because
 * nothing was claimed. Only when the stated lines alone EXCEED the server's
 * total does the balance line fall to zero and the rule above move a stated
 * claim.
 *
 * Whenever a stated claim moves the router opens a review: the server never
 * silently rewrites how a device said money moved (CLAUDE.md §2.2). Exact
 * bigint throughout (ADR-0004).
 */
export function reconcileTenders(
  claims: readonly TenderClaim[],
  serverTotalMinor: bigint,
): Reconciliation {
  if (serverTotalMinor < 0n) {
    throw new RangeError(`a sale total cannot be negative: ${serverTotalMinor}`);
  }
  if (claims.length === 0) {
    throw new RangeError('a sale is settled by at least one tender');
  }
  let stated = 0n;
  let balance: TenderClaim | null = null;
  for (const c of claims) {
    if (c.claimedMinor === null) {
      if (balance !== null) throw new RangeError('at most one tender line may settle the balance');
      balance = c;
      continue;
    }
    if (c.claimedMinor < 0n) throw new RangeError(`a tender cannot be negative: ${c.claimedMinor}`);
    stated += c.claimedMinor;
  }

  const amounts = new Map<number, bigint>(claims.map((c) => [c.seq, c.claimedMinor ?? 0n]));
  let delta = serverTotalMinor - stated;
  if (balance !== null) {
    if (delta >= 0n) {
      // The remainder, outright. Nothing stated moves; nothing to review.
      amounts.set(balance.seq, delta);
      delta = 0n;
    }
    // Otherwise the stated lines alone overshoot the server's total: the
    // balance holds nothing and the stated lines are reconciled below.
  }

  if (delta !== 0n) {
    const statedClaims = claims.filter((c) => c.claimedMinor !== null);
    const claimOf = (c: TenderClaim): bigint => c.claimedMinor ?? 0n;
    const order = [...statedClaims].sort(
      (a, b) =>
        absorbRank(a.role) - absorbRank(b.role) ||
        (claimOf(a) === claimOf(b) ? 0 : claimOf(a) > claimOf(b) ? -1 : 1) ||
        a.seq - b.seq,
    );
    if (order.length === 0) {
      /* c8 ignore next — a lone balance line always absorbs (delta ≥ 0 above) */
      throw new RangeError('no stated tender to reconcile');
    }
    if (delta > 0n) {
      const first = order[0]!;
      amounts.set(first.seq, amounts.get(first.seq)! + delta);
    } else {
      let owed = -delta;
      for (const c of order) {
        if (owed === 0n) break;
        const have = amounts.get(c.seq)!;
        const take = have < owed ? have : owed;
        amounts.set(c.seq, have - take);
        owed -= take;
      }
      /* c8 ignore next 3 — unreachable while serverTotal ≥ 0 (checked above) */
      if (owed !== 0n) {
        throw new RangeError(`could not reconcile tenders onto ${serverTotalMinor}`);
      }
    }
  }

  return {
    lines: claims.map((c) => ({ ...c, amountMinor: amounts.get(c.seq)! })),
    deltaMinor: delta,
  };
}
