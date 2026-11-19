/**
 * THE LOST-WRITE CONTROL — the nearest thing to §9.4's that the schema can
 * support today.
 *
 * WHAT §9.4 SPECIFIES: each device's local write-log count reconciled daily
 * against `app.device_write_watermark.applied_count`; any unexplained
 * discrepancy pages. It is "the only signal that directly measures CLAUDE.md
 * §2.2". THAT TABLE DOES NOT EXIST, and no device reports its local write
 * count. Stated plainly so nobody mistakes what follows for the real thing.
 *
 * WHAT DOES EXIST, AND WHY IT IS A GOOD PROXY FOR THE WRITE THAT MATTERS
 * MOST: every sale consumes a receipt number from a block the server issued to
 * that device (`app.sequence_block`, 03 §3.7.5), and the device REPORTS how far
 * through the block it has issued (`consumed_upto`) on the same ordered outbox
 * as its sales. So the device has told the server, in effect, "I have printed
 * receipts N…M". Every one of those numbers should be on a sale the server
 * holds. A number the device says it issued and no sale carries is a receipt
 * in a customer's hand with no sale in the books — a lost sale, or a number
 * burned without a sale, and either way something a human must explain.
 *
 * Because the report rides the ORDERED outbox behind the sales it covers, a
 * missing number is not "not synced yet": the sales issued before the report
 * were ahead of it in the queue. A definitively rejected sale — dead-lettered
 * on the device, invisible to the server — is exactly what this catches.
 *
 * WHAT IT DOES NOT CATCH: writes that consume no number (stock movements,
 * credit entries, receipts of goods), and a device whose storage was evicted
 * before it reported (§9.5's named blind spot). The real watermark is still
 * required; this does not retire that requirement.
 *
 * MECHANICS. Numbers are re-rendered with `@erp/sequence` — the ONE rendering
 * the device used to print them — from the counter's own format, prefix and
 * the location's code. Nothing branches on a sequence key: a key whose
 * numbers never appear on any sale (a transfer series, say) is classified
 * "unverifiable" by the data, not by name.
 */
import { renderNumber } from '@erp/sequence';
import type { Queryable } from '../db.js';

export interface ContinuityFinding {
  readonly locationId: string;
  readonly deviceId: string;
  readonly sequenceKey: string;
  readonly blocks: number;
  /** Numbers the device reports having issued. */
  readonly issued: number;
  /** Of those, how many are on a sale the server holds. */
  readonly present: number;
  readonly missing: number;
  /** Up to 10 missing sequence numbers (integers, not rendered strings). */
  readonly missingSample: readonly string[];
}

export interface ContinuityResult {
  readonly findings: readonly ContinuityFinding[];
  /** Device/key groups that are fully accounted for. */
  readonly clean: number;
  /** Keys whose numbers never appear on a sale: not a sale series, or nothing has arrived. */
  readonly unverifiableKeys: readonly string[];
  readonly blocksChecked: number;
}

interface BlockRow {
  location_id: string;
  device_id: string;
  sequence_key: string;
  block_start: string;
  consumed_upto: string;
  number_format: string;
  number_prefix: string;
  location_code: string;
}

const CHUNK = 5_000;

/**
 * Run inside ONE tenant's RLS context. `lookbackDays` bounds how far back
 * closed blocks are re-checked; open blocks are always checked.
 */
export async function receiptContinuity(tx: Queryable, opts: { lookbackDays?: number } = {}): Promise<ContinuityResult> {
  const blocks = await tx.query<BlockRow>(
    `select b.location_id::text, b.device_id::text, b.sequence_key,
            b.block_start::text, b.consumed_upto::text,
            c.number_format, c.number_prefix, l.code as location_code
       from app.sequence_block b
       join app.sequence_counter c
         on c.tenant_id = b.tenant_id and c.sequence_key = b.sequence_key
        and c.location_id = b.location_id and c.deleted_at is null
       join app.location l on l.tenant_id = b.tenant_id and l.id = b.location_id
      where b.consumed_upto is not null
        and (b.exhausted_at is null
             or coalesce(b.reported_at, b.issued_at) > clock_timestamp() - make_interval(days => $1::int))
      order by b.location_id, b.device_id, b.sequence_key, b.block_start`,
    [opts.lookbackDays ?? 35],
  );

  // Render every issued number, grouped by location (receipt_no is unique per location).
  type Group = { locationId: string; deviceId: string; sequenceKey: string; blocks: number; numbers: Map<string, bigint> };
  const groups = new Map<string, Group>();
  const wantedByLocation = new Map<string, Set<string>>();
  for (const b of blocks.rows) {
    const key = `${b.location_id}|${b.device_id}|${b.sequence_key}`;
    let g = groups.get(key);
    if (!g) {
      g = { locationId: b.location_id, deviceId: b.device_id, sequenceKey: b.sequence_key, blocks: 0, numbers: new Map() };
      groups.set(key, g);
    }
    g.blocks += 1;
    const spec = { format: b.number_format, prefix: b.number_prefix, locationCode: b.location_code };
    const wanted = wantedByLocation.get(b.location_id) ?? new Set<string>();
    wantedByLocation.set(b.location_id, wanted);
    for (let n = BigInt(b.block_start); n <= BigInt(b.consumed_upto); n += 1n) {
      const rendered = renderNumber(spec, n);
      g.numbers.set(rendered, n);
      wanted.add(rendered);
    }
  }

  const presentByLocation = new Map<string, Set<string>>();
  for (const [locationId, wanted] of wantedByLocation) {
    const found = new Set<string>();
    const all = [...wanted];
    for (let i = 0; i < all.length; i += CHUNK) {
      const chunk = all.slice(i, i + CHUNK);
      const res = await tx.query<{ n: string }>(
        // A return slip draws from the same device series (0030): its number
        // is accounted for exactly as a sale's is.
        `select receipt_no as n from app.sale where location_id = $1 and receipt_no = any($2::text[])
         union
         select receipt_no_claimed as n from app.sale
          where location_id = $1 and receipt_no_claimed = any($2::text[])
         union
         select return_no as n from app.sale_return where location_id = $1 and return_no = any($2::text[])
         union
         select return_no_claimed as n from app.sale_return
          where location_id = $1 and return_no_claimed = any($2::text[])`,
        [locationId, chunk],
      );
      for (const r of res.rows) found.add(r.n);
    }
    presentByLocation.set(locationId, found);
  }

  // A key is a sale series iff at least one of its numbers is on a sale.
  const saleKeys = new Set<string>();
  for (const g of groups.values()) {
    const found = presentByLocation.get(g.locationId)!;
    for (const r of g.numbers.keys()) {
      if (found.has(r)) {
        saleKeys.add(g.sequenceKey);
        break;
      }
    }
  }

  const findings: ContinuityFinding[] = [];
  const unverifiable = new Set<string>();
  let clean = 0;
  for (const g of groups.values()) {
    if (!saleKeys.has(g.sequenceKey)) {
      unverifiable.add(g.sequenceKey);
      continue;
    }
    const found = presentByLocation.get(g.locationId)!;
    const missing: bigint[] = [];
    for (const [r, n] of g.numbers) if (!found.has(r)) missing.push(n);
    if (missing.length === 0) {
      clean += 1;
      continue;
    }
    missing.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    findings.push({
      locationId: g.locationId,
      deviceId: g.deviceId,
      sequenceKey: g.sequenceKey,
      blocks: g.blocks,
      issued: g.numbers.size,
      present: g.numbers.size - missing.length,
      missing: missing.length,
      missingSample: missing.slice(0, 10).map((n) => n.toString(10)),
    });
  }

  return {
    findings,
    clean,
    unverifiableKeys: [...unverifiable].sort(),
    blocksChecked: blocks.rows.length,
  };
}
