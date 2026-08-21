/**
 * D1 — THE 60-SECOND SYNC (Phase 1 acceptance criterion 1).
 *
 * Device A1 is connected, then genuinely disconnected (sync stream severed).
 * While partitioned it records a sale into its local outbox — nothing
 * touches the network. On reconnection (outbox flush to /sync/upload + sync
 * stream re-established, concurrently, like a real device) we measure the
 * time until the sale is (a) committed on the server and (b) visible in
 * device A2's local database. HARD ASSERTION: < 60s. Five iterations; each
 * reported, plus p95.
 */
import { deterministicUuid } from '@erp/db';
import { pollUntil } from '../device.js';
import { saleOp, type DrillContext } from '../context.js';
import { DrillResult, p95 } from '../report.js';

const LIMIT_MS = 60_000;
const ITERATIONS = 5;

export async function runD1(cx: DrillContext): Promise<DrillResult> {
  const r = new DrillResult('D1', 'Offline sale syncs to server + second device < 60s');
  const totals: number[] = []; // lint-money-ignore — elapsed milliseconds (sync latency), not minor units

  for (let iter = 1; iter <= ITERATIONS; iter++) {
    // -- partition A1 ------------------------------------------------------
    await cx.a1.disconnect();

    // -- record the sale OFFLINE ------------------------------------------
    const receiptNo = `D1-${cx.runId}-${iter}`;
    const key = await cx.a1.recordToOutbox(
      'sale.create',
      saleOp(cx.locA1, cx.productA.id, receiptNo, cx.businessDate),
    );
    const saleId = deterministicUuid(key, 'sale');

    // Negative control: while partitioned, the sale must NOT be on the server.
    const leakedEarly = await cx.server.saleOnServer(cx.tenants.tenantA.id, saleId);
    r.check(
      `iter ${iter}: partition is real (sale absent from server while offline)`,
      !leakedEarly,
      leakedEarly ? 'sale reached server before reconnection' : 'server has no such sale pre-reconnect',
    );
    if (leakedEarly) continue;

    // -- reconnect: t0 starts here ----------------------------------------
    const t0 = performance.now();
    let tServer = -1;
    let tA2 = -1;
    const flushAndConnect = (async () => {
      const acks = await cx.a1.flushOutbox();
      const ack = acks.find((a) => a.key === key);
      if (ack?.status !== 'applied') throw new Error(`upload ack ${JSON.stringify(ack)}`);
      await cx.a1.connect();
    })();
    const serverSeen = pollUntil(`sale ${receiptNo} on server`, () =>
      cx.server.saleOnServer(cx.tenants.tenantA.id, saleId),
    ).then((ms) => (tServer = performance.now() - t0));
    const a2Seen = pollUntil(`sale ${receiptNo} on device A2`, async () => {
      const rows = await cx.a2.getAll(`select id from sale where id = ?`, [saleId]);
      return rows.length > 0;
    }).then(() => (tA2 = performance.now() - t0));
    await Promise.all([flushAndConnect, serverSeen, a2Seen]);
    const total = Math.max(tServer, tA2);
    totals.push(total);

    r.measure(
      `iteration ${iter}: server ${tServer.toFixed(0)}ms, visible on A2 ${tA2.toFixed(0)}ms, total ${total.toFixed(0)}ms`,
    );
    r.check(
      `iter ${iter}: offline sale synced < 60s`,
      total < LIMIT_MS,
      `${total.toFixed(0)}ms (limit ${LIMIT_MS}ms)`,
    );
  }

  if (totals.length === ITERATIONS) {
    const p = p95(totals);
    r.measure(`p95 over ${ITERATIONS} iterations: ${p.toFixed(0)}ms`);
    r.check('p95 < 60s', p < LIMIT_MS, `${p.toFixed(0)}ms`);
  } else {
    r.check('all iterations completed', false, `${totals.length}/${ITERATIONS}`);
  }

  // A1 itself must also converge back to its own sales (round trip).
  try {
    await pollUntil(`A1 sees its own ${ITERATIONS} D1 sales`, async () => {
      const rows = await cx.a1.getAll(`select id from sale where receipt_no like ?`, [`D1-${cx.runId}-%`]);
      return rows.length >= totals.length;
    });
    r.check('A1 sees all its own D1 sales after reconnect', true, `${totals.length} sales`);
  } catch (err) {
    r.check('A1 sees all its own D1 sales after reconnect', false, String(err));
  }
  return r;
}
