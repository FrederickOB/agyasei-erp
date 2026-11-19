/**
 * OPENING STOCK, FROM A FILE — `openingStock.preview` and `openingStock.commit`
 * (migration 0031; open-questions Q20, shaped by Q21's "no trading yet").
 *
 * HQ's laptop job before go-live: upload one CSV, read every row's verdict,
 * then load the whole file as `OPENING` stock movements in ONE idempotent
 * import. All or nothing — a file with any bad row loads nothing, because a
 * half-loaded opening balance is a stock position nobody can reason about.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 * It is not the GL opening balance. Nothing here posts, maps or names an
 * account — that is the accountant's, Track B (phase2-gate §4.3 (d)). An
 * OPENING movement has no journal consequence anywhere in this system.
 *
 * ── ONCE ──────────────────────────────────────────────────────────────────
 *  · The same rows uploaded twice (another tab, a re-click, a new key) are
 *    recognised by their content hash, per tenant, and load nothing again:
 *    the answer names the first import.
 *  · A (location, product) that already holds ANY opening movement is
 *    refused row by row: a second opening is a correction (`stock.adjust`).
 *  · The commit rides the idempotent pipeline: a retried request with the
 *    same key replays the stored answer verbatim.
 *
 * ── QUANTITIES ARE EXACT ─────────────────────────────────────────────────
 * Parsed from decimal TEXT into a scaled integer at the stocking unit's own
 * scale (`parseScaledDecimal`), never through a float; a digit beyond the
 * scale is refused, not rounded (ADR-0004; CLAUDE.md §2.3).
 *
 * ── WHO ────────────────────────────────────────────────────────────────────
 * `stock.opening.import` — sensitive, fresh, never offline — held AT EACH
 * ROW'S LOCATION. A row at a location the caller cannot load is reported
 * `NOT_PERMITTED` in the preview and refuses the commit.
 */
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import {
  canonicalOpeningRows,
  commitOpeningStockInput,
  parseOpeningStockCsv,
  parseScaledDecimal,
  previewOpeningStockInput,
  type OpeningRowIssue,
  type ParsedOpeningRow,
} from '@erp/contracts';
import { deterministicUuid } from '@erp/db';
import type { Queryable } from '../db.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import { permissionProcedure, router, type PermissionState } from '../trpc.js';
import { wire } from '../wire.js';

const CODE = 'stock.opening.import';
const REASON = { code: 'OPENING_BALANCE', name: 'Opening stock at go-live' } as const;
const E4 = 10_000n;
const INSERT_CHUNK = 1_000;

interface CheckedRow {
  lineNo: number;
  skuCode: string;
  locationCode: string;
  quantityText: string;
  unitCostText: string | null;
  issues: OpeningRowIssue[];
  /** Resolved, when the row is good. */
  productId: string | null;
  locationId: string | null;
  uomId: string | null;
  uomCode: string | null;
  qtyScale: number | null;
  qtyScaled: bigint | null;
  unitCostE4: bigint | null;
}

interface CheckedFile {
  contentSha256: string;
  rows: CheckedRow[];
  previous: { importId: string; asOfDate: string; rowCount: number } | null;
}

async function checkFile(
  tx: Queryable,
  permissions: PermissionState,
  rows: readonly ParsedOpeningRow[],
): Promise<CheckedFile> {
  const contentSha256 = createHash('sha256').update(canonicalOpeningRows(rows)).digest('hex');
  const prior = await tx.query<{ id: string; as_of_date: string; row_count: number }>(
    `select id, as_of_date::text, row_count from app.opening_stock_import where content_sha256 = $1`,
    [contentSha256],
  );
  const products = new Map(
    (
      await tx.query<{ id: string; sku_code: string; stock_tracking: string; uom_id: string; uom_code: string; qty_scale: number }>(
        `select p.id, p.sku_code, p.stock_tracking, p.stocking_uom_id as uom_id, u.code as uom_code, u.qty_scale
           from app.product p
           join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
          where p.deleted_at is null and p.sku_code = any($1::text[])`,
        [[...new Set(rows.map((r) => r.skuCode))]],
      )
    ).rows.map((p) => [p.sku_code, p]),
  );
  const locations = new Map(
    (
      await tx.query<{ id: string; code: string; kind: string }>(
        `select id, code, kind from app.location where deleted_at is null and code = any($1::text[])`,
        [[...new Set(rows.map((r) => r.locationCode))]],
      )
    ).rows.map((l) => [l.code, l]),
  );
  const opened = new Set(
    (
      await tx.query<{ k: string }>(
        `select distinct location_id::text || ':' || product_id::text as k
           from app.stock_movement where source_kind = 'OPENING'`,
      )
    ).rows.map((r) => r.k),
  );
  const permitted = new Set(permissions.locationsFor(CODE));

  const checked = rows.map((r): CheckedRow => {
    const issues: OpeningRowIssue[] = [...r.issues];
    const product = products.get(r.skuCode);
    const location = locations.get(r.locationCode);
    if (r.skuCode !== '' && !product) issues.push('UNKNOWN_SKU');
    if (r.locationCode !== '' && !location) issues.push('UNKNOWN_LOCATION');
    if (location && location.kind !== 'OUTLET' && location.kind !== 'WAREHOUSE') issues.push('NOT_A_STOCK_LOCATION');
    if (product && product.stock_tracking !== 'STOCKED') issues.push('NOT_STOCKED');
    let qtyScaled: bigint | null = null;
    if (product && !issues.includes('BAD_QUANTITY') && r.quantityText !== '') {
      qtyScaled = parseScaledDecimal(r.quantityText, product.qty_scale);
      if (qtyScaled === null) issues.push('BAD_QUANTITY_SCALE');
      else if (qtyScaled <= 0n) issues.push('BAD_QUANTITY');
    }
    if (product && location && opened.has(`${location.id}:${product.id}`)) issues.push('ALREADY_OPENED');
    if (location && !permitted.has(location.id)) issues.push('NOT_PERMITTED');
    return {
      lineNo: r.lineNo,
      skuCode: r.skuCode,
      locationCode: r.locationCode,
      quantityText: r.quantityText,
      unitCostText: r.unitCostText,
      issues,
      productId: product?.id ?? null,
      locationId: location?.id ?? null,
      uomId: product?.uom_id ?? null,
      uomCode: product?.uom_code ?? null,
      qtyScale: product?.qty_scale ?? null,
      qtyScaled: issues.length === 0 ? qtyScaled : null,
      unitCostE4: r.unitCostText === null || issues.includes('BAD_UNIT_COST') ? null : BigInt(r.unitCostText) * E4,
    };
  });
  const p = prior.rows[0];
  return {
    contentSha256,
    rows: checked,
    previous: p === undefined ? null : { importId: p.id, asOfDate: p.as_of_date, rowCount: p.row_count },
  };
}

function rowView(r: CheckedRow) {
  return {
    lineNo: r.lineNo,
    skuCode: r.skuCode,
    locationCode: r.locationCode,
    quantityText: r.quantityText,
    /** The exact scaled integer that would be stored, at `qtyScale`. Null when the row is bad. */
    qtyScaled: r.qtyScaled === null ? null : wire(r.qtyScaled),
    qtyScale: r.qtyScale,
    uomCode: r.uomCode,
    unitCostMinor: r.unitCostText,
    issues: r.issues,
  };
}

function summarise(rows: readonly CheckedRow[]) {
  const good = rows.filter((r) => r.issues.length === 0);
  return {
    rowCount: rows.length,
    goodCount: good.length,
    badCount: rows.length - good.length,
    locationCount: new Set(good.map((r) => r.locationId)).size,
    productCount: new Set(good.map((r) => r.productId)).size,
  };
}

export const openingStockRouter = router({
  /**
   * The dry run. A MUTATION only because a file does not fit in a GET's
   * query string; it writes nothing and takes no idempotency key.
   */
  preview: permissionProcedure({ code: CODE, at: 'any' })
    .input(previewOpeningStockInput)
    .mutation(async ({ ctx, input }) => {
      const parsed = parseOpeningStockCsv(input.csv);
      if (parsed.fileError !== null) {
        return { fileError: parsed.fileError, asOfDate: input.asOfDate, contentSha256: null, previous: null, summary: null, rows: [] };
      }
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const file = await checkFile(tx, ctx.permissions, parsed.rows);
        return {
          fileError: null,
          asOfDate: input.asOfDate,
          contentSha256: file.contentSha256,
          previous: file.previous,
          summary: summarise(file.rows),
          rows: file.rows.map(rowView),
        };
      });
    }),

  commit: permissionProcedure({ code: CODE, at: 'any' })
    .input(commitOpeningStockInput)
    .mutation(async ({ ctx, input }) => {
      const parsed = parseOpeningStockCsv(input.csv);
      if (parsed.fileError !== null) throw new TRPCError({ code: 'BAD_REQUEST', message: parsed.fileError });
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        { op: 'stock.opening_import', idempotencyKey: key, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt },
        input,
        async (tx) => {
          const file = await checkFile(tx, ctx.permissions, parsed.rows);
          if (file.previous !== null) {
            // The same stock, already loaded. Nothing again — and say which import holds it.
            const response = {
              importId: file.previous.importId,
              alreadyImported: true,
              asOfDate: file.previous.asOfDate,
              contentSha256: file.contentSha256,
              rowCount: file.previous.rowCount,
              movementCount: 0,
            } satisfies JsonValue & Record<string, unknown>;
            return { response, apply: async () => undefined };
          }
          const bad = file.rows.filter((r) => r.issues.length > 0);
          if (bad.length > 0) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                `${bad.length} row(s) cannot be loaded, so nothing was: ` +
                bad.slice(0, 10).map((r) => `line ${r.lineNo} ${r.issues.join('+')}`).join('; '),
            });
          }
          const summary = summarise(file.rows);
          const response = {
            importId: key,
            alreadyImported: false,
            asOfDate: input.asOfDate,
            contentSha256: file.contentSha256,
            rowCount: summary.rowCount,
            movementCount: summary.rowCount,
            locationCount: summary.locationCount,
            productCount: summary.productCount,
          } satisfies JsonValue & Record<string, unknown>;
          return {
            response,
            apply: async (atx) => {
              const clock = ctx.deps.clock;
              await atx.query(
                `insert into app.opening_stock_import
                   (tenant_id, id, write_id, hlc, content_sha256, file_name, as_of_date,
                    row_count, location_count, product_count, imported_by)
                 values ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11)`,
                [
                  tenantId, key, key, clock.next(), file.contentSha256, input.fileName ?? null, input.asOfDate,
                  summary.rowCount, summary.locationCount, summary.productCount, ctx.identity.userId,
                ],
              );
              await atx.query(
                `insert into app.movement_reason (tenant_id, id, write_id, hlc, code, name)
                 values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
                [tenantId, deterministicUuid(tenantId, 'api', `movement_reason:${REASON.code}`), key, clock.next(), REASON.code, REASON.name],
              );
              const reasonId = (
                await atx.query<{ id: string }>(`select id from app.movement_reason where code = $1 and deleted_at is null`, [REASON.code])
              ).rows[0]!.id;
              for (let i = 0; i < file.rows.length; i += INSERT_CHUNK) {
                const chunk = file.rows.slice(i, i + INSERT_CHUNK);
                await atx.query(
                  `insert into app.stock_movement
                     (tenant_id, id, write_id, hlc, location_id, product_id, qty_delta, qty_scale, uom_id,
                      reason_id, source_kind, source_id, unit_cost_e4, occurred_at, business_date)
                   select $1, u.id, $2, u.hlc, u.loc, u.prod, u.qty, u.scale, u.uom,
                          $3, 'OPENING', $2, u.cost, transaction_timestamp(), $4::date
                     from unnest($5::uuid[], $6::text[], $7::uuid[], $8::uuid[], $9::bigint[],
                                 $10::smallint[], $11::uuid[], $12::bigint[])
                          as u(id, hlc, loc, prod, qty, scale, uom, cost)`,
                  [
                    tenantId, key, reasonId, input.asOfDate,
                    chunk.map((r) => deterministicUuid(key, 'stock_movement', String(r.lineNo))),
                    chunk.map(() => clock.next()),
                    chunk.map((r) => r.locationId!),
                    chunk.map((r) => r.productId!),
                    chunk.map((r) => wire(r.qtyScaled!)),
                    chunk.map((r) => r.qtyScale!),
                    chunk.map((r) => r.uomId!),
                    chunk.map((r) => (r.unitCostE4 === null ? null : wire(r.unitCostE4))),
                  ],
                );
              }
            },
          };
        },
      );
      return result.response;
    }),
});
