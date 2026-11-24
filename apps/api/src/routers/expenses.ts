/**
 * BUSINESS EXPENSES AND THE MANAGEMENT P&L SHEET — `expenses.*` (migration
 * 0033).
 *
 * The founder's ask: "add expenses too and calculate our actual P&L".
 *
 * ── WHAT THIS IS NOT, FIRST ──────────────────────────────────────────────
 * It is NOT the general ledger and nothing here writes to it. The chart of
 * accounts, account mappings, a costing method and any manual journal are
 * Track B, BLOCKED until a named qualified accountant exists (CLAUDE.md §2.8;
 * open-questions Q6, Q16; docs/phase3-status.md "Deliberately absent"). So:
 *
 *   · an expense is an OPERATIONAL RECORD, like payroll capture — no
 *     `app.journal_entry`, no `app.journal_line`, no posting rule, no
 *     `gl.post` capability. Nothing in this file names an account;
 *   · `profitSheet` is a MANAGEMENT P&L, computed from operational records
 *     (sales, the stock ledger's cost basis, recorded expenses) and labelled
 *     as such. The ledger statements (`ledger.*`) stay what they are.
 *
 * ── WHO ────────────────────────────────────────────────────────────────────
 *  · Reading (`list`, `profitSheet`): `gl.view` at the ROOT of the location
 *    tree — the Books audience. A management P&L carries every margin in the
 *    business, which is exactly what gl.view guards.
 *  · Recording and voiding: `expense.record` AT THE EXPENSE'S LOCATION, plus
 *    the token's location scope (the write-path rule in ../trpc.ts); for a
 *    whole-business expense (no location), at the root — tenant-wide, so a
 *    grant made at one outlet cannot book the head office's rent.
 *  · `categories`: `expense.record` anywhere — the people who fill the form.
 *
 * ── MONEY ──────────────────────────────────────────────────────────────────
 * An amount arrives as decimal TEXT in major units and becomes an exact
 * bigint of minor units against the tenant's pack (`parseMajorAmount`): never
 * through a float, never assuming 100, and a digit beyond the currency's
 * places is REFUSED rather than rounded. Every ratio is an integer × 10⁴.
 * Money leaves as decimal strings via wire(); no JS Date leaves this file.
 *
 * ── THE COST OF GOODS SOLD, HONESTLY ──────────────────────────────────────
 * Per (location, product): the weighted-average cost of that location's own
 * costed inbound movements (../cost-basis.ts — the same function the margin
 * report uses). Where a product SOLD in the period has no costed inbound
 * movement at that location, the tenant's STATED cost (`app.product_cost`,
 * 0032) is used instead, and the sheet says how much of COGS came from it.
 * Where there is neither, the product is NOT guessed at: it is listed in
 * `missingCost`, and `cogsComplete` is false — gross and net profit are then
 * overstated by that product's cost, and the screen says so.
 */
import { TRPCError } from '@trpc/server';
import {
  listExpensesInput,
  minorScaleDigits,
  parseMajorAmount,
  profitSheetInput,
  recordExpenseInput,
  voidExpenseInput,
} from '@erp/contracts';
import { deterministicUuid } from '@erp/db';
import { divRound } from '@erp/money';
import {
  COST_BASIS_SQL,
  periodSoldNet,
  valueAt,
  valueAtStatedCost,
  type CostBasisRow,
} from '../cost-basis.js';
import type { Queryable } from '../db.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import { assertLocationInScope, permissionProcedure, router, type PermissionState } from '../trpc.js';
import type { VerifiedIdentity } from '../auth.js';
import { wire } from '../wire.js';
import { loadSales } from './reports.js';
import { loadJurisdiction } from './sales.js';
import { resolveLocationScope } from './scope.js';

const CODE = 'expense.record';

/**
 * Where an expense may be booked: a place that trades or holds stock. A GROUP
 * node (a region) has no shelves and no till, and a TRANSIT node is goods in
 * motion; an expense of the business as a whole is booked with NO location.
 * These are the PLATFORM location kinds (04 §4.3), never tenant vocabulary.
 */
const EXPENSE_KINDS = ['OUTLET', 'WAREHOUSE'] as const;

/** An expense above this many minor units is a typo, not a payment. */
const MAX_AMOUNT_MINOR = 10n ** 15n;

const MANAGEMENT_NOTE =
  'Management figures from your sales, costs and recorded expenses — not the audited ledger.';

/** The location rule, stated once for both writes (see the header). */
function requireExpenseAuthority(
  permissions: PermissionState,
  identity: VerifiedIdentity,
  locationId: string | null,
): void {
  if (locationId === null) {
    permissions.requireTenantWide(CODE);
    return;
  }
  permissions.requireAt(CODE, locationId);
  assertLocationInScope(identity, locationId);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** What `record` answers — stored verbatim in write_log and replayed on retry. */
export interface RecordExpenseResponse {
  [key: string]: JsonValue;
  expenseId: string;
  expenseDate: string;
  locationId: string | null;
  categoryId: string;
  categoryName: string;
  categoryCreated: boolean;
  amountMinor: string;
  currencyCode: string;
  paidFrom: string;
}

export interface VoidExpenseResponse {
  [key: string]: JsonValue;
  voidId: string;
  expenseId: string;
  reason: string;
}

interface CategoryRow {
  id: string;
  name: string;
}

async function categoryByName(tx: Queryable, name: string): Promise<CategoryRow | undefined> {
  const res = await tx.query<CategoryRow>(
    `select id, name from app.expense_category
      where tenant_id = app.current_tenant() and deleted_at is null and lower(name) = lower($1)`,
    [name],
  );
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// The management P&L
// ---------------------------------------------------------------------------

interface ExpenseAggRow {
  location_id: string | null;
  category_id: string;
  category_name: string;
  sort_order: number;
  amount_minor: string;
}

/**
 * Live (un-voided) expenses in the range: at the scoped locations, and — only
 * when the request is the whole business — the ones booked to no location.
 * $1 from, $2 to, $3 location ids, $4 include whole-business expenses.
 */
const EXPENSE_PREDICATE = `
       e.tenant_id = app.current_tenant()
   and e.expense_date between $1::date and $2::date
   and not exists (select 1 from app.expense_void v
                    where v.tenant_id = e.tenant_id and v.expense_id = e.id)
   and (e.location_id = any($3::uuid[]) or ($4::boolean and e.location_id is null))
`;

const EXPENSES_BY_LOCATION_AND_CATEGORY_SQL = `
  select e.location_id, e.category_id, c.name as category_name, c.sort_order,
         sum(e.amount_minor)::bigint::text as amount_minor
    from app.expense e
    join app.expense_category c on c.tenant_id = e.tenant_id and c.id = e.category_id
   where ${EXPENSE_PREDICATE}
   group by e.location_id, e.category_id, c.name, c.sort_order
`;

/** The same predicate with no grouping — the independent half of the identity check. */
const EXPENSES_TOTAL_SQL = `
  select coalesce(sum(e.amount_minor), 0)::bigint::text as amount_minor
    from app.expense e
   where ${EXPENSE_PREDICATE}
`;

const EXPENSE_CURRENCIES_SQL = `
  select distinct e.currency_code::text as currency_code, e.money_scale::text as money_scale
    from app.expense e
   where ${EXPENSE_PREDICATE}
`;

interface CategoryLine {
  categoryId: string;
  categoryName: string;
  sortOrder: number;
  amountMinor: bigint;
}

interface Figures {
  netSalesMinor: bigint;
  cogsMinor: bigint;
  cogsAtStatedCostMinor: bigint;
  missingCostCount: number; // lint-money-ignore — a count of products, not minor units
  expenses: CategoryLine[];
}

function emptyFigures(): Figures {
  return { netSalesMinor: 0n, cogsMinor: 0n, cogsAtStatedCostMinor: 0n, missingCostCount: 0, expenses: [] };
}

function addExpense(lines: CategoryLine[], line: CategoryLine): void {
  const existing = lines.find((l) => l.categoryId === line.categoryId);
  if (existing) existing.amountMinor += line.amountMinor;
  else lines.push({ ...line });
}

function sortLines(lines: CategoryLine[]): CategoryLine[] {
  return [...lines].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      (a.categoryName.toLowerCase() < b.categoryName.toLowerCase() ? -1 : a.categoryName.toLowerCase() > b.categoryName.toLowerCase() ? 1 : 0),
  );
}

function totalOf(lines: readonly CategoryLine[]): bigint {
  return lines.reduce((a, l) => a + l.amountMinor, 0n);
}

/** Gross margin percent × 10⁴ (19.325% is 193250). Null without positive sales. */
function marginPctE4(netSales: bigint, grossProfit: bigint): string | null {
  return netSales > 0n ? wire(divRound(grossProfit * 1_000_000n, netSales, 'half-up')) : null;
}

function wireFigures(f: Figures) {
  const grossProfit = f.netSalesMinor - f.cogsMinor;
  const expenses = sortLines(f.expenses);
  const totalExpenses = totalOf(expenses);
  return {
    /** Ex-tax, after discounts, net of voids and returns. */
    netSalesMinor: wire(f.netSalesMinor),
    cogsMinor: wire(f.cogsMinor),
    /** The part of cogsMinor valued at the tenant's STATED cost (no costed receipt). */
    cogsAtStatedCostMinor: wire(f.cogsAtStatedCostMinor),
    /** False when a product sold in the period has no cost at all — COGS is understated. */
    cogsComplete: f.missingCostCount === 0,
    missingCostCount: f.missingCostCount,
    grossProfitMinor: wire(grossProfit),
    grossMarginPctE4: marginPctE4(f.netSalesMinor, grossProfit),
    expenses: expenses.map((l) => ({
      categoryId: l.categoryId,
      categoryName: l.categoryName,
      amountMinor: wire(l.amountMinor),
    })),
    totalExpensesMinor: wire(totalExpenses),
    netProfitMinor: wire(grossProfit - totalExpenses),
  };
}

function assertIdentity(label: string, partsSum: bigint, independentTotal: bigint): void {
  if (partsSum !== independentTotal) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        `REPORT_IDENTITY_VIOLATION: ${label} — the parts (${partsSum.toString(10)}) do not equal the ` +
        `independently aggregated total (${independentTotal.toString(10)}). Refusing to answer.`,
    });
  }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export const expensesRouter = router({
  /** The live categories, in the tenant's order. For the form's picker. */
  categories: permissionProcedure({ code: CODE, at: 'any' }).query(async ({ ctx }) => {
    return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
      const res = await tx.query<{ id: string; code: string | null; name: string; sort_order: number }>(
        `select id, code, name, sort_order
           from app.expense_category
          where tenant_id = app.current_tenant() and deleted_at is null and is_active
          order by sort_order, lower(name), id`,
      );
      return {
        categories: res.rows.map((r) => ({ categoryId: r.id, code: r.code, name: r.name, sortOrder: r.sort_order })),
      };
    });
  }),

  /** The period's expenses, newest first, voided ones included and marked. */
  list: permissionProcedure({ code: 'gl.view', at: 'tenant' })
    .input(listExpensesInput)
    .query(async ({ ctx, input }) => {
      const scope = await resolveLocationScope(ctx, {
        code: 'gl.view',
        widenCode: 'gl.view',
        requested: input.locationIds,
        kinds: EXPENSE_KINDS,
      });
      const wholeBusinessIncluded = input.locationIds === undefined;
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<{
          id: string;
          expense_date: string;
          location_id: string | null;
          location_code: string | null;
          location_name: string | null;
          category_id: string;
          category_name: string;
          amount_minor: string;
          currency_code: string;
          paid_from: string;
          payee: string | null;
          reference: string | null;
          note: string | null;
          recorded_by: string;
          recorded_by_name: string | null;
          recorded_at: string;
          void_reason: string | null;
          voided_by_name: string | null;
          voided_at: string | null;
        }>(
          `select e.id, e.expense_date::text as expense_date, e.location_id,
                  l.code as location_code, l.name as location_name,
                  e.category_id, c.name as category_name,
                  e.amount_minor::text as amount_minor, e.currency_code::text as currency_code,
                  e.paid_from, e.payee, e.reference, e.note,
                  e.recorded_by, ru.display_name as recorded_by_name,
                  to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as recorded_at,
                  v.reason as void_reason, vu.display_name as voided_by_name,
                  to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as voided_at
             from app.expense e
             join app.expense_category c on c.tenant_id = e.tenant_id and c.id = e.category_id
             left join app.location l on l.tenant_id = e.tenant_id and l.id = e.location_id
             left join app.expense_void v on v.tenant_id = e.tenant_id and v.expense_id = e.id
             left join app.user_account ru on ru.tenant_id = e.tenant_id and ru.id = e.recorded_by
             left join app.user_account vu on vu.tenant_id = v.tenant_id and vu.id = v.voided_by
            where e.tenant_id = app.current_tenant()
              and e.expense_date between $1::date and $2::date
              and (e.location_id = any($3::uuid[]) or ($4::boolean and e.location_id is null))
            order by e.expense_date desc, e.created_at desc, e.id`,
          [input.from, input.to, [...scope.locationIds], wholeBusinessIncluded],
        );
        return {
          from: input.from,
          to: input.to,
          wholeBusinessIncluded,
          expenses: res.rows.map((r) => ({
            expenseId: r.id,
            expenseDate: r.expense_date,
            locationId: r.location_id,
            locationCode: r.location_code,
            locationName: r.location_name,
            categoryId: r.category_id,
            categoryName: r.category_name,
            amountMinor: r.amount_minor,
            currencyCode: r.currency_code,
            paidFrom: r.paid_from,
            payee: r.payee,
            reference: r.reference,
            note: r.note,
            recordedBy: r.recorded_by,
            recordedByName: r.recorded_by_name,
            recordedAt: r.recorded_at,
            voided: r.voided_at !== null,
            voidReason: r.void_reason,
            voidedByName: r.voided_by_name,
            voidedAt: r.voided_at,
          })),
        };
      });
    }),

  record: permissionProcedure({ code: CODE, at: 'any' })
    .input(recordExpenseInput)
    .mutation(async ({ ctx, input }) => {
      requireExpenseAuthority(ctx.permissions, ctx.identity, input.locationId);
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const result = await runIdempotent<RecordExpenseResponse>(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'expense.record',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: input.locationId,
        },
        input,
        async (tx) => {
          const pack = await loadJurisdiction(tx);
          const digits = minorScaleDigits(pack.minorUnitsPerMajor);
          if (digits === null) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message:
                `CURRENCY_SCALE: ${pack.currencyCode} has ${pack.minorUnitsPerMajor.toString(10)} minor units ` +
                'per major unit, which is not a power of ten, so an amount cannot be typed as a decimal.',
            });
          }
          const amountMinor = parseMajorAmount(input.amount, pack.minorUnitsPerMajor);
          if (amountMinor === null) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `AMOUNT_SCALE: ${input.amount} has more decimal places than ${pack.currencyCode} carries (${String(digits)}).`,
            });
          }
          if (amountMinor <= 0n) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'AMOUNT_NOT_POSITIVE: an expense is an amount above zero.' });
          }
          if (amountMinor > MAX_AMOUNT_MINOR) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'AMOUNT_TOO_LARGE: that amount is not a plausible single expense.' });
          }

          if (input.locationId !== null) {
            const loc = await tx.query<{ kind: string }>(
              `select kind from app.location
                where tenant_id = app.current_tenant() and id = $1 and deleted_at is null`,
              [input.locationId],
            );
            const kind = loc.rows[0]?.kind;
            if (kind === undefined || !(EXPENSE_KINDS as readonly string[]).includes(kind)) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message:
                  'NOT_AN_EXPENSE_LOCATION: an expense is booked at an outlet or a warehouse, or to the whole business.',
              });
            }
          }

          let category: CategoryRow;
          let categoryCreated = false;
          if ('id' in input.category) {
            const found = await tx.query<CategoryRow>(
              `select id, name from app.expense_category
                where tenant_id = app.current_tenant() and id = $1 and deleted_at is null`,
              [input.category.id],
            );
            if (found.rows[0] === undefined) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'UNKNOWN_CATEGORY: no such expense category.' });
            }
            category = found.rows[0];
          } else {
            const existing = await categoryByName(tx, input.category.name);
            if (existing !== undefined) {
              category = existing;
            } else {
              // A new category, created with this expense in one transaction.
              // Its id is derived from the idempotency key, so a replayed plan
              // names the same row.
              category = { id: deterministicUuid(key, 'expense_category', 'new'), name: input.category.name };
              categoryCreated = true;
            }
          }

          const response: RecordExpenseResponse = {
            expenseId: key,
            expenseDate: input.expenseDate,
            locationId: input.locationId,
            categoryId: category.id,
            categoryName: category.name,
            categoryCreated,
            amountMinor: wire(amountMinor),
            currencyCode: pack.currencyCode,
            paidFrom: input.paidFrom,
          };
          return {
            response,
            apply: async (atx) => {
              const clock = ctx.deps.clock;
              if (categoryCreated) {
                await atx.query(
                  `insert into app.expense_category (tenant_id, id, write_id, hlc, name, sort_order, is_active)
                   values ($1, $2, $3, $4, $5, 0, true)`,
                  [tenantId, category.id, key, clock.next(), category.name],
                );
              }
              await atx.query(
                `insert into app.expense
                   (tenant_id, id, write_id, hlc, location_id, category_id, expense_date, amount_minor,
                    currency_code, money_scale, paid_from, payee, reference, note, recorded_by)
                 values ($1, $2, $3, $4, $5, $6, $7::date, $8::bigint, $9, $10::bigint, $11, $12, $13, $14, $15)`,
                [
                  tenantId, key, key, clock.next(), input.locationId, category.id, input.expenseDate,
                  wire(amountMinor), pack.currencyCode, wire(pack.minorUnitsPerMajor), input.paidFrom,
                  input.payee ?? null, input.reference ?? null, input.note ?? null, ctx.identity.userId,
                ],
              );
            },
          };
        },
      );
      return result.response;
    }),

  /** A correction: void (with a reason) and record again. Never an edit. */
  void: permissionProcedure({ code: CODE, at: 'any' })
    .input(voidExpenseInput)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.identity.tenantId;
      // The expense names the place; load it (under RLS — another tenant's id
      // resolves to nothing, exactly like an id that exists nowhere) before
      // the pipeline opens its own transaction.
      const target = await ctx.deps.runner.withTenant(tenantId, async (tx) =>
        (
          await tx.query<{ id: string; location_id: string | null }>(
            `select id, location_id from app.expense where tenant_id = app.current_tenant() and id = $1`,
            [input.expenseId],
          )
        ).rows[0],
      );
      if (target === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'UNKNOWN_EXPENSE: no such expense.' });
      }
      requireExpenseAuthority(ctx.permissions, ctx.identity, target.location_id);

      const key = input.idempotencyKey;
      const result = await runIdempotent<VoidExpenseResponse>(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'expense.void',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: target.location_id,
        },
        input,
        async (tx) => {
          const prior = await tx.query<{ voided_at: string }>(
            `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as voided_at
               from app.expense_void where tenant_id = app.current_tenant() and expense_id = $1`,
            [input.expenseId],
          );
          if (prior.rows[0] !== undefined) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: `ALREADY_VOIDED: this expense was voided on ${prior.rows[0].voided_at}. Record it again if it was paid.`,
            });
          }
          const response: VoidExpenseResponse = { voidId: key, expenseId: input.expenseId, reason: input.reason };
          return {
            response,
            apply: async (atx) => {
              await atx.query(
                `insert into app.expense_void (tenant_id, id, write_id, hlc, expense_id, reason, voided_by)
                 values ($1, $2, $3, $4, $5, $6, $7)`,
                [tenantId, key, key, ctx.deps.clock.next(), input.expenseId, input.reason, ctx.identity.userId],
              );
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * The management P&L, consolidated AND per location, for an inclusive
   * business-date range:
   *
   *   Sales (ex-tax, after discounts, net of voids and returns)
   * − Cost of goods sold (WAC; stated cost where no costed receipt; missing listed)
   * = Gross profit (and margin % × 10⁴)
   * − Operating expenses by category (voided excluded)
   * = Net profit
   *
   * Whole-business expenses (no location) appear ONLY in the consolidated
   * figure, and only when the request is the whole business — they belong to
   * no one location, so a filtered sheet leaves them out and says so.
   */
  profitSheet: permissionProcedure({ code: 'gl.view', at: 'tenant' })
    .input(profitSheetInput)
    .query(async ({ ctx, input }) => {
      const scope = await resolveLocationScope(ctx, {
        code: 'gl.view',
        widenCode: 'gl.view',
        requested: input.locationIds,
        kinds: EXPENSE_KINDS,
      });
      const wholeBusinessIncluded = input.locationIds === undefined;
      const ids = [...scope.locationIds];

      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const pack = await loadJurisdiction(tx);
        const sales = await loadSales(tx, ids, input.from, input.to);
        const basisRows = (await tx.query<CostBasisRow>(COST_BASIS_SQL, [ids, input.from, input.to])).rows;

        // Products that SOLD at a location with no costed inbound movement there.
        const uncosted = basisRows.filter((r) => BigInt(r.costed_in_qty) === 0n && periodSoldNet(r) > 0n);
        const uncostedProductIds = [...new Set(uncosted.map((r) => r.product_id))];
        const stated = new Map<string, bigint>();
        const products = new Map<string, { sku_code: string; name: string; uom_code: string }>();
        if (uncostedProductIds.length > 0) {
          for (const r of (
            await tx.query<{ product_id: string; cost_e4: string }>(
              `select product_id, cost_e4::text as cost_e4 from app.product_cost
                where tenant_id = app.current_tenant() and deleted_at is null and product_id = any($1::uuid[])`,
              [uncostedProductIds],
            )
          ).rows) {
            stated.set(r.product_id, BigInt(r.cost_e4));
          }
          for (const r of (
            await tx.query<{ id: string; sku_code: string; name: string; uom_code: string }>(
              `select p.id, p.sku_code, p.name, u.code as uom_code
                 from app.product p
                 join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
                where p.tenant_id = app.current_tenant() and p.id = any($1::uuid[])`,
              [uncostedProductIds],
            )
          ).rows) {
            products.set(r.id, r);
          }
        }

        const perLocation = new Map<string, Figures>();
        const figuresAt = (locationId: string): Figures => {
          let f = perLocation.get(locationId);
          if (!f) {
            f = emptyFigures();
            perLocation.set(locationId, f);
          }
          return f;
        };

        // Sales — the reports' own loader, with its own Σ(locations) = total check.
        for (const [locationId, s] of sales.byLocation) {
          figuresAt(locationId).netSalesMinor = s.subtotalNetMinor - s.discountMinor;
        }

        // Cost of goods sold, one rounding per (location, product) figure.
        const missing = new Map<
          string,
          { productId: string; qtyScale: number; qtySold: bigint; byLocation: { locationId: string; qtySold: bigint }[] }
        >();
        for (const row of basisRows) {
          const soldNet = periodSoldNet(row);
          if (soldNet <= 0n) continue;
          const f = figuresAt(row.location_id);
          if (BigInt(row.costed_in_qty) > 0n) {
            f.cogsMinor += valueAt(row, soldNet);
            continue;
          }
          const costE4 = stated.get(row.product_id);
          if (costE4 !== undefined) {
            const v = valueAtStatedCost(soldNet, row.qty_scale, costE4);
            f.cogsMinor += v;
            f.cogsAtStatedCostMinor += v;
            continue;
          }
          // Neither: counted and listed, never guessed.
          f.missingCostCount += 1;
          const m = missing.get(row.product_id);
          if (m) {
            m.qtySold += soldNet;
            m.byLocation.push({ locationId: row.location_id, qtySold: soldNet });
          } else {
            missing.set(row.product_id, {
              productId: row.product_id,
              qtyScale: row.qty_scale,
              qtySold: soldNet,
              byLocation: [{ locationId: row.location_id, qtySold: soldNet }],
            });
          }
        }

        // Expenses, with the identity check against an independent total.
        const params = [input.from, input.to, ids, wholeBusinessIncluded];
        const currencies = (await tx.query<{ currency_code: string; money_scale: string }>(EXPENSE_CURRENCIES_SQL, params)).rows;
        if (
          currencies.some(
            (c) => c.currency_code !== pack.currencyCode || BigInt(c.money_scale) !== pack.minorUnitsPerMajor,
          )
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'CURRENCY_MISMATCH: some expenses in this period were recorded in a currency or minor-unit scale ' +
              'other than the tenant’s current one, and cannot be added to its sales.',
          });
        }
        const expenseRows = (await tx.query<ExpenseAggRow>(EXPENSES_BY_LOCATION_AND_CATEGORY_SQL, params)).rows;
        const expenseTotal = BigInt(
          (await tx.query<{ amount_minor: string }>(EXPENSES_TOTAL_SQL, params)).rows[0]!.amount_minor,
        );
        const wholeBusiness: CategoryLine[] = [];
        for (const r of expenseRows) {
          const line: CategoryLine = {
            categoryId: r.category_id,
            categoryName: r.category_name,
            sortOrder: r.sort_order,
            amountMinor: BigInt(r.amount_minor),
          };
          if (r.location_id === null) addExpense(wholeBusiness, line);
          else addExpense(figuresAt(r.location_id).expenses, line);
        }

        // Consolidated: the sum of the locations, plus the whole business.
        const consolidated = emptyFigures();
        consolidated.netSalesMinor = sales.total.subtotalNetMinor - sales.total.discountMinor;
        for (const f of perLocation.values()) {
          consolidated.cogsMinor += f.cogsMinor;
          consolidated.cogsAtStatedCostMinor += f.cogsAtStatedCostMinor;
          consolidated.missingCostCount += f.missingCostCount;
          for (const l of f.expenses) addExpense(consolidated.expenses, l);
        }
        for (const l of wholeBusiness) addExpense(consolidated.expenses, l);
        assertIdentity('profitSheet.totalExpensesMinor', totalOf(consolidated.expenses), expenseTotal);
        assertIdentity(
          'profitSheet.netSalesMinor',
          [...perLocation.values()].reduce((a, f) => a + f.netSalesMinor, 0n),
          consolidated.netSalesMinor,
        );

        return {
          from: input.from,
          to: input.to,
          currencyCode: pack.currencyCode,
          basis: 'MANAGEMENT',
          note: MANAGEMENT_NOTE,
          scope: { network: scope.network, locationCount: scope.locations.length },
          wholeBusinessIncluded,
          consolidated: wireFigures(consolidated),
          wholeBusiness: wholeBusinessIncluded
            ? {
                expenses: sortLines(wholeBusiness).map((l) => ({
                  categoryId: l.categoryId,
                  categoryName: l.categoryName,
                  amountMinor: wire(l.amountMinor),
                })),
                totalExpensesMinor: wire(totalOf(wholeBusiness)),
              }
            : null,
          locations: scope.locations.map((l) => ({
            locationId: l.id,
            locationCode: l.code,
            locationName: l.name,
            kind: l.kind,
            ...wireFigures(perLocation.get(l.id) ?? emptyFigures()),
          })),
          missingCost: [...missing.values()]
            .map((m) => {
              const p = products.get(m.productId);
              return {
                productId: m.productId,
                skuCode: p?.sku_code ?? '',
                productName: p?.name ?? '',
                uomCode: p?.uom_code ?? '',
                qtyScale: m.qtyScale,
                /** Net quantity sold in the period, at qtyScale, in the stocking unit. */
                qtySold: wire(m.qtySold),
                /** The same, per location it sold at with no cost. Sums to qtySold. */
                byLocation: m.byLocation.map((b) => ({ locationId: b.locationId, qtySold: wire(b.qtySold) })),
              };
            })
            .sort((a, b) => (a.skuCode < b.skuCode ? -1 : a.skuCode > b.skuCode ? 1 : 0)),
          method:
            'Sales are ex-tax, after discounts, net of voids and returns, by business date. Cost of goods sold is ' +
            'the weighted-average cost of each location’s own costed receipts; where a product sold with no costed ' +
            'receipt at that location, its stated cost price is used. Expenses are the recorded, un-voided ones.',
        };
      });
    }),
});
