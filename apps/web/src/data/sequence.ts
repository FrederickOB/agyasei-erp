/**
 * Receipt numbers at the till (03-offline-sync §3.7.5).
 *
 * The device consumes its block with NO NETWORK AT ALL — `takeNumber()` is a
 * single local transaction and never awaits a socket, because a counter that
 * needs connectivity to print a receipt is a counter that stops trading when
 * the line goes down.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT IS NOT.
 * Blocks are ALLOCATED BY THE SERVER (`sequence.syncBlock`, api/src/routers/
 * sequence.ts) and never self-issued here. That is the whole point: a
 * self-issued block is one a wiped device re-issues from the start, printing
 * numbers another customer already holds. This module's job is to consume the
 * block it was given, to REPORT how far it got on every reconnect, and to
 * accept the consequences when the server says the two disagree.
 *
 * THE WIPE. `consumed_upto` lives in the local `sequence_block` row. Evict
 * OPFS, or reinstall the PWA on the same enrolled device, and that row is gone
 * while the server still shows the block live. `buildBlockReport()` then
 * returns null, the server detects the regression, burns the remainder, issues
 * a fresh block and opens a severity-1 review naming the overlap range. The
 * device adopts the replacement and carries on — it does NOT keep numbering
 * from a block the server has destroyed.
 *
 * ORDERING MATTERS. The report is queued in the SAME ordered outbox as sales
 * (§3.3), oldest-first, so a report queued before a batch of sales reaches the
 * server before them. It is not a side channel.
 *
 * FORMAT IS DATA. `{location_code}-{prefix}-{n:06d}` is a value the server
 * hands down from `app.sequence_counter`; rendering goes through @erp/sequence,
 * the same module the server uses. Nothing here reads a country or a tenant
 * (CLAUDE.md §2.5, §2.9).
 */
import {
  blockEnd,
  emergencyNumber,
  needsReplacement,
  nextNumber,
  renderNumber,
  type NumberFormatSpec,
} from '@erp/sequence';
import type { DbExecutor, LocalDb } from './db';
import { uuidv7 } from '../lib/uuidv7';

/** The only sequence this phase issues. Pack + tenant vocabulary, not an enum. */
export const RECEIPT_SEQUENCE_KEY = 'RECEIPT';

/** The device's current block, as held locally. */
export interface LocalBlock {
  readonly sequenceKey: string;
  readonly locationId: string;
  readonly blockStart: bigint;
  readonly blockSize: number;
  readonly consumedUpto: bigint | null;
  readonly format: NumberFormatSpec;
}

/** What `sequence.syncBlock` hands back for the device to adopt. */
export interface IssuedBlock {
  readonly blockStart: string;
  readonly blockSize: number;
}

export interface IssuedFormat {
  readonly format: string;
  readonly prefix: string;
  readonly locationCode: string;
}

export class NoBlockError extends Error {
  constructor(readonly locationId: string) {
    super(
      `no receipt-number block on this device for location ${locationId} — ` +
        `blocks are allocated by the server and are never self-issued (03 §3.7.5)`,
    );
    this.name = 'NoBlockError';
  }
}

// ---------------------------------------------------------------------------
// Local block state
// ---------------------------------------------------------------------------

function rowToBlock(row: Record<string, unknown>): LocalBlock {
  return {
    sequenceKey: String(row['sequence_key']),
    locationId: String(row['location_id']),
    blockStart: BigInt(String(row['block_start'])),
    blockSize: Number(row['block_size']),
    consumedUpto: row['consumed_upto'] === null ? null : BigInt(String(row['consumed_upto'])),
    format: {
      format: String(row['number_format']),
      prefix: String(row['number_prefix']),
      locationCode: String(row['location_code']),
    },
  };
}

/**
 * The block this device is consuming, or null.
 *
 * Null is the honest answer in two very different situations — a device that
 * has never been given a block, and a device whose local database was wiped —
 * and this layer cannot tell them apart. Only the server can, which is exactly
 * why the report is sent and the comparison happens there.
 */
export async function readCurrentBlock(
  db: DbExecutor,
  locationId: string,
  sequenceKey: string = RECEIPT_SEQUENCE_KEY,
): Promise<LocalBlock | null> {
  const rows = await db.getAll(
    `SELECT sequence_key, location_id,
            CAST(block_start AS TEXT) AS block_start,
            block_size,
            CAST(consumed_upto AS TEXT) AS consumed_upto,
            number_format, number_prefix, location_code
       FROM sequence_block
      WHERE sequence_key = ? AND location_id = ?
      LIMIT 1`,
    [sequenceKey, locationId],
  );
  const row = rows[0];
  return row === undefined ? null : rowToBlock(row);
}

/**
 * Adopt the block the server issued, replacing whatever was here.
 *
 * Replacing is the correct behaviour even when the local row looked fine: if
 * the server issued a new block it has already burned the old one, and
 * continuing to number from a burned block is precisely the divergence this
 * mechanism exists to stop.
 */
export async function adoptBlock(
  db: LocalDb,
  input: {
    readonly locationId: string;
    readonly sequenceKey?: string;
    readonly block: IssuedBlock;
    readonly format: IssuedFormat;
    readonly nowIso?: string;
  },
): Promise<void> {
  const sequenceKey = input.sequenceKey ?? RECEIPT_SEQUENCE_KEY;
  const nowIso = input.nowIso ?? new Date().toISOString();
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM sequence_block WHERE sequence_key = ? AND location_id = ?', [
      sequenceKey,
      input.locationId,
    ]);
    await tx.execute(
      `INSERT INTO sequence_block
         (id, sequence_key, location_id, block_start, block_size, consumed_upto,
          number_format, number_prefix, location_code, issued_at, reported_at)
       VALUES (?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), NULL, ?, ?, ?, ?, NULL)`,
      [
        uuidv7(),
        sequenceKey,
        input.locationId,
        input.block.blockStart,
        String(input.block.blockSize),
        input.format.format,
        input.format.prefix,
        input.format.locationCode,
        nowIso,
      ],
    );
  });
  db.changes.notify();
}

// ---------------------------------------------------------------------------
// Consuming — the counter path. No network on it, ever.
// ---------------------------------------------------------------------------

export interface TakenNumber {
  /** The rendered number to print. */
  readonly receiptNo: string;
  /** The raw ordinal, or null when this is an emergency-form number. */
  readonly n: bigint | null;
  /**
   * True when the block ran out mid-partition and §3.7.5's emergency form was
   * used. The exceptional case is visibly exceptional: marked on the receipt
   * AND on the record, and reconciled on sync.
   */
  readonly emergency: boolean;
}

/**
 * Issue the next number, in one local transaction.
 *
 * "Exhaustion must never stop trading" (§3.7.5). A device that burns through
 * its block while offline does NOT stop, and does NOT quietly wrap onto numbers
 * it does not own: it switches to the emergency form, derived from the device
 * id and the sale, which cannot collide with an allocated number because it is
 * not one.
 */
export async function takeNumber(
  db: LocalDb,
  input: {
    readonly locationId: string;
    readonly deviceId: string;
    /** Disambiguates two emergency numbers from one device (use the sale id). */
    readonly discriminator: string;
    readonly sequenceKey?: string;
  },
): Promise<TakenNumber> {
  const sequenceKey = input.sequenceKey ?? RECEIPT_SEQUENCE_KEY;

  return db.writeTransaction(async (tx) => {
    const block = await readCurrentBlock(tx, input.locationId, sequenceKey);
    if (block === null) throw new NoBlockError(input.locationId);

    const n = nextNumber(block, block.consumedUpto);
    if (n === null) {
      // Spent. Trade on, visibly exceptionally, off the last number in the
      // block — the receipt still sorts where a human expects it to.
      return {
        receiptNo: emergencyNumber(
          renderNumber(block.format, blockEnd(block)),
          input.deviceId,
          input.discriminator,
        ),
        n: null,
        emergency: true,
      };
    }

    // The cursor advances in the SAME transaction that mints the number, so a
    // battery pull between the two cannot hand the next customer a number this
    // one already has.
    await tx.execute(
      `UPDATE sequence_block SET consumed_upto = CAST(? AS INTEGER)
        WHERE sequence_key = ? AND location_id = ?`,
      [n.toString(10), sequenceKey, input.locationId],
    );
    return { receiptNo: renderNumber(block.format, n), n, emergency: false };
  });
}

// ---------------------------------------------------------------------------
// Reporting — the reconnect conversation
// ---------------------------------------------------------------------------

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
 * Reporting null is not a bug and must never be papered over locally: it is the
 * device saying, truthfully, that it does not know. The server holds the other
 * half of the comparison and is the only place the two can be reconciled.
 */
export async function buildBlockReport(
  db: DbExecutor,
  input: { readonly locationId: string; readonly sequenceKey?: string; readonly observedPerDay?: number },
): Promise<SyncBlockPayload> {
  const sequenceKey = input.sequenceKey ?? RECEIPT_SEQUENCE_KEY;
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
    // §3.7.5, corrected on review: ask by DAYS of observed throughput, not a
    // flat percentage — 500 numbers is three to four days at a flagship till.
    wantBlock: needsReplacement(
      block,
      block.consumedUpto,
      input.observedPerDay === undefined ? {} : { observedPerDay: input.observedPerDay },
    ),
  };
}

/**
 * Queue the reconnect report into the ordered outbox.
 *
 * It rides the same queue as sales, oldest-first, so it lands ahead of the
 * sales queued after it. Sending it out of band would let a batch of sales
 * arrive before the server ever learned the cursor had moved.
 */
export async function enqueueBlockReport(
  db: LocalDb,
  input: {
    readonly locationId: string;
    readonly claimedHlc: string;
    readonly sequenceKey?: string;
    readonly observedPerDay?: number;
    readonly nowIso?: string;
  },
): Promise<string> {
  const payload = await buildBlockReport(db, {
    locationId: input.locationId,
    ...(input.sequenceKey === undefined ? {} : { sequenceKey: input.sequenceKey }),
    ...(input.observedPerDay === undefined ? {} : { observedPerDay: input.observedPerDay }),
  });
  const key = uuidv7();
  const nowIso = input.nowIso ?? new Date().toISOString();
  await db.execute(
    `INSERT INTO outbox
       (id, idempotency_key, claimed_hlc, kind, payload, total_minor,
        created_at, server_ack_at, rejected_at, reject_reason)
     VALUES (?, ?, ?, 'sequence_block', ?, NULL, ?, NULL, NULL, NULL)`,
    [key, key, input.claimedHlc, JSON.stringify(payload), nowIso],
  );
  db.changes.notify();
  return key;
}

// ---------------------------------------------------------------------------
// Adoption — what the device does with the server's answer
// ---------------------------------------------------------------------------

/** The shape `sequence.syncBlock` returns (api/src/routers/sequence.ts). */
export interface SyncBlockResult {
  readonly status: string;
  readonly block: (IssuedBlock & { readonly nextNumber: string | null }) | null;
  readonly format: IssuedFormat | null;
  readonly review: { readonly id: string; readonly overlapFrom: string; readonly overlapTo: string } | null;
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
 * printing numbers from a range that no longer exists — the divergence, still
 * running, now with the server's knowledge of it sitting in a review queue.
 *
 * A result the device cannot parse is ignored rather than guessed at: the next
 * reconnect reports again, and the server is still the only place the two
 * cursors are compared.
 */
export async function applySyncBlockResult(
  db: LocalDb,
  payloadJson: string,
  result: unknown,
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
    typeof payload.sequenceKey === 'string' ? payload.sequenceKey : RECEIPT_SEQUENCE_KEY;

  const current = await readCurrentBlock(db, locationId, sequenceKey);
  const issued = BigInt(result.block.blockStart);
  if (current !== null && current.blockStart === issued) {
    // Same block, still ours: the report was routine and the cursor stands.
    return { adopted: false, regression: result.status === 'regression', reviewId: result.review?.id ?? null };
  }

  await adoptBlock(db, {
    locationId,
    sequenceKey,
    block: { blockStart: result.block.blockStart, blockSize: result.block.blockSize },
    format: result.format,
  });
  return {
    adopted: true,
    regression: result.status === 'regression',
    reviewId: result.review?.id ?? null,
  };
}

/**
 * The `onResult` handler for the outbox drain (sync/upload.ts DrainOptions).
 * Wired in at the runtime so an acked block report immediately becomes the
 * block the counter uses.
 */
export function sequenceResultHandler(
  db: LocalDb,
  onRegression?: (outcome: AdoptionOutcome) => void,
): (op: { readonly kind: string; readonly payloadJson: string }, result: unknown) => Promise<void> {
  return async (op, result) => {
    if (op.kind !== 'sequence_block') return;
    const outcome = await applySyncBlockResult(db, op.payloadJson, result);
    if (outcome.regression && onRegression !== undefined) onRegression(outcome);
  };
}
