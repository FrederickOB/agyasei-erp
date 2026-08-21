/**
 * D4 — IDEMPOTENT RETRY (the "never silently double-counted" prohibition).
 *
 * Replay EVERY batch device A1 has ever sent, byte-for-byte verbatim — the
 * ambiguous-failure case where a client cannot know whether the server got
 * the batch and must retry. HARD ASSERTIONS: every ack comes back
 * `duplicate`, and the server's state (write_log rows per key, sale count,
 * movement count, credit entries, on-hand) is EXACTLY unchanged.
 */
import type { DrillContext } from '../context.js';
import { DrillResult } from '../report.js';

interface Snapshot {
  sales: number;
  movements: number;
  creditEntries: number; // lint-money-ignore — row count from count(*), not minor units
  customers: number;
  writeLog: number;
  onHand: string;
}

async function snapshot(cx: DrillContext): Promise<Snapshot> {
  const tenantA = cx.tenants.tenantA.id;
  const count = (sql: string) => cx.server.countScoped(tenantA, sql);
  return {
    sales: await count(`select count(*)::text as n from app.sale`),
    movements: await count(`select count(*)::text as n from app.stock_movement`),
    creditEntries: await count(`select count(*)::text as n from app.credit_entry`),
    customers: await count(`select count(*)::text as n from app.customer`),
    writeLog: await count(`select count(*)::text as n from app.write_log`),
    onHand: (await cx.server.onHand(tenantA, cx.locA1, cx.productA.id)).toString(),
  };
}

export async function runD4(cx: DrillContext): Promise<DrillResult> {
  const r = new DrillResult('D4', 'Verbatim replay of acked batches — all duplicate, zero new effects');

  const batches = cx.a1.sentBatches;
  r.check('A1 has acked batches to replay', batches.length > 0, `${batches.length} batches`);

  const before = await snapshot(cx);
  r.measure(
    `state before replay: sales=${before.sales} movements=${before.movements} ` +
      `credit_entries=${before.creditEntries} customers=${before.customers} ` +
      `write_log=${before.writeLog} on-hand(OUT-01)=${before.onHand}`,
  );

  let opCount = 0;
  let duplicateCount = 0;
  const wrong: string[] = [];
  const t0 = performance.now();
  for (const batch of batches) {
    // Byte-identical replay of the original body.
    const acks = await cx.a1.postUpload(batch.body);
    for (const ack of acks) {
      opCount++;
      if (ack.status === 'duplicate') duplicateCount++;
      else wrong.push(`${ack.key}=${ack.status}${ack.reason ? ` (${ack.reason})` : ''}`);
    }
  }
  const tReplay = performance.now() - t0;
  r.measure(`replayed ${batches.length} batches / ${opCount} ops in ${tReplay.toFixed(0)}ms`);

  r.check(
    `every replayed op acked 'duplicate' (${duplicateCount}/${opCount})`,
    opCount > 0 && duplicateCount === opCount,
    wrong.length === 0 ? 'all duplicate' : `non-duplicate acks: ${wrong.join('; ')}`,
  );

  const after = await snapshot(cx);
  r.assertEq('zero new effects: state identical after replay', after, before);

  return r;
}
