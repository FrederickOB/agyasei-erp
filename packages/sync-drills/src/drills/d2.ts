/**
 * D2 — TWO DEVICES, SAME SKU, BOTH OFFLINE (acceptance criterion 2 —
 * "demonstrated, not asserted").
 *
 * A1 and A2 are BOTH partitioned. Each records stock movements against the
 * SAME product at the SAME location into its own outbox. Both reconnect.
 * The movement ledger is append-only and on-hand is SUM(qty_delta), so the
 * correct converged answer is the exact sum — no clobbering, no losing, no
 * double-count. HARD ASSERTIONS:
 *   - server on-hand = baseline + exact sum of all deltas (bigint identity);
 *   - both devices converge to IDENTICAL local movement state, equal to the
 *     server's;
 *   - app.write_log holds exactly ONE row per op key, and exactly one
 *     stock_movement row exists per op (ids are key-derived).
 */
import { deterministicUuid } from '@erp/db';
import { pollUntil } from '../device.js';
import { movementOp, type DrillContext } from '../context.js';
import { DrillResult } from '../report.js';

export async function runD2(cx: DrillContext): Promise<DrillResult> {
  const r = new DrillResult('D2', 'Two offline devices, same SKU — exact convergence');
  const tenantA = cx.tenants.tenantA.id;

  const baseline = await cx.server.onHand(tenantA, cx.locA1, cx.productA.id);
  r.measure(`baseline on-hand (server, OUT-01, ${cx.productA.skuCode}): ${baseline}`);

  // -- partition BOTH devices ---------------------------------------------
  await Promise.all([cx.a1.disconnect(), cx.a2.disconnect()]);

  // -- offline writes on both sides, same SKU ------------------------------
  const plan: { dev: 'a1' | 'a2'; delta: bigint; kind: string; reason: string }[] = [
    { dev: 'a1', delta: 50n, kind: 'RECEIPT', reason: 'TRANSFER' },
    { dev: 'a1', delta: -20n, kind: 'WRITE_OFF', reason: 'DAMAGE' },
    { dev: 'a2', delta: 80n, kind: 'RECEIPT', reason: 'TRANSFER' },
    { dev: 'a2', delta: -5n, kind: 'COUNT_ADJUST', reason: 'COUNT_VARIANCE' },
  ];
  const keys: string[] = [];
  for (const p of plan) {
    const dev = p.dev === 'a1' ? cx.a1 : cx.a2;
    const key = await dev.recordToOutbox(
      'stock.record_movement',
      movementOp(cx.locA1, cx.productA.id, p.delta.toString(10), p.kind, p.reason, cx.businessDate),
    );
    keys.push(key);
  }
  const netDelta = plan.reduce((s, p) => s + p.delta, 0n);
  const expected = baseline + netDelta;
  const movementIds = keys.map((k) => deterministicUuid(k, 'stock_movement'));

  // Sanity: nothing may have reached the server while both are partitioned.
  const preCount = await cx.server.countScoped(
    tenantA,
    `select count(*)::text as n from app.stock_movement where id = any($1::uuid[])`,
    [movementIds],
  );
  r.assertEq('no movement reached server while partitioned', preCount, 0);

  // -- reconnect BOTH ------------------------------------------------------
  const t0 = performance.now();
  await Promise.all([
    (async () => {
      await cx.a1.flushOutbox();
      await cx.a1.connect();
    })(),
    (async () => {
      await cx.a2.flushOutbox();
      await cx.a2.connect();
    })(),
  ]);

  const tServer = await pollUntil('all 4 movements on server', async () => {
    const n = await cx.server.countScoped(
      tenantA,
      `select count(*)::text as n from app.stock_movement where id = any($1::uuid[])`,
      [movementIds],
    );
    return n === movementIds.length;
  });
  r.measure(`all 4 movements on server: ${tServer.toFixed(0)}ms after reconnect`);

  for (const dev of [cx.a1, cx.a2]) {
    const t = await pollUntil(`${dev.name} has all 4 movements locally`, async () => {
      const rows = await dev.getAll<{ n: number }>(
        `select count(*) as n from stock_movement where id in (?, ?, ?, ?)`,
        movementIds,
      );
      return (rows[0]?.n ?? 0) === movementIds.length;
    });
    r.measure(`${dev.name} converged: ${t.toFixed(0)}ms after server had all movements`);
  }

  // -- assertions ----------------------------------------------------------
  const serverOnHand = await cx.server.onHand(tenantA, cx.locA1, cx.productA.id);
  r.assertEq(
    `server on-hand = baseline ${baseline} + Σdeltas ${netDelta} (exact)`,
    serverOnHand,
    expected,
  );

  const a1OnHand = await cx.a1.localOnHand(cx.productA.id);
  const a2OnHand = await cx.a2.localOnHand(cx.productA.id);
  r.assertEq('device A1 local on-hand equals server', a1OnHand, serverOnHand);
  r.assertEq('device A2 local on-hand equals server', a2OnHand, serverOnHand);

  // Identical local state: the full movement ledger for this SKU/location,
  // row for row, on both devices.
  const ledger = (dev: typeof cx.a1) =>
    dev.getAll<{ id: string; qty_delta: string; source_kind: string }>(
      `select id, cast(qty_delta as text) as qty_delta, source_kind
         from stock_movement where product_id = ? and location_id = ?
        order by id`,
      [cx.productA.id, cx.locA1],
    );
  const [l1, l2] = await Promise.all([ledger(cx.a1), ledger(cx.a2)]);
  const s1 = JSON.stringify(l1);
  const s2 = JSON.stringify(l2);
  let divergence = '';
  if (s1 !== s2) {
    const i = l1.findIndex((row, idx) => JSON.stringify(row) !== JSON.stringify(l2[idx]));
    divergence = ` — first divergence at row ${i}: A1=${JSON.stringify(l1[i])} A2=${JSON.stringify(l2[i])}`;
  }
  r.check(
    'A1 and A2 movement ledgers identical (row for row)',
    s1 === s2,
    `A1=${l1.length} rows, A2=${l2.length} rows${s1 === s2 ? ', byte-identical' : divergence}`,
  );
  r.check('converged ledgers are non-empty', l1.length >= 4, `${l1.length} rows`);

  // write_log: exactly one row per op — no loss, no double-count.
  const wl = await cx.server.writeLogCounts(tenantA, keys);
  const counts = keys.map((k) => wl.get(k) ?? 0);
  r.assertEq('write_log rows per op key (no loss, no dup)', counts, [1, 1, 1, 1]);
  const effectCount = await cx.server.countScoped(
    tenantA,
    `select count(*)::text as n from app.stock_movement where id = any($1::uuid[])`,
    [movementIds],
  );
  r.assertEq('exactly one stock_movement row per op', effectCount, movementIds.length);

  return r;
}
