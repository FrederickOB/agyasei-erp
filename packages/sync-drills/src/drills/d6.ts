/**
 * D6 — RECEIPT-NUMBER REGRESSION: wipe a device's local DB mid-block, reissue.
 * The named drill from 03-offline-sync §3.9, for conflict class #14 (§3.7.5).
 *
 * Asserts, against the REAL stack: "the regression is detected on reconnect,
 * the block is burned, a fresh block issues, and the overlap range is in
 * review. No two customers hold the same number undetected."
 *
 * The wipe is real. A6's sqlite file is DELETED from disk and the device
 * reopens on an empty one — OPFS eviction, or a PWA reinstall on the same
 * enrolled device. Its identity survives (same device_id, same user, same
 * tokens), which is exactly what makes this case sharp: the server still shows
 * that device holding a live block, and the device has no idea.
 *
 * The drill also proves the SECOND half, which is the part that used to take
 * the till down. A wiped device keeps trading offline before it can report
 * anything, so it arrives with numbers another sale already holds. That upload
 * must LAND — acked `applied`, recorded under the emergency form, with the
 * printed number preserved and a severity-1 review naming both. Before this
 * mechanism it came back as
 * `INTERNAL_SERVER_ERROR: duplicate key value violates unique constraint
 * "sale_receipt_uq"`, which the client's §3.3.4 taxonomy retries forever: the
 * outbox never drained and the outlet went dark for uploads.
 */
import { DrillDevice } from '../device.js';
import { saleOp, type DrillContext } from '../context.js';
import { DrillResult } from '../report.js';

interface SyncBlockResult {
  status: string;
  block: { blockStart: string; blockSize: number; blockEnd: string; nextNumber: string | null } | null;
  format: { format: string; prefix: string; locationCode: string } | null;
  burned: { blockStart: string; blockEnd: string; consumedUpto: string | null; burnedFrom: string; burnedTo: string; reason: string } | null;
  review: { id: string; conflictClass: string; severity: number; kind: string; overlapFrom: string; overlapTo: string } | null;
}

/** Flush the ordered outbox and return the block report's own answer. */
async function syncBlock(device: DrillDevice): Promise<SyncBlockResult> {
  const key = await device.queueBlockReport();
  const acks = await device.flushOutbox();
  const ack = acks.find((a) => a.key === key);
  if (!ack) throw new Error(`${device.name}: no ack for the block report`);
  if (ack.status === 'rejected') throw new Error(`block report rejected: ${ack.reason}`);
  const result = ack.result as SyncBlockResult | undefined;
  if (!result) throw new Error(`block report acked without a result — the device cannot learn its block`);
  if (result.block !== null && result.format !== null) {
    await device.adoptBlock(result.block, result.format);
  }
  return result;
}

export async function runD6(cx: DrillContext): Promise<DrillResult> {
  const r = new DrillResult(
    'D6',
    "Receipt-number regression — wipe a device's local DB mid-block, reissue",
  );
  const tenantA = cx.tenants.tenantA.id;

  // A dedicated device at OUT-01, so the wipe cannot disturb A1/A2.
  const a6 = new DrillDevice('device-a6', tenantA, cx.locA1);
  await a6.open();

  try {
    // ---- 1. a block, allocated by the SERVER ------------------------------
    const first = await syncBlock(a6);
    r.check(
      'the server allocates the block — the device never self-issues',
      first.status === 'ok' && first.block !== null && first.review === null,
      `status=${first.status} block=${first.block?.blockStart}..${first.block?.blockEnd} review=${String(first.review)}`,
    );
    const blockStart = BigInt(first.block!.blockStart);
    const blockEndN = BigInt(first.block!.blockEnd);
    r.measure(
      `block ${blockStart}..${blockEndN} (size ${first.block!.blockSize}), ` +
        `format '${first.format!.format}' prefix '${first.format!.prefix}' at ${first.format!.locationCode}`,
    );

    // ---- 2. trade, then report --------------------------------------------
    const printed: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const receiptNo = await a6.takeReceiptNumber();
      printed.push(receiptNo);
      await a6.recordToOutbox(
        'sale.create',
        saleOp(cx.locA1, cx.productA.id, receiptNo, cx.businessDate, '1'),
      );
    }
    const saleAcks = await a6.flushOutbox();
    r.check(
      'three sales applied on the issued numbers',
      saleAcks.length === 3 && saleAcks.every((a) => a.status === 'applied'),
      saleAcks.map((a) => `${a.status}${a.reason ? `(${a.reason})` : ''}`).join(', '),
    );

    const reported = await syncBlock(a6);
    const serverSaw = await cx.server.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ consumed_upto: string | null }>(
        `select consumed_upto::text from app.sequence_block
          where device_id = $1 and exhausted_at is null`,
        [a6.deviceId],
      );
      return res.rows[0]?.consumed_upto ?? null;
    });
    r.check(
      'the server records the reported cursor and opens nothing',
      reported.review === null && serverSaw === (blockStart + 2n).toString(10),
      `consumed_upto=${String(serverSaw)} expected=${blockStart + 2n} review=${String(reported.review)}`,
    );
    r.measure(`printed before the wipe: ${printed.join(', ')}`);

    // ---- 3. THE WIPE -------------------------------------------------------
    await a6.wipeLocalDatabase();
    r.check(
      'after the wipe the device holds no block — it cannot know it ever did',
      (await a6.currentBlock()) === null,
      'local sequence_block row destroyed with the sqlite file',
    );

    // ---- 4. reconnect: detection, burn, reissue, review --------------------
    const t0 = performance.now();
    const after = await syncBlock(a6);
    const detectMs = performance.now() - t0;

    r.check(
      'the regression is DETECTED on reconnect',
      after.status === 'regression' && after.review !== null,
      `status=${after.status} kind=${after.review?.kind ?? 'none'} in ${detectMs.toFixed(0)}ms`,
    );
    r.check(
      'the review is SEVERITY 1 and names the overlap range',
      after.review?.severity === 1 &&
        after.review.overlapFrom === blockStart.toString(10) &&
        after.review.overlapTo === (blockStart + 2n).toString(10),
      `severity=${String(after.review?.severity)} overlap=${after.review?.overlapFrom}..${after.review?.overlapTo} ` +
        `expected=${blockStart}..${blockStart + 2n}`,
    );
    r.check(
      'the remainder of the block is BURNED',
      after.burned?.reason === 'REGRESSION_BURN' &&
        after.burned.burnedFrom === (blockStart + 3n).toString(10) &&
        after.burned.burnedTo === blockEndN.toString(10),
      `reason=${String(after.burned?.reason)} burned=${after.burned?.burnedFrom}..${after.burned?.burnedTo}`,
    );
    const freshStart = BigInt(after.block!.blockStart);
    r.check(
      'a FRESH block issues, strictly above everything the burned one covered',
      freshStart > blockEndN && after.block!.nextNumber === after.block!.blockStart,
      `fresh=${freshStart}..${after.block!.blockEnd} burned block ended at ${blockEndN}`,
    );

    // ---- 5. the server's own books agree ----------------------------------
    const blocks = await cx.server.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{
        block_start: string;
        closed_reason: string | null;
        exhausted: boolean;
      }>(
        `select block_start::text, closed_reason, (exhausted_at is not null) as exhausted
           from app.sequence_block where device_id = $1
          order by app.sequence_block.block_start`,
        [a6.deviceId],
      );
      return res.rows;
    });
    r.assertEq(
      'exactly two blocks on the server: one burned, one live',
      blocks.map((b) => `${b.block_start}:${b.closed_reason ?? 'live'}`),
      [`${blockStart}:REGRESSION_BURN`, `${freshStart}:live`],
    );

    const review = await cx.server.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{
        severity: number;
        status: string;
        conflict_class: string;
        overlap_from: string;
        overlap_to: string;
        scoped_locations: number;
      }>(
        `select cr.severity, cr.status, cr.conflict_class,
                cr.pending_value ->> 'overlapFrom' as overlap_from,
                cr.pending_value ->> 'overlapTo'   as overlap_to,
                (select count(*)::int from app.conflict_review_location crl
                  where crl.tenant_id = cr.tenant_id and crl.review_id = cr.id) as scoped_locations
           from app.conflict_review cr where cr.id = $1`,
        [after.review!.id],
      );
      return res.rows[0] ?? null;
    });
    r.check(
      'the review is on the server, open, severity 1, scoped to the outlet',
      review !== null &&
        review.severity === 1 &&
        review.status === 'open' &&
        review.conflict_class === 'SEQUENCE_CONSUMED_UPTO_REGRESSION' &&
        review.scoped_locations === 1,
      review === null
        ? 'review row missing'
        : `severity=${review.severity} status=${review.status} class=${review.conflict_class} ` +
          `overlap=${review.overlap_from}..${review.overlap_to} scoped_locations=${review.scoped_locations}`,
    );

    // ---- 6. the till does not go dark -------------------------------------
    // A wiped device that kept trading offline arrives with a number another
    // sale already holds. That upload must LAND, or the outbox stalls forever.
    const duplicate = printed[0]!;
    await a6.recordToOutbox(
      'sale.create',
      saleOp(cx.locA1, cx.productA.id, duplicate, cx.businessDate, '1'),
    );
    const collisionAcks = await a6.flushOutbox();
    const collisionAck = collisionAcks[collisionAcks.length - 1]!;
    r.check(
      'a colliding sale is APPLIED, not dead-lettered and not retried forever',
      collisionAck.status === 'applied',
      `status=${collisionAck.status} reason=${collisionAck.reason ?? 'none'}`,
    );
    r.check(
      'and specifically NOT the raw unique violation that used to jam the queue',
      !/sale_receipt_uq|INTERNAL_SERVER_ERROR/.test(collisionAck.reason ?? ''),
      `reason=${collisionAck.reason ?? 'none'}`,
    );

    const landed = await cx.server.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ receipt_no: string; receipt_no_claimed: string | null }>(
        `select receipt_no, receipt_no_claimed from app.sale
          where location_id = $1 and (receipt_no = $2 or receipt_no_claimed = $2)
          order by receipt_no`,
        [cx.locA1, duplicate],
      );
      return res.rows;
    });
    r.check(
      'both sales are recorded, on DISTINCT stored numbers',
      landed.length === 2 && landed[0]!.receipt_no !== landed[1]!.receipt_no,
      landed.map((x) => `${x.receipt_no}${x.receipt_no_claimed ? ` (printed ${x.receipt_no_claimed})` : ''}`).join(' | '),
    );
    r.check(
      'the number the customer actually holds is preserved, not overwritten',
      landed.some((x) => x.receipt_no_claimed === duplicate),
      `receipt_no_claimed=${landed.map((x) => String(x.receipt_no_claimed)).join(',')}`,
    );

    const collisionReview = await cx.server.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.conflict_review
          where conflict_class = 'RECEIPT_NUMBER_COLLISION' and severity = 1 and status = 'open'`,
      );
      return Number(res.rows[0]!.n);
    });
    r.check(
      'and a severity-1 review names the collision — no two customers hold the same number UNDETECTED',
      collisionReview >= 1,
      `open RECEIPT_NUMBER_COLLISION reviews: ${collisionReview}`,
    );

    // ---- 7. tenant isolation on the new read paths ------------------------
    const leaked = await cx.server.withTenant(cx.tenants.tenantB.id, async (tx) => {
      const blocksSeen = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.sequence_block where location_id = $1`,
        [cx.locA1],
      );
      const reviewsSeen = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.conflict_review
          where conflict_class in ('SEQUENCE_CONSUMED_UPTO_REGRESSION','RECEIPT_NUMBER_COLLISION')`,
      );
      return Number(blocksSeen.rows[0]!.n) + Number(reviewsSeen.rows[0]!.n);
    });
    r.check(
      "tenant B sees none of tenant A's blocks or reviews (§2.7 category 3)",
      leaked === 0,
      `rows visible to tenant B: ${leaked}`,
    );
  } finally {
    await a6.close();
  }

  return r;
}
