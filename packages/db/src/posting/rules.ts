/**
 * THE POSTING RULES — platform code, versioned, and speaking only in ROLES.
 *
 * 05 §5.6.2. A rule takes a settled document and returns the lines it implies.
 * It never names an account: that is the mapping's job (./mapping.ts), and
 * keeping the two apart is what lets a tenant configure its chart without
 * being able to edit how money is recorded.
 *
 * ── EVERY RULE HERE IS A PURE FUNCTION ────────────────────────────────────
 * Document in, lines out. No database, no clock, no resolution. That is what
 * makes the balance property testable exhaustively rather than by example:
 * `assertBalances()` below is called by every rule on its own output, so a
 * rule cannot return an unbalanced set even once, and the same check runs
 * again in Postgres at COMMIT (migration 0015) against the written lines.
 * Three independent chances to catch the same class of error.
 *
 * ── THE RULE THAT GOVERNS THE CONTROL ACCOUNTS ────────────────────────────
 * **The location of a control-account line is a property of the OBLIGATION,
 * not of the person handling the money.** 05 §5.6.2 got this wrong in five
 * rules, and the failure is nastier than an imbalance because nothing detects
 * it: a contractor buys on credit at Techiman and pays twenty days later at
 * Sunyani. Posting `Dr TILL(Sunyani) / Cr AR(Sunyani)` balances per location,
 * both trial balances still sum to zero, and the customer subledger nets out —
 * so credit control sees nothing. But Techiman's AR carries a debit that will
 * never clear and Sunyani's AR carries a permanent credit balance on an asset
 * account. After a year of contractors paying at whichever outlet is nearest
 * the site, every location balance sheet is fiction, and the trial balance —
 * "the single most useful diagnostic in the system" — is blind, because
 * nothing is unbalanced. It is mis-attributed.
 *
 * The correct form adds an inter-location clearing pair, which is why
 * `settlementLines()` exists and why every settlement rule goes through it.
 */

/** Posting roles this module emits. Platform vocabulary, never a tenant's. */
export type PostingRole =
  | 'TILL_CASH' | 'MOMO_WALLET' | 'BANK' | 'BANK_CHARGES' | 'CASH_IN_TRANSIT'
  | 'SALES_REVENUE' | 'SALES_DISCOUNT' | 'SALES_RETURNS' | 'OUTPUT_TAX'
  | 'COGS' | 'INVENTORY' | 'INVENTORY_IN_TRANSIT'
  | 'AR_TRADE' | 'INTERLOC_CLEARING' | 'GRNI' | 'AP_TRADE' | 'INPUT_TAX'
  | 'STOCK_ADJ' | 'DISTRIBUTION_COST';

export interface ProposedLine {
  readonly role: PostingRole;
  /** Whose books this line belongs to. Never optional — an entry balances here. */
  readonly locationId: string;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly counterpartyKind?: 'customer' | 'supplier' | 'employee';
  readonly counterpartyId?: string;
  /** Narrows mapping resolution. Not stored on the line. */
  readonly productCategoryId?: string;
  readonly productId?: string;
  readonly memo?: string;
}

export interface ProposedEntry {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly documentDate: string;
  readonly lines: readonly ProposedLine[];
}

export class UnbalancedRuleError extends Error {
  readonly code = 'GL_RULE_UNBALANCED';
  constructor(rule: string, detail: string) {
    super(`posting rule ${rule} produced lines that do not balance: ${detail}`);
    this.name = 'UnbalancedRuleError';
  }
}

/**
 * PER LOCATION, not merely in total — the check the database will make again.
 *
 * Failing here rather than at COMMIT means the exception names the RULE, which
 * is the thing a developer can fix, instead of naming an entry id.
 */
export function assertBalances(rule: string, lines: readonly ProposedLine[]): void {
  if (lines.length < 2) {
    throw new UnbalancedRuleError(rule, `${lines.length} line(s); double entry needs at least two`);
  }
  const byLocation = new Map<string, { dr: bigint; cr: bigint }>();
  for (const l of lines) {
    if ((l.debitMinor === 0n) === (l.creditMinor === 0n)) {
      throw new UnbalancedRuleError(
        rule,
        `a line on ${l.role} carries ${l.debitMinor === 0n ? 'neither side' : 'both sides'}`,
      );
    }
    if (l.debitMinor < 0n || l.creditMinor < 0n) {
      throw new UnbalancedRuleError(rule, `a line on ${l.role} carries a negative amount`);
    }
    const at = byLocation.get(l.locationId) ?? { dr: 0n, cr: 0n };
    byLocation.set(l.locationId, {
      dr: at.dr + l.debitMinor,
      cr: at.cr + l.creditMinor,
    });
  }
  for (const [locationId, { dr, cr }] of byLocation) {
    if (dr !== cr) {
      throw new UnbalancedRuleError(rule, `location ${locationId} Dr ${dr} / Cr ${cr}`);
    }
  }
}

/** Drop the lines a rule computed to nil. A zero line carries no information,
 *  and migration 0015's `jl_one_side` refuses one outright. */
function live(lines: readonly ProposedLine[]): ProposedLine[] {
  return lines.filter((l) => l.debitMinor !== 0n || l.creditMinor !== 0n);
}

function dr(
  role: PostingRole,
  locationId: string,
  amount: bigint,
  extra: Partial<ProposedLine> = {},
): ProposedLine {
  return { role, locationId, debitMinor: amount, creditMinor: 0n, ...extra };
}

function cr(
  role: PostingRole,
  locationId: string,
  amount: bigint,
  extra: Partial<ProposedLine> = {},
): ProposedLine {
  return { role, locationId, debitMinor: 0n, creditMinor: amount, ...extra };
}

// ---------------------------------------------------------------------------
// Rules 1, 1b, 2, 3 — a sale
// ---------------------------------------------------------------------------

export interface SaleTaxComponent {
  readonly taxCode: string;
  readonly taxMinor: bigint;
}

export interface SaleDocument {
  readonly saleId: string;
  readonly locationId: string;
  readonly businessDate: string;
  readonly tender: 'CASH' | 'MOMO' | 'CREDIT';
  readonly customerId?: string | undefined;
  /**
   * Revenue GROSS of discount — `sale_line.line_net_minor` summed. 07 §7.3.2:
   * "the revenue figure is gross of discount and the tax base is net of it",
   * which is why the discount is its own contra line rather than a smaller
   * revenue credit. A manager granting approved overrides all day must not
   * produce books indistinguishable from lower list prices.
   */
  readonly revenueMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxes: readonly SaleTaxComponent[];
  /** Moving weighted average cost of what left the shelf. May be 0n. */
  readonly costMinor: bigint;
  readonly productCategoryId?: string | undefined;
}

const TENDER_ROLE: Record<SaleDocument['tender'], PostingRole> = {
  CASH: 'TILL_CASH',
  MOMO: 'MOMO_WALLET',
  CREDIT: 'AR_TRADE',
};

/**
 * Rules 1, 1b, 2 and 3 in one function, because they are one entry.
 *
 * Cash and credit differ ONLY in which account takes the debit, which is why
 * §5.6.2 describes rule 2 as "identical to #1 with the cash line swapped".
 * Revenue is recognised here and not on payment.
 *
 * TAX IS A LIABILITY, NEVER REVENUE (rule 3). One credit per component, from
 * the rate rows in force on the document date — the caller has already priced
 * them; this rule does not compute tax and must never start.
 */
export function saleEntry(doc: SaleDocument): ProposedEntry {
  const taxTotal = doc.taxes.reduce((a, t) => a + t.taxMinor, 0n);
  // A NIL DOCUMENT, found by the property test rather than by reasoning: zero
  // revenue, zero discount, no tax, no cost. Every line computes to nothing
  // and there is no entry to make. Refused explicitly and by name, rather than
  // falling through to `assertBalances` complaining about a line count, so
  // that the posting engine's exception says something an operator can act on.
  //
  // This is a real shape, not a hypothetical: it is what a sale rung entirely
  // against zero-priced items produces, and it is what an unauthorised
  // discount to zero produced before that field was bounded.
  if (doc.revenueMinor === 0n && doc.discountMinor === 0n && taxTotal === 0n && doc.costMinor === 0n) {
    throw new UnbalancedRuleError('sale', 'a sale with no revenue, tax, discount or cost has nothing to post');
  }
  // What the customer actually owes, and what `app.sale.total_minor` holds:
  // revenue gross of discount, less the discount, plus tax.
  const totalMinor = doc.revenueMinor - doc.discountMinor + taxTotal;
  const at = doc.locationId;
  const scope = doc.productCategoryId === undefined ? {} : { productCategoryId: doc.productCategoryId };

  const counterparty =
    doc.tender === 'CREDIT' && doc.customerId !== undefined
      ? { counterpartyKind: 'customer' as const, counterpartyId: doc.customerId }
      : {};

  const lines = live([
    dr(TENDER_ROLE[doc.tender], at, totalMinor, counterparty),
    // Rule 1b. Contra-income, debited, so gross sales stay recoverable.
    dr('SALES_DISCOUNT', at, doc.discountMinor, scope),
    cr('SALES_REVENUE', at, doc.revenueMinor, scope),
    ...doc.taxes.map((t) => cr('OUTPUT_TAX', at, t.taxMinor, { memo: t.taxCode })),
    // The cost side. Balanced within itself, so a sale of a non-stocked
    // service line simply has no cost pair rather than an unbalanced entry.
    dr('COGS', at, doc.costMinor, scope),
    cr('INVENTORY', at, doc.costMinor, scope),
  ]);

  assertBalances('sale', lines);
  return {
    sourceKind: doc.tender === 'CREDIT' ? 'credit_sale' : 'cash_sale',
    sourceId: doc.saleId,
    documentDate: doc.businessDate,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Rule 4 — a payment received against AR
// ---------------------------------------------------------------------------

export interface PaymentDocument {
  readonly paymentId: string;
  readonly businessDate: string;
  /** Where the money was physically handed over. */
  readonly receivingLocationId: string;
  /**
   * Where the OBLIGATION lives — the location whose AR this settles. The
   * subledger must return this with each allocation; without it the ledger
   * cannot post rule 4 correctly and nothing downstream can tell.
   */
  readonly obligationLocationId: string;
  readonly customerId: string;
  readonly amountMinor: bigint;
  readonly instrument: 'CASH' | 'MOMO' | 'BANK';
  /** What the provider kept. Momo receipts arrive net; revenue is the gross. */
  readonly chargeMinor?: bigint;
}

const INSTRUMENT_ROLE: Record<PaymentDocument['instrument'], PostingRole> = {
  CASH: 'TILL_CASH',
  MOMO: 'MOMO_WALLET',
  BANK: 'BANK',
};

/**
 * Settlement, not revenue — and it clears the AR WHERE THE OBLIGATION WAS
 * CREATED.
 *
 * When receipt and obligation share a location the clearing pair is omitted
 * and this is two lines, exactly as §5.6.2 says. When they differ, four:
 *
 *   Dr TILL(receiving)            Cr INTERLOC_CLEARING(receiving)
 *   Dr INTERLOC_CLEARING(oblig.)  Cr AR_TRADE(obligation)
 *
 * Both locations balance, Σ INTERLOC_CLEARING is still zero across the
 * tenant, and Techiman's AR clears at Techiman.
 *
 * Rule 4b rides along: a provider charge is an EXPENSE, not a discount. The
 * customer paid 1,000 and 995 landed; AR clears by 1,000 and the 5 is
 * `BANK_CHARGES`. Getting this wrong makes momo never reconcile.
 */
export function paymentEntry(doc: PaymentDocument): ProposedEntry {
  const charge = doc.chargeMinor ?? 0n;
  if (charge < 0n || charge > doc.amountMinor) {
    throw new UnbalancedRuleError('payment', `charge ${charge} is not within the amount ${doc.amountMinor}`);
  }
  const netReceived = doc.amountMinor - charge;
  const rx = doc.receivingLocationId;
  const ob = doc.obligationLocationId;
  const customer = { counterpartyKind: 'customer' as const, counterpartyId: doc.customerId };

  const lines =
    rx === ob
      ? live([
          dr(INSTRUMENT_ROLE[doc.instrument], rx, netReceived),
          dr('BANK_CHARGES', rx, charge),
          cr('AR_TRADE', ob, doc.amountMinor, customer),
        ])
      : live([
          dr(INSTRUMENT_ROLE[doc.instrument], rx, netReceived),
          dr('BANK_CHARGES', rx, charge),
          cr('INTERLOC_CLEARING', rx, doc.amountMinor),
          dr('INTERLOC_CLEARING', ob, doc.amountMinor),
          cr('AR_TRADE', ob, doc.amountMinor, customer),
        ]);

  assertBalances('payment', lines);
  return {
    sourceKind: 'customer_payment',
    sourceId: doc.paymentId,
    documentDate: doc.businessDate,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Rules 7 / 7b — a stock adjustment
// ---------------------------------------------------------------------------

export interface StockAdjustmentDocument {
  readonly movementId: string;
  readonly businessDate: string;
  readonly locationId: string;
  /** Tenant-editable reason code. Selects the account VIA THE MAPPING — this
   *  rule never branches on it (CLAUDE.md §2.9). */
  readonly reasonCode: string;
  /** Signed: negative is a shortage, positive an overage. */
  readonly valueMinor: bigint;
  readonly productCategoryId?: string;
}

export function stockAdjustmentEntry(doc: StockAdjustmentDocument): ProposedEntry {
  if (doc.valueMinor === 0n) {
    throw new UnbalancedRuleError('stock_adjustment', 'a nil adjustment has nothing to post');
  }
  const at = doc.locationId;
  const scope = doc.productCategoryId === undefined ? {} : { productCategoryId: doc.productCategoryId };
  const magnitude = doc.valueMinor < 0n ? -doc.valueMinor : doc.valueMinor;

  const lines =
    doc.valueMinor < 0n
      ? // Rule 7 — shortage. The loss is an expense; stock falls.
        live([
          dr('STOCK_ADJ', at, magnitude, { ...scope, memo: doc.reasonCode }),
          cr('INVENTORY', at, magnitude, scope),
        ])
      : // Rule 7b — overage.
        live([
          dr('INVENTORY', at, magnitude, scope),
          cr('STOCK_ADJ', at, magnitude, { ...scope, memo: doc.reasonCode }),
        ]);

  assertBalances('stock_adjustment', lines);
  return {
    sourceKind: 'stock_adjustment',
    sourceId: doc.movementId,
    documentDate: doc.businessDate,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Rules 6 / 6b — an inter-location transfer
// ---------------------------------------------------------------------------

export interface TransferDocument {
  readonly transferId: string;
  readonly businessDate: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  /** At the SENDING location's moving average. */
  readonly costMinor: bigint;
  readonly productCategoryId?: string;
}

/**
 * Despatch and receipt, as one entry across two locations.
 *
 * **No income account is touched, at either end.** That is the structural half
 * of §5.6.3's guarantee that moving stock between outlets cannot inflate
 * consolidated revenue — the report-side half is a separate check.
 */
export function transferEntry(doc: TransferDocument): ProposedEntry {
  if (doc.fromLocationId === doc.toLocationId) {
    throw new UnbalancedRuleError('transfer', 'a transfer to the same location is not a transfer');
  }
  const scope = doc.productCategoryId === undefined ? {} : { productCategoryId: doc.productCategoryId };
  const lines = live([
    // Rule 6 — despatch.
    dr('INTERLOC_CLEARING', doc.fromLocationId, doc.costMinor),
    cr('INVENTORY', doc.fromLocationId, doc.costMinor, scope),
    // Rule 6b — receipt.
    dr('INVENTORY_IN_TRANSIT', doc.toLocationId, doc.costMinor, scope),
    cr('INTERLOC_CLEARING', doc.toLocationId, doc.costMinor),
  ]);

  assertBalances('transfer', lines);
  return {
    sourceKind: 'stock_transfer',
    sourceId: doc.transferId,
    documentDate: doc.businessDate,
    lines,
  };
}

/**
 * Σ INTERLOC_CLEARING across an entry is zero.
 *
 * Exported because it is an invariant of the whole LEDGER, not of one rule:
 * every clearing line raised anywhere must be cleared somewhere, and a
 * tenant-wide non-zero balance means a location's books are carrying somebody
 * else's money. §5.9.2 makes it a close gate; this is the per-entry half.
 */
export function clearingNets(lines: readonly ProposedLine[]): boolean {
  let net = 0n;
  for (const l of lines) {
    if (l.role === 'INTERLOC_CLEARING') net += l.debitMinor - l.creditMinor;
  }
  return net === 0n;
}
