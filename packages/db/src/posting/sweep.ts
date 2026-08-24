/**
 * THE POSTING SWEEP — settled sales become journal entries, at last.
 *
 * Building the ledger's read surface exposed that `postDocument` had NO
 * production caller: the engine, the rules and the statements were all real,
 * and no settled document ever reached them outside a test. Track A was
 * reported complete with that gap in it — this file is the correction, and
 * docs/phase3-status.md now records the miss rather than papering over it.
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────
 * Finds settled sales with no journal entry and posts each through the
 * ordinary engine. Everything the engine guarantees applies unchanged: a
 * failure opens a posting_exception and NEVER touches the sale; a retry that
 * fails the same way updates the exception; a retry that succeeds resolves
 * it; a sale already posted is a duplicate, not a second entry.
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
import { postDocument } from './engine.js';
import { saleEntry } from './rules.js';

export interface SweepOptions {
  readonly tenantId: string;
  readonly postedBy: string;
  readonly postingRuleVersion: number;
  /** Sales per invocation. The rest wait for the next call — visible, bounded. */
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

interface SaleRow {
  id: string;
  location_id: string;
  business_date: string;
  customer_id: string | null;
  subtotal_net_minor: string;
  discount_minor: string;
  /** True iff a CHARGE credit entry names this sale — the tender's ground truth. */
  is_credit: boolean;
}

interface TaxRow {
  sale_id: string;
  tax_code: string;
  tax_minor: string;
}

export async function sweepSettledSales(
  runner: PostingRunner,
  opts: SweepOptions,
): Promise<SweepResult> {
  // Read the worklist in one transaction; post each sale in its own, so one
  // bad mapping cannot roll back ninety-nine good postings.
  const { sales, taxes } = await runner.withTenant(opts.tenantId, async (tx) => {
    const s = await tx.query<SaleRow>(
      `select s.id, s.location_id, s.business_date::text, s.customer_id,
              s.subtotal_net_minor::text, s.discount_minor::text,
              exists (select 1 from app.credit_entry ce
                       where ce.source_kind = 'SALE' and ce.source_id = s.id
                         and ce.kind = 'CHARGE' and ce.deleted_at is null) as is_credit
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
    const t = ids.length === 0
      ? { rows: [] as TaxRow[] }
      : await tx.query<TaxRow>(
          `select sale_id, tax_code, sum(tax_minor)::text as tax_minor
             from app.sale_tax_line
            where sale_id = any($1::uuid[]) and deleted_at is null
            group by sale_id, tax_code
            order by sale_id, tax_code`,
          [ids],
        );
    return { sales: s.rows, taxes: t.rows };
  });

  const taxBySale = new Map<string, { taxCode: string; taxMinor: bigint }[]>();
  for (const t of taxes) {
    const list = taxBySale.get(t.sale_id) ?? [];
    list.push({ taxCode: t.tax_code, taxMinor: BigInt(t.tax_minor) });
    taxBySale.set(t.sale_id, list);
  }

  const outcomes: { saleId: string; result: PostResult }[] = [];
  let posted = 0;
  let duplicates = 0;
  let exceptions = 0;

  for (const sale of sales) {
    // THE TENDER COMES FROM THE CHARGE, NOT FROM customer_id. A cash sale by
    // a KNOWN customer stores customer_id too — inferring credit from it
    // would debit AR for money already in the till: books that balance
    // perfectly while a receivable nobody owes ages forever, the exact
    // mis-attribution class rule 4 exists to prevent. The ground truth is
    // whether the sale raised a CHARGE on the customer's account, and that is
    // what `is_credit` reads.
    const doc = saleEntry({
      saleId: sale.id,
      locationId: sale.location_id,
      businessDate: sale.business_date,
      tender: sale.is_credit ? 'CREDIT' : 'CASH',
      ...(sale.is_credit && sale.customer_id !== null ? { customerId: sale.customer_id } : {}),
      revenueMinor: BigInt(sale.subtotal_net_minor),
      discountMinor: BigInt(sale.discount_minor),
      taxes: taxBySale.get(sale.id) ?? [],
      // Q16: no costing method exists. See the header — cost is OMITTED, not
      // estimated, and the statements say so.
      costMinor: 0n,
    });
    const result = await postDocument(runner, doc, {
      tenantId: opts.tenantId,
      postedBy: opts.postedBy,
      postingRuleVersion: opts.postingRuleVersion,
    });
    outcomes.push({ saleId: sale.id, result });
    if (result.status === 'posted') posted += 1;
    else if (result.status === 'duplicate') duplicates += 1;
    else exceptions += 1;
  }

  return { examined: sales.length, posted, duplicates, exceptions, outcomes };
}
