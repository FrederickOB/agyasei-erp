/**
 * THE LEDGER, READABLE AT LAST.
 *
 * Phase 3 Track A built the journal, the statements and the close gate — all
 * of it in `packages/db`, none of it reachable from outside a test. That is
 * the exact shape of the eighteen built-but-never-wired defects in
 * docs/phase1-status.md §0, and this router is what stops the ledger becoming
 * the nineteenth: `@erp/db`'s statement functions, behind HTTP, behind a
 * capability.
 *
 * ── WHY EVERY PROCEDURE HERE IS `at: 'tenant'` ────────────────────────────
 * The books are a TENANT object, like the credit book (see credit.ts's
 * residency note): a trial balance spans every location by definition, and
 * "held somewhere" would let a grant made at one outlet read the whole
 * tenant's ledger. `gl.view` at the root of the location tree is the
 * location-scoped idiom for an object that has no location. The template
 * gives it to Accounts; the owner role reaches it through the owner
 * expansion; nobody else holds it.
 *
 * ── READ-ONLY, STRUCTURALLY ───────────────────────────────────────────────
 * Every procedure is a `.query()`. There is no mutation in this file and no
 * capability exists that would guard one — the journal is written by the
 * posting engine from settled documents, and posted entries are immutable
 * (migration 0015, ENABLE ALWAYS). The first manual-journal route, when
 * Track B needs one, arrives with its own capability and its own review.
 *
 * ── AN EMPTY LEDGER ANSWERS EMPTY ─────────────────────────────────────────
 * Until the §2.8 accountant review seeds a chart of accounts (Q6), a real
 * tenant has zero accounts and zero entries. Every read here returns the
 * empty shape with `accountCount: 0` alongside, so the client can say "there
 * is no chart of accounts yet" — a fact — rather than showing an error or,
 * worse, an all-zeroes statement that reads as a quiet month.
 *
 * Money leaves as decimal strings via wire(); timestamps leave as ISO strings
 * formatted in SQL (§0 row 16 — this file returns no JS Date, ever).
 */
import {
  listPostingExceptionsInput,
  statementQueryInput,
  wire,
} from '@erp/contracts';
import {
  balanceSheet,
  profitAndLoss,
  statementsReconcile,
  trialBalance,
  type StatementQuery,
  type StatementRow,
} from '@erp/db';
import { permissionProcedure, router } from '../trpc.js';

function toQuery(input: {
  periodIds?: readonly string[] | undefined;
  locationIds?: readonly string[] | undefined;
  byLocation: boolean;
}): StatementQuery {
  return {
    ...(input.periodIds === undefined ? {} : { periodIds: input.periodIds }),
    ...(input.locationIds === undefined ? {} : { locationIds: input.locationIds }),
    byLocation: input.byLocation,
  };
}

/** One statement row, every bigint stringified. */
function rowOut(r: StatementRow) {
  return {
    accountId: r.accountId,
    code: r.code,
    name: r.name,
    accountType: r.accountType,
    reportLineKey: r.reportLineKey,
    locationId: r.locationId,
    locationCode: r.locationCode,
    netDebitMinor: wire(r.netDebitMinor),
    amountMinor: wire(r.amountMinor),
  };
}

async function countAccounts(tx: {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}): Promise<number> {
  const r = await tx.query<{ n: string }>(`select count(*)::text n from app.gl_account`);
  return Number(r.rows[0]!.n);
}

export const ledgerRouter = router({
  /**
   * §5.9.2 — "the single most useful diagnostic in the system". Balanced per
   * tenant AND per location, and the per-location half is the one the
   * mis-attribution defect class is visible to.
   */
  trialBalance: permissionProcedure({ code: 'gl.view', at: 'tenant' })
    .input(statementQueryInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const tb = await trialBalance(tx, toQuery(input));
        return {
          accountCount: await countAccounts(tx),
          rows: tb.rows.map(rowOut),
          debitMinor: wire(tb.debitMinor),
          creditMinor: wire(tb.creditMinor),
          balanced: tb.balanced,
          byLocation: tb.byLocation.map((l) => ({
            locationId: l.locationId,
            debitMinor: wire(l.debitMinor),
            creditMinor: wire(l.creditMinor),
            balanced: l.balanced,
          })),
        };
      });
    }),

  profitAndLoss: permissionProcedure({ code: 'gl.view', at: 'tenant' })
    .input(statementQueryInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const pl = await profitAndLoss(tx, toQuery(input));
        return {
          accountCount: await countAccounts(tx),
          rows: pl.rows.map(rowOut),
          revenueMinor: wire(pl.revenueMinor),
          expenseMinor: wire(pl.expenseMinor),
          resultMinor: wire(pl.resultMinor),
        };
      });
    }),

  balanceSheet: permissionProcedure({ code: 'gl.view', at: 'tenant' })
    .input(statementQueryInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const [bs, agreement] = [
          await balanceSheet(tx, toQuery(input)),
          await statementsReconcile(tx, toQuery(input)),
        ];
        return {
          accountCount: await countAccounts(tx),
          rows: bs.rows.map(rowOut),
          assetMinor: wire(bs.assetMinor),
          liabilityMinor: wire(bs.liabilityMinor),
          equityMinor: wire(bs.equityMinor),
          /**
           * Assets − (liabilities + equity). NOT zero mid-year, correctly:
           * the period's profit sits in income and expense until year-end
           * close. `reconciles` asserts the identity that DOES hold every
           * day — that this gap equals the P&L result over the same scope —
           * so the client can say "the statements agree" without pretending
           * the balance sheet balances before close.
           */
          gapMinor: wire(bs.gapMinor),
          reconciles: agreement.reconciles,
          resultMinor: wire(agreement.resultMinor),
        };
      });
    }),

  /**
   * The close gate's population: settled documents with no journal entry.
   * §5.6.1's ruling made these VISIBLE instead of silent; this makes them
   * visible to a person rather than to a test.
   */
  postingExceptions: permissionProcedure({ code: 'gl.view', at: 'tenant' })
    .input(listPostingExceptionsInput)
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<{
          id: string;
          source_kind: string;
          source_id: string;
          location_id: string;
          document_date: string;
          posting_role: string | null;
          error_code: string;
          error_detail: string | null;
          severity: number;
          opened_at: string;
          resolved_at: string | null;
          resolution_note: string | null;
        }>(
          `select id, source_kind, source_id, location_id, document_date::text,
                  posting_role, error_code, error_detail, severity,
                  to_char(opened_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as opened_at,
                  to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as resolved_at,
                  resolution_note
             from app.posting_exception
            where ($1::boolean or resolved_at is null)
            order by resolved_at is null desc, severity, opened_at
            limit $2`,
          [input.includeResolved, input.limit],
        );
        const open = await tx.query<{ n: string }>(
          `select count(*)::text n from app.posting_exception where resolved_at is null`,
        );
        return {
          openCount: Number(open.rows[0]!.n),
          exceptions: res.rows.map((r) => ({
            exceptionId: r.id,
            sourceKind: r.source_kind,
            sourceId: r.source_id,
            locationId: r.location_id,
            documentDate: r.document_date,
            postingRole: r.posting_role,
            errorCode: r.error_code,
            errorDetail: r.error_detail,
            severity: r.severity,
            openedAt: r.opened_at,
            resolvedAt: r.resolved_at,
            resolutionNote: r.resolution_note,
          })),
        };
      });
    }),
});
