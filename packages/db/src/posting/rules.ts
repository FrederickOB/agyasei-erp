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
  | 'TILL_CASH' | 'MOMO_WALLET' | 'BANK' | 'BANK_CHARGES' | 'CASH_IN_TRANSIT' | 'CASH_OVER_SHORT'
  | 'SALES_REVENUE' | 'SALES_DISCOUNT' | 'SALES_RETURNS' | 'OUTPUT_TAX'
  | 'COGS' | 'INVENTORY' | 'INVENTORY_IN_TRANSIT'
  | 'AR_TRADE' | 'INTERLOC_CLEARING' | 'GRNI' | 'AP_TRADE' | 'INPUT_TAX'
  | 'STOCK_ADJ' | 'DISTRIBUTION_COST'
  | 'STAFF_COST_GROSS' | 'STAFF_COST_COMMISSION' | 'STAFF_COST_EMPLOYER_SOCIAL'
  | 'EMPLOYEE_TAX_PAYABLE' | 'EMPLOYEE_SOCIAL_PAYABLE' | 'EMPLOYER_SOCIAL_PAYABLE'
  | 'OTHER_DEDUCTIONS_PAYABLE' | 'NET_PAY_PAYABLE';

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

/**
 * The posting roles a tender can settle into — the four places money that
 * moved at a counter can land (05 §5.6.2 rules 1 and 2). Mirrors migration
 * 0020's `tm_settlement_role` CHECK on `app.tender_method.posting_role`.
 *
 * Which of them a tenant's "Mobile Money" or "Cheque" uses is the tenant's
 * row, not this module's business: the rule reads the ROLE and nothing else.
 */
export type SettlementRole = 'TILL_CASH' | 'MOMO_WALLET' | 'BANK' | 'AR_TRADE';

/** In a FIXED order, so an entry's line order never depends on row order. */
export const SETTLEMENT_ROLES: readonly SettlementRole[] = ['TILL_CASH', 'MOMO_WALLET', 'BANK', 'AR_TRADE'];

export function isSettlementRole(role: string): role is SettlementRole {
  return (SETTLEMENT_ROLES as readonly string[]).includes(role);
}

/** One way the sale was paid, already resolved to its role. */
export interface SaleTenderPart {
  readonly role: SettlementRole;
  readonly amountMinor: bigint;
}

export interface SaleDocument {
  readonly saleId: string;
  readonly locationId: string;
  readonly businessDate: string;
  /**
   * How the customer paid — FROM `app.sale_tender`, one part per row (the
   * rule aggregates per role). Σ amountMinor must equal the sale's total; the
   * database asserts that at commit (migration 0022) and this rule refuses a
   * document that disagrees rather than balancing it with a plug.
   *
   * Split tender is ordinary: part cash, part momo debits TILL_CASH and
   * MOMO_WALLET separately, so each reconciles against its own statement.
   */
  readonly tenders: readonly SaleTenderPart[];
  /** Counterparty for the AR line. Required when any part is AR_TRADE. */
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

/**
 * Rules 1, 1b, 2 and 3 in one function, because they are one entry.
 *
 * Cash, momo, bank and credit differ ONLY in which account takes the debit,
 * which is why §5.6.2 describes rule 2 as "identical to #1 with the cash line
 * swapped". A split tender is the same entry with more than one debit.
 * Revenue is recognised here and not on payment.
 *
 * TAX IS A LIABILITY, NEVER REVENUE (rule 3). One credit per component, from
 * the rate rows in force on the document date — the caller has already priced
 * them; this rule does not compute tax and must never start.
 *
 * The customer is the counterparty of the AR line and ONLY the AR line: a
 * cash sale to a known customer debits the till, not the customer.
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

  const byRole = new Map<SettlementRole, bigint>();
  for (const t of doc.tenders) {
    if (!isSettlementRole(t.role)) {
      // Fail closed: a role this rule does not know where to put is neither
      // dropped (which would unbalance the entry) nor guessed.
      throw new UnbalancedRuleError('sale', `tender role ${String(t.role)} is not a settlement role`);
    }
    if (t.amountMinor < 0n) {
      throw new UnbalancedRuleError('sale', `a tender of ${t.amountMinor} on ${t.role} is negative`);
    }
    byRole.set(t.role, (byRole.get(t.role) ?? 0n) + t.amountMinor);
  }
  let tendered = 0n;
  for (const v of byRole.values()) tendered += v;
  if (tendered !== totalMinor) {
    // No plug, no suspense line: the document disagrees with itself and the
    // exception says so. Migration 0022 makes this unreachable for a sale
    // that committed; the check is here so the rule never depends on that.
    throw new UnbalancedRuleError('sale', `tenders sum to ${tendered} but the sale's total is ${totalMinor}`);
  }
  const onAccount = byRole.get('AR_TRADE') ?? 0n;
  if (onAccount > 0n && doc.customerId === undefined) {
    throw new UnbalancedRuleError('sale', 'an on-account tender with no customer cannot be posted to AR');
  }

  const at = doc.locationId;
  const scope = doc.productCategoryId === undefined ? {} : { productCategoryId: doc.productCategoryId };
  const customer =
    doc.customerId !== undefined
      ? { counterpartyKind: 'customer' as const, counterpartyId: doc.customerId }
      : {};

  const lines = live([
    // Rules 1 and 2: one debit per settlement role, in the catalogue's order.
    ...SETTLEMENT_ROLES.map((role) =>
      dr(role, at, byRole.get(role) ?? 0n, role === 'AR_TRADE' ? customer : {}),
    ),
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
    // Stable across the change from INFERRED to RECORDED tender: a sale that
    // charged an account is a credit sale, exactly as the sweep classified it
    // before tenders existed, so an exception opened under the old inference
    // is resolved by the same (source_kind, source_id) key.
    sourceKind: onAccount > 0n ? 'credit_sale' : 'cash_sale',
    sourceId: doc.saleId,
    documentDate: doc.businessDate,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Voids and returns (migration 0030) — 05 §5.3 and §5.6.2 rule 10
// ---------------------------------------------------------------------------

/**
 * A void or a return, as the ledger needs it. Every figure is a NON-NEGATIVE
 * magnitude of what is being reversed (0030's sign convention); `refunds` are
 * how the money went back, one part per role — Σ must equal the document's
 * total, which the database asserted at commit (SRET0006).
 */
export interface SaleReturnDocument {
  readonly returnId: string;
  readonly kind: 'VOID' | 'RETURN';
  /** The original sale's location: returns are taken there (SRET0001). */
  readonly locationId: string;
  readonly businessDate: string;
  readonly refunds: readonly SaleTenderPart[];
  readonly customerId?: string | undefined;
  readonly revenueMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxes: readonly SaleTaxComponent[];
  /** Cost of what came back. 0n while Q16 has no costing method (see the sweep). */
  readonly costMinor: bigint;
  readonly productCategoryId?: string | undefined;
}

function swapSides(lines: readonly ProposedLine[]): ProposedLine[] {
  return lines.map((l) => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor }));
}

/**
 * A VOID is the sale's own entry with the sides swapped — 05 §5.3: "a reversal
 * is generated, never hand-keyed: the same code path, run with the sides
 * swapped". It is computed from the VOID document's figures (which 0030's
 * SRET0014 pins to the original's exactly) rather than by `reverses_entry_id`
 * against the original's journal entry, so a void never waits on its sale's
 * posting and an exception on one cannot strand the other. The statement-
 * level result is the same and is tested: Σ(sale + void) = 0 on every
 * (role, location) pair. Gross sales fall by the voided sale — correct for a
 * sale rung in error, which never happened.
 *
 * A RETURN is rule 10: CONTRA-revenue, so gross sales stay recoverable.
 *
 *   Dr SALES_RETURNS — the revenue reversed, NET of its discount
 *   Dr OUTPUT_TAX    — one line per component, at the amounts charged
 *   Dr INVENTORY / Cr COGS — at cost (0 until Q16)
 *   Cr TILL_CASH / MOMO_WALLET / BANK / AR_TRADE — how the money went back
 *
 * NEEDS AN ACCOUNTANT (CLAUDE.md §2.8): whether a returned line's DISCOUNT
 * should instead credit SALES_DISCOUNT back (keeping SALES_RETURNS gross).
 * Either balances; this rule takes the simpler reading and names it.
 */
export function saleReturnEntry(doc: SaleReturnDocument): ProposedEntry {
  const taxTotal = doc.taxes.reduce((a, t) => a + t.taxMinor, 0n);
  const totalMinor = doc.revenueMinor - doc.discountMinor + taxTotal;
  if (totalMinor === 0n && doc.costMinor === 0n) {
    throw new UnbalancedRuleError('sale_return', 'a return with no value and no cost has nothing to post');
  }
  const byRole = new Map<SettlementRole, bigint>();
  for (const r of doc.refunds) {
    if (!isSettlementRole(r.role)) {
      throw new UnbalancedRuleError('sale_return', `refund role ${String(r.role)} is not a settlement role`);
    }
    if (r.amountMinor < 0n) {
      throw new UnbalancedRuleError('sale_return', `a refund of ${r.amountMinor} on ${r.role} is negative`);
    }
    byRole.set(r.role, (byRole.get(r.role) ?? 0n) + r.amountMinor);
  }
  let refunded = 0n;
  for (const v of byRole.values()) refunded += v;
  if (refunded !== totalMinor) {
    throw new UnbalancedRuleError('sale_return', `refunds sum to ${refunded} but the document's total is ${totalMinor}`);
  }

  if (doc.kind === 'VOID') {
    const original = saleEntry({
      saleId: doc.returnId,
      locationId: doc.locationId,
      businessDate: doc.businessDate,
      tenders: doc.refunds,
      customerId: doc.customerId,
      revenueMinor: doc.revenueMinor,
      discountMinor: doc.discountMinor,
      taxes: doc.taxes,
      costMinor: doc.costMinor,
      productCategoryId: doc.productCategoryId,
    });
    const lines = swapSides(original.lines);
    assertBalances('sale_void', lines);
    return { sourceKind: 'sale_void', sourceId: doc.returnId, documentDate: doc.businessDate, lines };
  }

  const onAccount = byRole.get('AR_TRADE') ?? 0n;
  if (onAccount > 0n && doc.customerId === undefined) {
    throw new UnbalancedRuleError('sale_return', 'an account credit with no customer cannot be posted to AR');
  }
  const at = doc.locationId;
  const scope = doc.productCategoryId === undefined ? {} : { productCategoryId: doc.productCategoryId };
  const customer =
    doc.customerId !== undefined ? { counterpartyKind: 'customer' as const, counterpartyId: doc.customerId } : {};
  const lines = live([
    dr('SALES_RETURNS', at, doc.revenueMinor - doc.discountMinor, scope),
    ...doc.taxes.map((t) => dr('OUTPUT_TAX', at, t.taxMinor, { memo: t.taxCode })),
    dr('INVENTORY', at, doc.costMinor, scope),
    cr('COGS', at, doc.costMinor, scope),
    ...SETTLEMENT_ROLES.map((role) => cr(role, at, byRole.get(role) ?? 0n, role === 'AR_TRADE' ? customer : {})),
  ]);
  assertBalances('sale_return', lines);
  return { sourceKind: 'sale_return', sourceId: doc.returnId, documentDate: doc.businessDate, lines };
}

// ---------------------------------------------------------------------------
// Rules 11 and 11b — closing a till
// ---------------------------------------------------------------------------

/**
 * A closed cash session, as the ledger needs it. Every figure is the SERVER's,
 * frozen on `app.cash_session` at close (migration 0020) — never the device's.
 */
export interface CashSessionCloseDocument {
  readonly sessionId: string;
  /** The outlet whose till this is. Every line lands here. */
  readonly locationId: string;
  readonly businessDate: string;
  /** Cash taken out of the drawer for the bank at close (rule 11). */
  readonly bankedMinor: bigint;
  /**
   * counted − expected (rule 11b). Negative is a SHORTAGE, positive an
   * OVERAGE. A session nobody counted (the midnight auto-close) has no
   * variance; the caller passes 0n, never a guess.
   */
  readonly varianceMinor: bigint;
}

/**
 * Rules 11 (leg 1) and 11b in ONE entry, because the close is one document
 * (05 §5.2.4) and both halves are facts about the same drawer at the same
 * moment.
 *
 *   Rule 11  — cash leaves the till for the bank:  Dr CASH_IN_TRANSIT / Cr TILL_CASH.
 *              A real asset in a real place. Leg 2 (rule 11a) — the bank
 *              credits the account — clears it, and is bank reconciliation's
 *              document, not the till's.
 *   Rule 11b — the count disagrees with what the drawer should hold:
 *              short:  Dr CASH_OVER_SHORT / Cr TILL_CASH
 *              over:   Dr TILL_CASH       / Cr CASH_OVER_SHORT   (the sign reverses)
 *
 * All at the counting location: a till count is an outlet activity (§5.6.2).
 * This rule does not compute the variance — the close did, and froze it.
 */
export function cashSessionCloseEntry(doc: CashSessionCloseDocument): ProposedEntry {
  if (doc.bankedMinor < 0n) {
    throw new UnbalancedRuleError('cash_session_close', `banked ${doc.bankedMinor} is negative`);
  }
  if (doc.bankedMinor === 0n && doc.varianceMinor === 0n) {
    throw new UnbalancedRuleError(
      'cash_session_close',
      'a till closed with nothing banked and no variance has nothing to post',
    );
  }
  const at = doc.locationId;
  const short = doc.varianceMinor < 0n ? -doc.varianceMinor : 0n;
  const over = doc.varianceMinor > 0n ? doc.varianceMinor : 0n;

  const lines = live([
    // Rule 11, leg 1.
    dr('CASH_IN_TRANSIT', at, doc.bankedMinor),
    cr('TILL_CASH', at, doc.bankedMinor, { memo: 'banked at close' }),
    // Rule 11b — a shortage.
    dr('CASH_OVER_SHORT', at, short),
    cr('TILL_CASH', at, short, { memo: 'count short' }),
    // Rule 11b — an overage.
    dr('TILL_CASH', at, over, { memo: 'count over' }),
    cr('CASH_OVER_SHORT', at, over),
  ]);

  assertBalances('cash_session_close', lines);
  return {
    sourceKind: 'cash_session_close',
    sourceId: doc.sessionId,
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

// ---------------------------------------------------------------------------
// Rule 9 — payroll, from the figures the bureau returned
// ---------------------------------------------------------------------------

/**
 * One employee's line in a pay period. EVERY `bureau*` figure below arrived
 * from the bureau; this module reads them and never derives one.
 */
export interface PayrollLine {
  readonly employeeId: string;
  /** The employee's OWN location. Rule 9b needs a clearing pair when somebody
   *  else pays them, precisely because the cost was raised here. */
  readonly locationId: string;
  /** base + overtime + allowances. Commission is its own line below. */
  readonly nonCommissionGrossMinor: bigint;
  readonly commissionMinor: bigint;
  readonly bureauEmployeeTaxMinor: bigint;
  readonly bureauEmployeeSocialMinor: bigint;
  readonly bureauOtherDeductionsMinor: bigint;
  readonly bureauEmployerSocialMinor: bigint;
  readonly bureauNetPayMinor: bigint;
}

export interface PayrollDocument {
  readonly payPeriodId: string;
  readonly businessDate: string;
  readonly lines: readonly PayrollLine[];
}

/**
 * Rule 9 — the payroll journal.
 *
 * EVERY CREDIT AMOUNT IS A BUREAU FIGURE. Nothing here computes a withholding,
 * and CLAUDE.md §2.4 makes that categorical in every jurisdiction. What this
 * function does is book numbers somebody else produced, which is exactly what
 * a ledger is for.
 *
 * THE EMPLOYER CONTRIBUTION IS A COMPANY EXPENSE and gets both an expense line
 * and its own payable — it is not an employee deduction and must not be netted
 * into one. Reading §2.4 as "so we do not need an employer social security
 * account" is a misreading: the prohibition is on computing the figure, not on
 * booking it, and omitting the account understates staff costs against the
 * model's per-outlet baselines.
 *
 * A PLEASING CONSEQUENCE OF THE SHAPE: this entry balances if and only if
 *
 *   gross === employee tax + employee social + other deductions + net pay
 *
 * for every employee — the bureau's own identity, which the import already
 * validated. So a file that slipped through validation cannot post: the
 * imbalance is caught by `assertBalances` here and again by Postgres at
 * COMMIT. The employer contribution appears on both sides and cancels, which
 * is what makes it a pass-through rather than a deduction.
 */
export function payrollEntry(doc: PayrollDocument): ProposedEntry {
  if (doc.lines.length === 0) {
    throw new UnbalancedRuleError('payroll', 'a pay period with no employees has nothing to post');
  }
  const lines: ProposedLine[] = [];
  for (const l of doc.lines) {
    const who = { counterpartyKind: 'employee' as const, counterpartyId: l.employeeId };
    lines.push(
      dr('STAFF_COST_GROSS', l.locationId, l.nonCommissionGrossMinor, who),
      dr('STAFF_COST_COMMISSION', l.locationId, l.commissionMinor, who),
      dr('STAFF_COST_EMPLOYER_SOCIAL', l.locationId, l.bureauEmployerSocialMinor, who),
      cr('EMPLOYEE_TAX_PAYABLE', l.locationId, l.bureauEmployeeTaxMinor),
      cr('EMPLOYEE_SOCIAL_PAYABLE', l.locationId, l.bureauEmployeeSocialMinor),
      cr('OTHER_DEDUCTIONS_PAYABLE', l.locationId, l.bureauOtherDeductionsMinor),
      cr('EMPLOYER_SOCIAL_PAYABLE', l.locationId, l.bureauEmployerSocialMinor),
      cr('NET_PAY_PAYABLE', l.locationId, l.bureauNetPayMinor, who),
    );
  }

  const kept = live(lines);
  assertBalances('payroll', kept);
  return {
    sourceKind: 'payroll',
    sourceId: doc.payPeriodId,
    documentDate: doc.businessDate,
    lines: kept,
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
