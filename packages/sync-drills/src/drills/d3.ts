/**
 * D3 — THE HQ VIEW (acceptance criterion 4).
 *
 * After D1/D2, a third tenant-A device (A3, at OUT-03) records a sale and a
 * stock receipt and syncs them up. Then ONE tenant-scoped server-side query
 * shows post-sync stock and sales across locations. HARD ASSERTIONS: the
 * HQ view's per-location figures equal independently computed per-location
 * sums (exact bigint identity), at least two locations show sales, and the
 * cross-location total is the exact sum of its parts.
 */
import { movementOp, saleOp, type DrillContext } from '../context.js';
import { DrillResult } from '../report.js';

interface HqRow {
  code: string;
  sales_count: string;
  sales_total_minor: string;
  on_hand_drill_sku: string;
}

export async function runD3(cx: DrillContext): Promise<DrillResult> {
  const r = new DrillResult('D3', 'HQ sees post-sync stock and sales across locations');
  const tenantA = cx.tenants.tenantA.id;

  // -- OUT-03 activity through the same device→API sync path ---------------
  await cx.a3.recordToOutbox(
    'stock.record_movement',
    movementOp(cx.locA3, cx.productA.id, '30', 'RECEIPT', 'TRANSFER', cx.businessDate),
  );
  await cx.a3.recordToOutbox(
    'sale.create',
    saleOp(cx.locA3, cx.productA.id, `D3-${cx.runId}-1`, cx.businessDate, '4'),
  );
  const tUp0 = performance.now();
  const acks = await cx.a3.flushOutbox();
  const tUp = performance.now() - tUp0;
  r.assertEq('A3 (OUT-03) upload acks applied', acks.map((a) => a.status), ['applied', 'applied']);
  r.measure(`A3 outbox flush (2 ops): ${tUp.toFixed(0)}ms`);

  // -- ONE HQ query: stock + sales across every location -------------------
  const tQ0 = performance.now();
  const hq = await cx.server.withTenant(tenantA, (tx) =>
    tx
      .query<HqRow>(
        `select l.code,
                coalesce(s.n, 0)::text                as sales_count,
                coalesce(s.total_minor, 0)::text      as sales_total_minor,
                coalesce(m.on_hand, 0)::text          as on_hand_drill_sku
           from app.location l
           left join (
             select location_id, count(*) as n, sum(total_minor) as total_minor
               from app.sale group by location_id
           ) s on s.location_id = l.id
           left join (
             select location_id, sum(qty_delta) as on_hand
               from app.stock_movement
              where product_id = $1 and deleted_at is null
              group by location_id
           ) m on m.location_id = l.id
          where l.deleted_at is null
          order by l.code`,
        [cx.productA.id],
      )
      .then((res) => res.rows),
  );
  const tQ = performance.now() - tQ0;
  r.measure(`HQ cross-location query: ${tQ.toFixed(0)}ms over ${hq.length} locations`);

  const out01 = hq.find((row) => row.code === 'OUT-01');
  const out03 = hq.find((row) => row.code === 'OUT-03');
  r.check('OUT-01 present with sales', Number(out01?.sales_count ?? 0) > 0, `sales_count=${out01?.sales_count}`);
  r.check('OUT-03 present with sales', Number(out03?.sales_count ?? 0) > 0, `sales_count=${out03?.sales_count}`);
  const locationsWithSales = hq.filter((row) => Number(row.sales_count) > 0).length;
  r.check('sales visible across ≥ 2 locations in one view', locationsWithSales >= 2, `${locationsWithSales} locations`);

  // Independent per-location cross-checks (exact bigint identities).
  const indepOut01 = await cx.server.onHand(tenantA, cx.locA1, cx.productA.id);
  const indepOut03 = await cx.server.onHand(tenantA, cx.locA3, cx.productA.id);
  r.assertEq('HQ OUT-01 on-hand equals independent ledger sum', BigInt(out01?.on_hand_drill_sku ?? '-1'), indepOut01);
  r.assertEq('HQ OUT-03 on-hand equals independent ledger sum', BigInt(out03?.on_hand_drill_sku ?? '-1'), indepOut03);

  const hqTotal = hq.reduce((s, row) => s + BigInt(row.sales_total_minor), 0n);
  const tenantTotal = await cx.server.withTenant(tenantA, (tx) =>
    tx
      .query<{ t: string }>(`select coalesce(sum(total_minor), 0)::text as t from app.sale`)
      .then((res) => BigInt(res.rows[0]?.t ?? '-1')),
  );
  r.assertEq('Σ(per-location sales) = tenant-wide total (exact bigint)', hqTotal, tenantTotal);
  r.measure(`tenant A sales total across locations: ${tenantTotal} minor units`);
  r.measure(
    `on-hand ${cx.productA.skuCode}: OUT-01=${indepOut01}, OUT-03=${indepOut03}`,
  );

  return r;
}
