/**
 * THE POSTING SWEEP — settled sales and closed tills become journal entries.
 *
 * Building the ledger's read surface exposed that `postDocument` had NO
 * production caller: the engine, the rules and the statements were all real,
 * and no settled document ever reached them outside a test. Track A was
 * reported complete with that gap in it — this file is the correction, and
 * docs/phase3-status.md now records the miss rather than papering over it.
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────
 * Finds settled documents with no journal entry and posts each through the
 * ordinary engine. Everything the engine guarantees applies unchanged: a
 * failure opens a posting_exception and NEVER touches the document; a retry
 * that fails the same way updates the exception; a retry that succeeds
 * resolves it; a document already posted is a duplicate, not a second entry.
 *
 *   · `sweepSettledSales`       — rules 1, 1b, 2, 3. THE TENDER COMES FROM
 *     `app.sale_tender`, one debit per settlement role (migration 0021). It
 *     used to be INFERRED from whether a CHARGE credit entry named the sale,
 *     with everything else booked as till cash — which put every mobile-money
 *     and bank receipt in the drawer account, where momo reconciliation could
 *     never find it (05 §5.6.2 rule 4b's warning, made true by default).
 *   · `sweepClosedCashSessions` — rules 11 and 11b, from the figures the close
 *     froze on `app.cash_session` (migration 0020).
 *
 * ── WHAT IT DELIBERATELY DOES NOT HAVE ────────────────────────────────────
 * A schedule. There is still no nightly job anywhere in this system (a
 * recorded gap since Phase 1), and inventing a scheduler inside a sweep
 * would hide that. It runs when called: the dev script, the drill, a test,
 * and — once Track B exists — whatever scheduler the platform grows. Every
 * caller is visible.
 *
 * ── COGS IS ABSENT, AND THAT IS Q16'S GATE, NOT A BUG ─────────────────────
 * The sale rule takes a cost; costing at moving weighted average is a
 * METHOD DECISION the §2.8 accountant owns (open-questions Q16), and no
 * costing implementation exists. The sweep passes cost 0, `saleEntry` emits
 * no cost pair for it (tested behaviour), and every statement built from
 * these postings shows revenue with NO cost of sales. The draft-CoA review
 * document says this in bold: gross profit is not readable from these books
 * until Q16 is answered. Inventing a cost basis to make the statements look
 * finished would be the same defect as guessing a withholding figure.
 */
import type { PostingRunner, PostResult } from './engine.js';
import { postDocument, recordRuleFailure } from './engine.js';
import {
  cashSessionCloseEntry,
  isSettlementRole,
  saleEntry,
  saleReturnEntry,
  UnbalancedRuleError,
  type SaleTenderPart,
} from './rules.js';

export interface SweepOptions {
  readonly tenantId: string;
  readonly postedBy: string;
  readonly postingRuleVersion: number;
  /** Documents per invocation. The rest wait for the next call — visible, bounded. */
  readonly limit?: number;
}

export interface SweepResult {
  readonly examined: number;
  readonly posted: number;
  readonly duplicates: number;
  readonly exceptions: number;
  /** Per-sale outcomes, for the caller that wants to report. */
  readonly outcomes: readonly { saleId: string; result: PostResult }[];
}

export interface SessionSweepResult {
  readonly examined: number;
  readonly posted: number;
  readonly duplicates: number;
  readonly exceptions: number;
  readonly outcomes: readonly { sessionId: string; result: PostResult }[];
}

interface SaleRow {
  id: string;
  location_id: string;
  business_date: string;
  customer_id: string | null;
  subtotal_net_minor: string;
  discount_minor: string;
}

interface TaxRow {
  sale_id: string;
  tax_code: string;
  tax_minor: string;
}

interface TenderRow {
  sale_id: string;
  posting_role: string;
  amount_minor: string;
}

export async function sweepSettledSales(
  runner: PostingRunner,
  opts: SweepOptions,
): Promise<SweepResult> {
  // Read the worklist in one transaction; post each sale in its own, so one
  // bad mapping cannot roll back ninety-nine good postings.
  const { sales, taxes, tenders } = await runner.withTenant(opts.tenantId, async (tx) => {
    const s = await tx.query<SaleRow>(
      `select s.id, s.location_id, s.business_date::text, s.customer_id,
              s.subtotal_net_minor::text, s.discount_minor::text
         from app.sale s
        where s.deleted_at is null
          and s.voids_sale_id is null
          and not exists (
            select 1 from app.journal_entry je
             where je.source_id = s.id and je.reverses_entry_id is null)
        order by s.business_date, s.id
        limit $1`,
      [opts.limit ?? 500],
    );
    const ids = s.rows.map((r) => r.id);
    if (ids.length === 0) {
      return { sales: s.rows, taxes: [] as TaxRow[], tenders: [] as TenderRow[] };
    }
    const t = await tx.query<TaxRow>(
      `select sale_id, tax_code, sum(tax_minor)::bigint::text as tax_minor
         from app.sale_tax_line
        where sale_id = any($1::uuid[]) and deleted_at is null
        group by sale_id, tax_code
        order by sale_id, tax_code`,
      [ids],
    );
    // THE TENDER IS RECORDED, NOT INFERRED. One row per (sale, role): the
    // method's own name and code are the tenant's words and are never read.
    const tn = await tx.query<TenderRow>(
      `select st.sale_id, m.posting_role, sum(st.amount_minor)::bigint::text as amount_minor
         from app.sale_tender st
         join app.tender_method m on m.tenant_id = st.tenant_id and m.id = st.method_id
        where st.sale_id = any($1::uuid[])
        group by st.sale_id, m.posting_role
        order by st.sale_id, m.posting_role`,
      [ids],
    );
    return { sales: s.rows, taxes: t.rows, tenders: tn.rows };
  });

  const taxBySale = new Map<string, { taxCode: string; taxMinor: bigint }[]>();
  for (const t of taxes) {
    const list = taxBySale.get(t.sale_id) ?? [];
    list.push({ taxCode: t.tax_code, taxMinor: BigInt(t.tax_minor) });
    taxBySale.set(t.sale_id, list);
  }
  const tendersBySale = new Map<string, SaleTenderPart[]>();
  const badRoleBySale = new Map<string, string>();
  for (const t of tenders) {
    if (!isSettlementRole(t.posting_role)) {
      // Migration 0020's CHECK makes this unreachable; if it is ever reached
      // the sale must NOT post with the part silently dropped.
      badRoleBySale.set(t.sale_id, t.posting_role);
      continue;
    }
    const list = tendersBySale.get(t.sale_id) ?? [];
    list.push({ role: t.posting_role, amountMinor: BigInt(t.amount_minor) });
    tendersBySale.set(t.sale_id, list);
  }

  const outcomes: { saleId: string; result: PostResult }[] = [];
  let posted = 0;
  let duplicates = 0;
  let exceptions = 0;

  const postOpts = {
    tenantId: opts.tenantId,
    postedBy: opts.postedBy,
    postingRuleVersion: opts.postingRuleVersion,
  };
  for (const sale of sales) {
    let result: PostResult;
    try {
      const badRole = badRoleBySale.get(sale.id);
      if (badRole !== undefined) {
        throw new UnbalancedRuleError('sale', `sale ${sale.id} has a tender on role ${badRole}`);
      }
      // The customer rides along whenever the sale names one; the rule puts it
      // on the AR line and nowhere else, so a cash sale by a KNOWN customer
      // still debits the till where the money is.
      const doc = saleEntry({
        saleId: sale.id,
        locationId: sale.location_id,
        businessDate: sale.business_date,
        tenders: tendersBySale.get(sale.id) ?? [],
        ...(sale.customer_id !== null ? { customerId: sale.customer_id } : {}),
        revenueMinor: BigInt(sale.subtotal_net_minor),
        discountMinor: BigInt(sale.discount_minor),
        taxes: taxBySale.get(sale.id) ?? [],
        // Q16: no costing method exists. See the header — cost is OMITTED, not
        // estimated, and the statements say so.
        costMinor: 0n,
      });
      result = await postDocument(runner, doc, postOpts);
    } catch (err) {
      if (!(err instanceof UnbalancedRuleError)) throw err;
      result = await recordRuleFailure(runner, postOpts, {
        sourceKind: 'cash_sale',
        sourceId: sale.id,
        locationId: sale.location_id,
        documentDate: sale.business_date,
      }, err);
    }
    outcomes.push({ saleId: sale.id, result });
    if (result.status === 'posted') posted += 1;
    else if (result.status === 'duplicate') duplicates += 1;
    else exceptions += 1;
  }

  return { examined: sales.length, posted, duplicates, exceptions, outcomes };
}

export interface ReturnSweepResult {
  readonly examined: number;
  readonly posted: number;
  readonly duplicates: number;
  readonly exceptions: number;
  readonly outcomes: readonly { returnId: string; result: PostResult }[];
}

interface ReturnRow {
  id: string;
  kind: 'VOID' | 'RETURN';
  location_id: string;
  business_date: string;
  customer_id: string | null;
  subtotal_net_minor: string;
  discount_minor: string;
}

/**
 * Voids and returns (migration 0030) → a void's mirrored sale entry, or rule
 * 10's contra-revenue entry for a return (`saleReturnEntry`). The refund is
 * RECORDED on `app.sale_return_refund`, one part per role, exactly as a sale's
 * tender is — never inferred. Cost is 0 for the same Q16 reason as the sale
 * sweep: a return posts no COGS reversal until a costing method exists, which
 * keeps the two halves symmetric rather than reversing a cost never booked.
 */
export async function sweepSaleReturns(runner: PostingRunner, opts: SweepOptions): Promise<ReturnSweepResult> {
  const { docs, taxes, refunds } = await runner.withTenant(opts.tenantId, async (tx) => {
    const r = await tx.query<ReturnRow>(
      `select r.id, r.kind, r.location_id, r.business_date::text, r.customer_id,
              r.subtotal_net_minor::text, r.discount_minor::text
         from app.sale_return r
        where not exists (
            select 1 from app.journal_entry je
             where je.source_id = r.id and je.reverses_entry_id is null)
        order by r.business_date, r.id
        limit $1`,
      [opts.limit ?? 500],
    );
    const ids = r.rows.map((x) => x.id);
    if (ids.length === 0) return { docs: r.rows, taxes: [] as TaxRow[], refunds: [] as TenderRow[] };
    const t = await tx.query<TaxRow>(
      `select return_id as sale_id, tax_code, sum(tax_minor)::bigint::text as tax_minor
         from app.sale_return_tax_line where return_id = any($1::uuid[])
        group by return_id, tax_code order by return_id, tax_code`,
      [ids],
    );
    const rf = await tx.query<TenderRow>(
      `select rf.return_id as sale_id, m.posting_role, sum(rf.amount_minor)::bigint::text as amount_minor
         from app.sale_return_refund rf
         join app.tender_method m on m.tenant_id = rf.tenant_id and m.id = rf.method_id
        where rf.return_id = any($1::uuid[])
        group by rf.return_id, m.posting_role order by rf.return_id, m.posting_role`,
      [ids],
    );
    return { docs: r.rows, taxes: t.rows, refunds: rf.rows };
  });

  const taxBy = new Map<string, { taxCode: string; taxMinor: bigint }[]>();
  for (const t of taxes) {
    const list = taxBy.get(t.sale_id) ?? [];
    list.push({ taxCode: t.tax_code, taxMinor: BigInt(t.tax_minor) });
    taxBy.set(t.sale_id, list);
  }
  const refundBy = new Map<string, SaleTenderPart[]>();
  const badRoleBy = new Map<string, string>();
  for (const r of refunds) {
    if (!isSettlementRole(r.posting_role)) {
      badRoleBy.set(r.sale_id, r.posting_role);
      continue;
    }
    const list = refundBy.get(r.sale_id) ?? [];
    list.push({ role: r.posting_role, amountMinor: BigInt(r.amount_minor) });
    refundBy.set(r.sale_id, list);
  }

  const postOpts = { tenantId: opts.tenantId, postedBy: opts.postedBy, postingRuleVersion: opts.postingRuleVersion };
  const outcomes: { returnId: string; result: PostResult }[] = [];
  let posted = 0;
  let duplicates = 0;
  let exceptions = 0;
  for (const d of docs) {
    let result: PostResult;
    try {
      const badRole = badRoleBy.get(d.id);
      if (badRole !== undefined) throw new UnbalancedRuleError('sale_return', `return ${d.id} refunds on role ${badRole}`);
      const entry = saleReturnEntry({
        returnId: d.id,
        kind: d.kind,
        locationId: d.location_id,
        businessDate: d.business_date,
        refunds: refundBy.get(d.id) ?? [],
        ...(d.customer_id !== null ? { customerId: d.customer_id } : {}),
        revenueMinor: BigInt(d.subtotal_net_minor),
        discountMinor: BigInt(d.discount_minor),
        taxes: taxBy.get(d.id) ?? [],
        costMinor: 0n, // Q16 — see the header
      });
      result = await postDocument(runner, entry, postOpts);
    } catch (err) {
      if (!(err instanceof UnbalancedRuleError)) throw err;
      result = await recordRuleFailure(runner, postOpts, {
        sourceKind: d.kind === 'VOID' ? 'sale_void' : 'sale_return',
        sourceId: d.id,
        locationId: d.location_id,
        documentDate: d.business_date,
      }, err);
    }
    outcomes.push({ returnId: d.id, result });
    if (result.status === 'posted') posted += 1;
    else if (result.status === 'duplicate') duplicates += 1;
    else exceptions += 1;
  }
  return { examined: docs.length, posted, duplicates, exceptions, outcomes };
}

interface SessionRow {
  id: string;
  location_id: string;
  business_date: string;
  banked_minor: string | null;
  variance_minor: string | null;
}

/**
 * Closed tills → rules 11 and 11b.
 *
 * The worklist is CLOSED sessions with something to post — cash banked, or a
 * count that disagreed with the drawer. A till counted to the pesewa with
 * nothing banked is a document with no ledger consequence, and the rule
 * refuses to fabricate an entry for it; it is simply not on the list. An
 * auto-closed session (nobody counted) has no variance and posts only what
 * was banked, which for an auto-close is nothing.
 */
export async function sweepClosedCashSessions(
  runner: PostingRunner,
  opts: SweepOptions,
): Promise<SessionSweepResult> {
  const sessions = await runner.withTenant(opts.tenantId, async (tx) => {
    const res = await tx.query<SessionRow>(
      `select cs.id, cs.location_id, cs.business_date::text,
              cs.banked_minor::text, cs.variance_minor::text
         from app.cash_session cs
        where cs.status = 'CLOSED'
          and (coalesce(cs.banked_minor, 0) > 0 or coalesce(cs.variance_minor, 0) <> 0)
          and not exists (
            select 1 from app.journal_entry je
             where je.source_id = cs.id and je.reverses_entry_id is null)
        order by cs.business_date, cs.id
        limit $1`,
      [opts.limit ?? 500],
    );
    return res.rows;
  });

  const outcomes: { sessionId: string; result: PostResult }[] = [];
  let posted = 0;
  let duplicates = 0;
  let exceptions = 0;
  const postOpts = {
    tenantId: opts.tenantId,
    postedBy: opts.postedBy,
    postingRuleVersion: opts.postingRuleVersion,
  };
  for (const s of sessions) {
    let result: PostResult;
    try {
      const doc = cashSessionCloseEntry({
        sessionId: s.id,
        locationId: s.location_id,
        businessDate: s.business_date,
        bankedMinor: s.banked_minor === null ? 0n : BigInt(s.banked_minor),
        varianceMinor: s.variance_minor === null ? 0n : BigInt(s.variance_minor),
      });
      result = await postDocument(runner, doc, postOpts);
    } catch (err) {
      if (!(err instanceof UnbalancedRuleError)) throw err;
      result = await recordRuleFailure(runner, postOpts, {
        sourceKind: 'cash_session_close',
        sourceId: s.id,
        locationId: s.location_id,
        documentDate: s.business_date,
      }, err);
    }
    outcomes.push({ sessionId: s.id, result });
    if (result.status === 'posted') posted += 1;
    else if (result.status === 'duplicate') duplicates += 1;
    else exceptions += 1;
  }
  return { examined: sessions.length, posted, duplicates, exceptions, outcomes };
}
