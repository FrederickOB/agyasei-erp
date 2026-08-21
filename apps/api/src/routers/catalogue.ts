/**
 * Catalogue reads: list, tolerant substring search, detail — with prices.
 *
 * Every query runs under the token tenant's RLS context; a foreign
 * product id resolves to zero rows and returns the SAME generic NOT_FOUND
 * a genuinely absent id gets — no existence leak (CLAUDE.md §2.7 cat 3).
 *
 * Prices are unit_price_e4 (minor units per selling unit × 10⁴) and cross
 * the wire as decimal strings (ADR-0004).
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, tenantProcedure } from '../trpc.js';
import type { Queryable } from '../db.js';
import { zBusinessDate, zUuid } from '../wire.js';

interface ProductRow {
  id: string;
  sku_code: string;
  name: string;
  category_code: string;
  stocking_uom_code: string;
  qty_scale: number;
  tax_code: string;
  stock_tracking: string;
  is_sellable: boolean;
}

interface PriceRow {
  product_id: string;
  price_list_code: string;
  is_tax_inclusive: boolean;
  uom_code: string;
  unit_price_e4: string;
  min_qty: string;
  effective_from: string;
}

const PRODUCT_SELECT = `
  select p.id, p.sku_code, p.name, c.code as category_code,
         u.code as stocking_uom_code, u.qty_scale, p.tax_code,
         p.stock_tracking, p.is_sellable
  from app.product p
  join app.product_category c on c.tenant_id = p.tenant_id and c.id = p.category_id
  join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
  where p.deleted_at is null`;

async function pricesFor(
  tx: Queryable,
  productIds: readonly string[],
  onDate: string,
): Promise<Map<string, PriceRow[]>> {
  if (productIds.length === 0) return new Map();
  const res = await tx.query<PriceRow>(
    `select i.product_id, l.code as price_list_code, l.is_tax_inclusive,
            u.code as uom_code, i.unit_price_e4::text as unit_price_e4,
            i.min_qty::text as min_qty, i.effective_from::text as effective_from
     from app.price_list_item i
     join app.price_list l on l.tenant_id = i.tenant_id and l.id = i.price_list_id
     join app.unit_of_measure u on u.tenant_id = i.tenant_id and u.id = i.uom_id
     where i.deleted_at is null and l.deleted_at is null
       and i.product_id = any(string_to_array($1, ',')::uuid[])
       and i.effective_from <= $2::date
       and (i.effective_to is null or i.effective_to > $2::date)
       and l.effective_from <= $2::date
       and (l.effective_to is null or l.effective_to > $2::date)
     order by l.priority, i.min_qty`,
    [productIds.join(','), onDate],
  );
  const map = new Map<string, PriceRow[]>();
  for (const row of res.rows) {
    const list = map.get(row.product_id) ?? [];
    list.push(row);
    map.set(row.product_id, list);
  }
  return map;
}

function toDto(p: ProductRow, prices: PriceRow[] | undefined) {
  return {
    productId: p.id,
    skuCode: p.sku_code,
    name: p.name,
    categoryCode: p.category_code,
    stockingUomCode: p.stocking_uom_code,
    qtyScale: p.qty_scale,
    taxCode: p.tax_code,
    stockTracking: p.stock_tracking,
    isSellable: p.is_sellable,
    prices: (prices ?? []).map((pr) => ({
      priceListCode: pr.price_list_code,
      isTaxInclusive: pr.is_tax_inclusive,
      uomCode: pr.uom_code,
      unitPriceE4: pr.unit_price_e4, // decimal string of e4 units
      minQty: pr.min_qty,
      effectiveFrom: pr.effective_from,
    })),
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export const catalogueRouter = router({
  list: tenantProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
          onDate: zBusinessDate.optional(),
        })
        .strict()
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<ProductRow>(
          `${PRODUCT_SELECT} order by p.sku_code limit $1 offset $2`,
          [input.limit, input.offset],
        );
        const prices = await pricesFor(tx, res.rows.map((r) => r.id), input.onDate ?? today());
        return { products: res.rows.map((p) => toDto(p, prices.get(p.id))) };
      });
    }),

  /** Tolerant substring search: every whitespace-separated term must match
   *  the name or the SKU code, case-insensitively, in any position. */
  search: tenantProcedure
    .input(
      z
        .object({
          q: z.string().min(1).max(200),
          limit: z.number().int().min(1).max(200).default(50),
          onDate: zBusinessDate.optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const terms = input.q.split(/\s+/).filter((t) => t.length > 0);
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const params: unknown[] = [];
        const clauses = terms.map((term) => {
          params.push(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
          const n = params.length;
          return `(p.name ilike $${n} or p.sku_code ilike $${n})`;
        });
        params.push(input.limit);
        const res = await tx.query<ProductRow>(
          `${PRODUCT_SELECT} and ${clauses.join(' and ')} order by p.sku_code limit $${params.length}`,
          params,
        );
        const prices = await pricesFor(tx, res.rows.map((r) => r.id), input.onDate ?? today());
        return { products: res.rows.map((p) => toDto(p, prices.get(p.id))) };
      });
    }),

  detail: tenantProcedure
    .input(z.object({ productId: zUuid, onDate: zBusinessDate.optional() }).strict())
    .query(async ({ ctx, input }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<ProductRow>(`${PRODUCT_SELECT} and p.id = $1`, [input.productId]);
        const p = res.rows[0];
        if (!p) {
          // Identical wording whether the id belongs to another tenant or to
          // nobody: zero rows is zero rows. No existence leak.
          throw new TRPCError({ code: 'NOT_FOUND', message: 'product not found' });
        }
        const prices = await pricesFor(tx, [p.id], input.onDate ?? today());
        return toDto(p, prices.get(p.id));
      });
    }),
});
