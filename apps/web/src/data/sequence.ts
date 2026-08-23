/**
 * Offline allocation of human-facing sequence numbers (03-offline-sync
 * §3.7.5). The formatting half lives in `src/lib/receipt-number.ts`; this is
 * the half that draws a number down and remembers it.
 *
 * Everything here runs inside the CALLER's transaction — checkout passes its
 * `tx`, so consuming the number, writing the outbox row and clearing the cart
 * commit or roll back as one unit. A checkout that fails burns no number; a
 * checkout that succeeds can never re-issue one.
 *
 * The rules from §3.7.5 that this file is responsible for:
 *
 * - **Zero connectivity.** No call here touches the network. A device that has
 *   not seen the server in a week still rings sales.
 * - **A block is never reused and never returned.** `consumed_upto` only ever
 *   moves forward, and an exhausted block is closed rather than rewound.
 * - **Exhaustion must never stop trading.** Burning through a block mid-shift
 *   opens the next one in the same transaction. The exceptional case is
 *   visibly exceptional — a self-issued block's numbers carry the device tag.
 * - **Gaps are expected and reported.** `consumed_upto` is device-local state
 *   that is REPORTED, never authoritative; `readSequenceBlocks` is what a
 *   reconnect (and, later, an auditor's "which numbers were never issued")
 *   reads from.
 *
 * SERVER-ALLOCATED BLOCKS — the seam, now closed. `source: 'server'` rows are
 * the steady state §3.7.5 designs for, and this module consumes them in
 * preference to anything it issued itself. The allocator exists: the server's
 * `sequence.syncBlock` (apps/api/src/routers/sequence.ts) holds a row lock on
 * `app.sequence_counter` and hands down a disjoint range plus the tenant's
 * rendering configuration. The bottom half of this file is that conversation:
 * report the cursor on reconnect, adopt whatever block comes back.
 *
 * REGRESSION DETECTION IS NOT LOCAL, AND CANNOT BE. `consumed_upto` lives in
 * a local-only row. Evict OPFS, or reinstall the PWA on the same enrolled
 * device, and the row is gone while the server still shows the block live.
 * `buildBlockReport()` then truthfully answers "I hold nothing" — that null IS
 * the detection, and this layer must never paper over it, because only the
 * server holds the other half of the comparison. The server burns the block,
 * issues a fresh one and opens a severity-1 review naming the overlap range.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A WIPED DEVICE STILL TRADES. This is where two designs met and one won.
 * ─────────────────────────────────────────────────────────────────────────
 * The reporting half arrived with a rule that a device holding no block must
 * REFUSE to issue a number and wait for the server. That rule is right about
 * the danger — a self-issued block is one a wiped device re-issues from the
 * start — and wrong about the remedy: it stops a counter trading until the
 * radio comes back, in a market where the radio is down for days (CLAUDE.md
 * §2.2, §3.7.5's "exhaustion must never stop trading"). The disjointness a
 * server block buys with a row lock, a self-issued block buys with the DEVICE
 * TAG the formatter appends to every `source: 'device'` number
 * (`lib/receipt-number.ts`) — un-collidable by construction and visibly
 * exceptional on the paper, which is exactly §3.7.5's emergency form. So the
 * device self-issues and keeps trading, the report still goes up on reconnect,
 * and a collision that somehow still lands is detected server-side and lands
 * under review rather than stalling the outbox.
 */
import { needsReplacement, renderNumber, type NumberFormatSpec } from '@erp/sequence';
import type { DbExecutor, LocalDb } from './db';
import {
  formatReceiptNumber,
  type ReceiptNumberFormat,
} from '../lib/receipt-number';
import { uuidv7 } from '../lib/uuidv7';
import { readDeviceLocation, readReceiptFormat } from './queries/session';
import { nextQueueSeq } from './sync/queue-seq';

/** The receipt counter's key. Pack + tenant data (§3.7.5), not an enum. */
export const SEQUENCE_KEY_RECEIPT = 'RECEIPT';
/** The same key under the reporting half's spelling. One constant, two names. */
export const RECEIPT_SEQUENCE_KEY = SEQUENCE_KEY_RECEIPT;

/**
 * Size of a block this device issues to itself.
 *
 * §3.7.5 corrects its own earlier arithmetic here: 500 numbers against a busy
 * till's ~150–200 receipts/day is three to four days, not two weeks, so the
 * default is 2,000 and the real value is tenant- and location-type
 * configuration. A self-issued block's size costs nothing (it is not a scarce
 * server-held range), so a generous default simply means fewer block rollovers
 * on a device that never reaches a server.
 */
export const DEFAULT_LOCAL_BLOCK_SIZE = 2000n;

export type SequenceBlockSource = 'server' | 'device';

export interface SequenceBlockRow {
  readonly id: string;
  readonly sequenceKey: string;
  readonly locationId: string;
  readonly deviceNode: string;
  readonly source: SequenceBlockSource;
  readonly blockStart: bigint;
  readonly blockSize: bigint;
  readonly consumedUpto: bigint | null;
  readonly issuedAt: string;
  readonly exhaustedAt: string | null;
  /**
   * The tenant's rendering configuration, as the SERVER handed it down with
   * the block (`app.sequence_counter.number_format` / `.number_prefix` and
   * the location's own code). Null on a self-issued block, which has no
   * server configuration and renders through the device formatter instead.
   *
   * It lives on the BLOCK rather than in device configuration on purpose: a
   * block and the format its numbers were printed under must not be able to
   * drift apart, or a reprint of yesterday's receipt renders differently from
   * the paper the customer is holding.
   */
  readonly numberFormat: NumberFormatSpec | null;
  /** When the cursor was last REPORTED to the server; null = never. */
  readonly reportedAt: string | null;
}

function mapBlock(row: Record<string, unknown>): SequenceBlockRow {
  const consumed = row['consumed_upto'];
  const exhausted = row['exhausted_at'];
  const format = row['number_format'];
  const reported = row['reported_at'];
  return {
    id: String(row['id']),
    sequenceKey: String(row['sequence_key']),
    locationId: String(row['location_id']),
    deviceNode: String(row['device_node']),
    source: String(row['source']) === 'server' ? 'server' : 'device',
    // Counters cross SQLite as TEXT and become bigint exactly once, here —
    // the same discipline money columns get (§8.3). A block start beyond
    // 2^53 is not plausible, but "we only apply the rule where it bites" is
    // how the rule stops being applied.
    blockStart: BigInt(String(row['block_start'])),
    blockSize: BigInt(String(row['block_size'])),
    consumedUpto: consumed === null || consumed === undefined ? null : BigInt(String(consumed)),
    issuedAt: String(row['issued_at']),
    exhaustedAt: exhausted === null || exhausted === undefined ? null : String(exhausted),
    numberFormat:
      format === null || format === undefined || String(format).length === 0
        ? null
        : {
            format: String(format),
            prefix: String(row['number_prefix'] ?? ''),
            locationCode: String(row['location_code'] ?? ''),
          },
    reportedAt: reported === null || reported === undefined ? null : String(reported),
  };
}

const SELECT_COLS = `id, sequence_key, location_id, device_node, source,
        CAST(block_start AS TEXT) AS block_start,
        CAST(block_size AS TEXT) AS block_size,
        CAST(consumed_upto AS TEXT) AS consumed_upto,
        number_format, number_prefix, location_code,
        issued_at, exhausted_at, reported_at`;

export interface SequenceScope {
  readonly sequenceKey: string;
  readonly locationId: string;
}

/** Every block this device holds for a counter, oldest range first. */
export async function readSequenceBlocks(
  db: DbExecutor,
  scope: SequenceScope,
): Promise<SequenceBlockRow[]> {
  const rows = await db.getAll(
    `SELECT ${SELECT_COLS}
       FROM sequence_block
      WHERE sequence_key = ? AND location_id = ?
      ORDER BY block_start ASC`,
    [scope.sequenceKey, scope.locationId],
  );
  return rows.map((r) => mapBlock(r as unknown as Record<string, unknown>));
}

/**
 * The live block, or null. Highest range wins: the local schema's partial
 * unique index makes two open blocks unrepresentable, but PowerSync's own
 * schema builder does not create indexes, so the QUERY is deterministic on
 * its own rather than leaning on a guard that exists only in tests.
 */
export async function readOpenBlock(
  db: DbExecutor,
  scope: SequenceScope,
): Promise<SequenceBlockRow | null> {
  const rows = await db.getAll(
    `SELECT ${SELECT_COLS}
       FROM sequence_block
      WHERE sequence_key = ? AND location_id = ? AND exhausted_at IS NULL
      ORDER BY block_start DESC
      LIMIT 1`,
    [scope.sequenceKey, scope.locationId],
  );
  const row = rows[0];
  return row === undefined ? null : mapBlock(row as unknown as Record<string, unknown>);
}

/**
 * The block this device is consuming, or null.
 *
 * Null is the honest answer in two very different situations — a device that
 * has never been given a block, and a device whose local database was wiped —
 * and this layer cannot tell them apart. Only the server can, which is exactly
 * why the report below is sent and the comparison happens there.
 */
export async function readCurrentBlock(
  db: DbExecutor,
  locationId: string,
  sequenceKey: string = SEQUENCE_KEY_RECEIPT,
): Promise<SequenceBlockRow | null> {
  return readOpenBlock(db, { sequenceKey, locationId });
}

export interface IssueBlockInput extends SequenceScope {
  readonly id: string;
  readonly deviceNode: string;
  readonly nowIso: string;
  readonly source?: SequenceBlockSource;
  readonly blockSize?: bigint;
  /** Server-allocated ranges say where they start; a self-issued one follows on. */
  readonly blockStart?: bigint;
  /** The rendering configuration a server-allocated block arrives with. */
  readonly numberFormat?: NumberFormatSpec;
}

/**
 * Record a block. A self-issued block starts one past the highest range this
 * device has ever held for the counter, so its own numbers never repeat even
 * across a rollover — cross-DEVICE disjointness is the formatter's job.
 */
export async function issueSequenceBlock(
  db: DbExecutor,
  input: IssueBlockInput,
): Promise<SequenceBlockRow> {
  const size = input.blockSize ?? DEFAULT_LOCAL_BLOCK_SIZE;
  if (size <= 0n) throw new Error(`block size must be positive, got ${size.toString()}`);

  let start = input.blockStart;
  if (start === undefined) {
    const rows = await db.getAll(
      `SELECT CAST(COALESCE(MAX(block_start + block_size), 0) AS TEXT) AS next_start
         FROM sequence_block
        WHERE sequence_key = ? AND location_id = ?`,
      [input.sequenceKey, input.locationId],
    );
    const next = BigInt(String(rows[0]?.['next_start'] ?? '0'));
    start = next > 0n ? next : 1n;
  }

  const spec = input.numberFormat ?? null;
  await db.execute(
    `INSERT INTO sequence_block
       (id, sequence_key, location_id, device_node, source, block_start, block_size,
        consumed_upto, number_format, number_prefix, location_code,
        issued_at, exhausted_at, reported_at)
     VALUES (?, ?, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), NULL, ?, ?, ?, ?, NULL, NULL)`,
    [
      input.id,
      input.sequenceKey,
      input.locationId,
      input.deviceNode,
      input.source ?? 'device',
      start.toString(),
      size.toString(),
      spec?.format ?? null,
      spec?.prefix ?? null,
      spec?.locationCode ?? null,
      input.nowIso,
    ],
  );
  return {
    id: input.id,
    sequenceKey: input.sequenceKey,
    locationId: input.locationId,
    deviceNode: input.deviceNode,
    source: input.source ?? 'device',
    blockStart: start,
    blockSize: size,
    consumedUpto: null,
    issuedAt: input.nowIso,
    exhaustedAt: null,
    numberFormat: spec,
    reportedAt: null,
  };
}

export interface AllocateReceiptInput {
  readonly locationId: string;
  readonly locationCode: string;
  readonly deviceNode: string;
  readonly format: ReceiptNumberFormat;
  readonly nowIso: string;
  /** UUID minter for a newly issued block row. Injected for deterministic tests. */
  readonly newId: () => string;
  readonly sequenceKey?: string;
}

export interface AllocatedReceipt {
  readonly receiptNo: string;
  readonly seq: bigint;
  readonly blockId: string;
  readonly source: SequenceBlockSource;
}

/**
 * Draw the next number, issuing a block first if there is none or if the
 * current one is spent. MUST be called inside the caller's write transaction.
 */
export async function allocateReceiptNumber(
  tx: DbExecutor,
  input: AllocateReceiptInput,
): Promise<AllocatedReceipt> {
  const scope: SequenceScope = {
    sequenceKey: input.sequenceKey ?? SEQUENCE_KEY_RECEIPT,
    locationId: input.locationId,
  };

  let block = await readOpenBlock(tx, scope);
  if (block === null) {
    block = await issueSequenceBlock(tx, {
      ...scope,
      id: input.newId(),
      deviceNode: input.deviceNode,
      nowIso: input.nowIso,
    });
  }

  const lastInBlock = block.blockStart + block.blockSize - 1n;
  const next = block.consumedUpto === null ? block.blockStart : block.consumedUpto + 1n;

  if (next > lastInBlock) {
    // Spent. Close it and open the next one in this same transaction —
    // exhaustion must never stop trading (§3.7.5).
    await tx.execute(`UPDATE sequence_block SET exhausted_at = ? WHERE id = ?`, [
      input.nowIso,
      block.id,
    ]);
    const fresh = await issueSequenceBlock(tx, {
      ...scope,
      id: input.newId(),
      deviceNode: input.deviceNode,
      nowIso: input.nowIso,
    });
    return consume(tx, fresh, fresh.blockStart, input);
  }

  return consume(tx, block, next, input);
}

/**
 * Render one number from one block.
 *
 * TWO RENDERERS, ONE PER SOURCE, and the split is not an accident of two
 * histories — it is `source` doing the job it exists for:
 *
 *   'server'  the block arrived with the tenant's own `number_format` from
 *             `app.sequence_counter`, and it is rendered by `@erp/sequence`,
 *             the SAME module the server and the drills render with. One
 *             rendering of a tenant's format across all three, so the paper in
 *             a customer's hand cannot disagree with the books.
 *   'device'  the block was self-issued, so there is no server configuration
 *             to render from and the number must carry the device tag that
 *             makes it un-collidable. `formatReceiptNumber` appends that tag
 *             whether or not the template asked for it — configuration must
 *             not be able to switch a uniqueness guarantee off.
 */
function renderFor(
  block: SequenceBlockRow,
  seq: bigint,
  input: AllocateReceiptInput,
): string {
  if (block.source === 'server' && block.numberFormat !== null) {
    const spec = block.numberFormat;
    return renderNumber(
      {
        format: spec.format,
        prefix: spec.prefix,
        // The block's own location code, falling back to the device's, so a
        // block issued before the location row synced still renders.
        locationCode: spec.locationCode.length > 0 ? spec.locationCode : input.locationCode,
      },
      seq,
    );
  }
  return formatReceiptNumber(input.format, {
    locationCode: input.locationCode,
    seq,
    deviceNode: input.deviceNode,
    source: block.source,
  });
}

async function consume(
  tx: DbExecutor,
  block: SequenceBlockRow,
  seq: bigint,
  input: AllocateReceiptInput,
): Promise<AllocatedReceipt> {
  const receiptNo = renderFor(block, seq, input);

  const lastInBlock = block.blockStart + block.blockSize - 1n;
  // consumed_upto only ever moves FORWARD; the guard makes a rewind
  // unwritable rather than merely unintended.
  await tx.execute(
    `UPDATE sequence_block
        SET consumed_upto = CAST(? AS INTEGER),
            exhausted_at  = CASE WHEN ? THEN ? ELSE exhausted_at END
      WHERE id = ? AND (consumed_upto IS NULL OR consumed_upto < CAST(? AS INTEGER))`,
    [
      seq.toString(),
      seq >= lastInBlock ? 1 : 0,
      input.nowIso,
      block.id,
      seq.toString(),
    ],
  );

  return { receiptNo, seq, blockId: block.id, source: block.source };
}

// ---------------------------------------------------------------------------
// The reconnect conversation with the server's allocator
//
// Everything above this line runs with the radio off. Everything below it is
// about what the device SAYS on reconnect and what it does with the answer —
// and none of it is on the path that prints a receipt.
// ---------------------------------------------------------------------------

/** The outbox `kind` a block report rides under (transport.ts WIRE_KINDS). */
export const SEQUENCE_REPORT_OP_KIND = 'sequence_block';

export interface TakenNumber {
  /** The rendered number to print. */
  readonly receiptNo: string;
  /** The ordinal drawn from the block. */
  readonly n: bigint;
  /**
   * True when the number came from a SELF-ISSUED block — §3.7.5's emergency
   * form. The exceptional case is visibly exceptional: the device tag is on
   * the receipt and `source` is on the record, and the reconnect report tells
   * the server about it.
   */
  readonly emergency: boolean;
  readonly blockId: string;
}

/**
 * Draw the next number when the caller holds no transaction of its own.
 *
 * `checkout` does hold one and calls `allocateReceiptNumber` directly, which
 * is what keeps "the number is burned" and "the sale is queued" atomic. This
 * wrapper exists for the paths that have no such unit of work (a reprint test,
 * a drill). It delegates rather than duplicating: two functions advancing one
 * cursor is how a counter hands two customers the same number.
 */
export async function takeNumber(
  db: LocalDb,
  input: {
    readonly locationId: string;
    /** The device's HLC node id, or any 32-hex identifier (dashes ignored). */
    readonly deviceId: string;
    readonly locationCode?: string;
    readonly format?: ReceiptNumberFormat;
    readonly sequenceKey?: string;
    readonly nowIso?: string;
    readonly newId?: () => string;
  },
): Promise<TakenNumber> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const deviceNode = input.deviceId.replace(/-/g, '').toLowerCase();
  const result = await db.writeTransaction(async (tx) => {
    const locationCode =
      input.locationCode ?? (await readDeviceLocation(tx))?.code ?? '';
    const format = input.format ?? (await readReceiptFormat(tx));
    return allocateReceiptNumber(tx, {
      locationId: input.locationId,
      locationCode,
      deviceNode,
      format,
      nowIso,
      newId: input.newId ?? uuidv7,
      ...(input.sequenceKey === undefined ? {} : { sequenceKey: input.sequenceKey }),
    });
  });
  db.changes.notify();
  return {
    receiptNo: result.receiptNo,
    n: result.seq,
    emergency: result.source === 'device',
    blockId: result.blockId,
  };
}

/** A block as `sequence.syncBlock` hands it down. Counters are strings. */
export interface IssuedBlock {
  readonly blockStart: string;
  readonly blockSize: number;
}

/** The tenant's rendering configuration, as the server hands it down. */
export interface IssuedFormat {
  readonly format: string;
  readonly prefix: string;
  readonly locationCode: string;
}

export interface AdoptBlockInput {
  readonly locationId: string;
  readonly block: IssuedBlock;
  readonly format: IssuedFormat;
  readonly sequenceKey?: string;
  readonly deviceNode?: string;
  readonly nowIso?: string;
  readonly newId?: () => string;
}

/**
 * Adopt the block the server issued, retiring whatever this device was on.
 *
 * Retiring is the correct behaviour even when the local row looked healthy: if
 * the server issued a replacement it has already BURNED the incumbent, and
 * numbering on from a burned block is precisely the divergence this mechanism
 * exists to stop.
 *
 * The incumbent is CLOSED, not deleted. Its range and its high-water mark are
 * the record of which numbers were issued and which were never used — §3.7.5
 * requires gaps be reportable, and a deleted row reports nothing. The partial
 * unique index still guarantees exactly one OPEN block per counter.
 */
export async function adoptBlock(db: LocalDb, input: AdoptBlockInput): Promise<SequenceBlockRow> {
  const sequenceKey = input.sequenceKey ?? SEQUENCE_KEY_RECEIPT;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const newId = input.newId ?? uuidv7;
  const row = await db.writeTransaction(async (tx) => {
    await tx.execute(
      `UPDATE sequence_block SET exhausted_at = ?
        WHERE sequence_key = ? AND location_id = ? AND exhausted_at IS NULL`,
      [nowIso, sequenceKey, input.locationId],
    );
    return issueSequenceBlock(tx, {
      sequenceKey,
      locationId: input.locationId,
      id: newId(),
      deviceNode: input.deviceNode ?? '',
      source: 'server',
      nowIso,
      blockStart: BigInt(input.block.blockStart),
      blockSize: BigInt(input.block.blockSize),
      numberFormat: {
        format: input.format.format,
        prefix: input.format.prefix,
        locationCode: input.format.locationCode,
      },
    });
  });
  db.changes.notify();
  return row;
}

export interface BlockReport {
  readonly blockStart: string;
  readonly consumedUpto: string | null;
}

export interface SyncBlockPayload extends Record<string, unknown> {
  readonly locationId: string;
  readonly sequenceKey: string;
  /** null = "I hold no block" — the wipe signature the server detects. */
  readonly report: BlockReport | null;
  readonly wantBlock: boolean;
}

/**
 * Build the payload for `sequence.sync_block`.
 *
 * Reporting null is not a bug and must never be papered over locally: it is
 * the device saying, truthfully, that it does not know. The server holds the
 * other half of the comparison and is the only place the two can be reconciled.
 *
 * A SELF-ISSUED block is reported exactly like a server-issued one. Its start
 * is not a range the server handed out, so the server answers UNKNOWN_BLOCK,
 * burns it and issues a real one — which is the right outcome: the device was
 * trading on numbers nobody allocated, and now a human is told.
 */
export async function buildBlockReport(
  db: DbExecutor,
  input: {
    readonly locationId: string;
    readonly sequenceKey?: string;
    readonly observedPerDay?: number;
  },
): Promise<SyncBlockPayload> {
  const sequenceKey = input.sequenceKey ?? SEQUENCE_KEY_RECEIPT;
  const block = await readCurrentBlock(db, input.locationId, sequenceKey);

  if (block === null) {
    return { locationId: input.locationId, sequenceKey, report: null, wantBlock: true };
  }
  return {
    locationId: input.locationId,
    sequenceKey,
    report: {
      blockStart: block.blockStart.toString(10),
      consumedUpto: block.consumedUpto?.toString(10) ?? null,
    },
    // A self-issued block is always replaced at the first opportunity: it is
    // the fallback, never the steady state.
    wantBlock:
      block.source === 'device' ||
      needsReplacement(
        { blockStart: block.blockStart, blockSize: Number(block.blockSize) },
        block.consumedUpto,
        input.observedPerDay === undefined ? {} : { observedPerDay: input.observedPerDay },
      ),
  };
}

/**
 * Queue the reconnect report into the ORDERED outbox.
 *
 * It rides the same queue as sales, oldest-first, so a report queued before a
 * batch of sales reaches the server before them. Sending it out of band would
 * let a batch of sales arrive before the server ever learned the cursor moved.
 */
export async function enqueueBlockReport(
  db: LocalDb,
  input: {
    readonly locationId: string;
    readonly claimedHlc: string;
    readonly sequenceKey?: string;
    readonly observedPerDay?: number;
    readonly nowIso?: string;
    readonly newId?: () => string;
  },
): Promise<string> {
  const sequenceKey = input.sequenceKey ?? SEQUENCE_KEY_RECEIPT;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const key = (input.newId ?? uuidv7)();
  await db.writeTransaction(async (tx) => {
    const payload = await buildBlockReport(tx, {
      locationId: input.locationId,
      sequenceKey,
      ...(input.observedPerDay === undefined ? {} : { observedPerDay: input.observedPerDay }),
    });
    // The queue position (data/sync/queue-seq.ts). THE ORDERING THIS FUNCTION
    // DOCUMENTS RESTS ON IT: the report must reach the server before the sales
    // queued after it, and until this column existed that held only when the
    // two did not share a millisecond — and, for a sale whose id was minted at
    // cart-open, not even then.
    const queueSeq = await nextQueueSeq(tx);
    await tx.execute(
      `INSERT INTO outbox
         (id, idempotency_key, claimed_hlc, kind, payload, total_minor, receipt_no,
          tendered_minor, change_minor, created_at, queue_seq,
          server_ack_at, rejected_at, reject_reason)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
      [
        key,
        key,
        input.claimedHlc,
        SEQUENCE_REPORT_OP_KIND,
        JSON.stringify(payload),
        nowIso,
        queueSeq,
      ],
    );
    // What we told the server, and when. The gap between this and
    // `consumed_upto` is the window a wipe would otherwise hide.
    await tx.execute(
      `UPDATE sequence_block SET reported_at = ?
        WHERE sequence_key = ? AND location_id = ? AND exhausted_at IS NULL`,
      [nowIso, sequenceKey, input.locationId],
    );
  });
  db.changes.notify();
  return key;
}

/** The shape `sequence.syncBlock` returns (apps/api/src/routers/sequence.ts). */
export interface SyncBlockResult {
  readonly status: string;
  readonly block: (IssuedBlock & { readonly nextNumber: string | null }) | null;
  readonly format: IssuedFormat | null;
  readonly review: {
    readonly id: string;
    readonly overlapFrom: string;
    readonly overlapTo: string;
  } | null;
}

function isSyncBlockResult(value: unknown): value is SyncBlockResult {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec['status'] === 'string' && 'block' in rec && 'format' in rec;
}

export interface AdoptionOutcome {
  readonly adopted: boolean;
  /** True when the server reported a regression — the old block was burned. */
  readonly regression: boolean;
  readonly reviewId: string | null;
}

/**
 * Apply the server's answer to a queued block report.
 *
 * The device adopts whatever block it is given, unconditionally. That is not
 * trust for its own sake: after a regression the server has already BURNED the
 * block this device thought it held, so keeping the local row would mean
 * printing from a range that no longer exists — the divergence, still running,
 * now with the server's knowledge of it sitting in a review queue.
 *
 * A result the device cannot parse is ignored rather than guessed at: the next
 * reconnect reports again, and the server is still the only place the two
 * cursors are compared.
 */
export async function applySyncBlockResult(
  db: LocalDb,
  payloadJson: string,
  result: unknown,
  options: { readonly deviceNode?: string; readonly nowIso?: string } = {},
): Promise<AdoptionOutcome> {
  if (!isSyncBlockResult(result) || result.block === null || result.format === null) {
    return { adopted: false, regression: false, reviewId: null };
  }
  let payload: { locationId?: unknown; sequenceKey?: unknown };
  try {
    payload = JSON.parse(payloadJson) as typeof payload;
  } catch {
    return { adopted: false, regression: false, reviewId: null };
  }
  const locationId = payload.locationId;
  if (typeof locationId !== 'string') {
    return { adopted: false, regression: false, reviewId: null };
  }
  const sequenceKey =
    typeof payload.sequenceKey === 'string' ? payload.sequenceKey : SEQUENCE_KEY_RECEIPT;
  const regression = result.status === 'regression';
  const reviewId = result.review?.id ?? null;

  const current = await readCurrentBlock(db, locationId, sequenceKey);
  const issued = BigInt(result.block.blockStart);
  if (current !== null && current.source === 'server' && current.blockStart === issued) {
    // Same block, still ours: the report was routine and the cursor stands.
    return { adopted: false, regression, reviewId };
  }

  await adoptBlock(db, {
    locationId,
    sequenceKey,
    block: { blockStart: result.block.blockStart, blockSize: result.block.blockSize },
    format: result.format,
    ...(options.deviceNode === undefined ? {} : { deviceNode: options.deviceNode }),
    ...(options.nowIso === undefined ? {} : { nowIso: options.nowIso }),
  });
  return { adopted: true, regression, reviewId };
}

/**
 * The `onResult` handler for the outbox drain (sync/upload.ts DrainOptions).
 * Wired in at the runtime so an acked block report immediately becomes the
 * block the counter uses.
 */
export function sequenceResultHandler(
  db: LocalDb,
  onRegression?: (outcome: AdoptionOutcome) => void,
  options: { readonly deviceNode?: string } = {},
): (op: { readonly kind: string; readonly payloadJson: string }, result: unknown) => Promise<void> {
  return async (op, result) => {
    if (op.kind !== SEQUENCE_REPORT_OP_KIND) return;
    const outcome = await applySyncBlockResult(db, op.payloadJson, result, options);
    if (outcome.regression && onRegression !== undefined) onRegression(outcome);
  };
}
