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
 * SEAM — server-allocated blocks. `source: 'server'` rows are the steady state
 * §3.7.5 designs for, and this module already consumes them in preference to
 * anything it issued itself. What does not exist yet is the server side: there
 * is no `sequence_block` table in `packages/db/migrations` and no allocation
 * endpoint, so today every block is self-issued. When the allocator lands,
 * insert its blocks with `source: 'server'` and the printed numbers lose the
 * device tag with no other change here.
 */
import type { DbExecutor } from './db';
import {
  formatReceiptNumber,
  type ReceiptNumberFormat,
} from '../lib/receipt-number';

/** The receipt counter's key. Pack + tenant data (§3.7.5), not an enum. */
export const SEQUENCE_KEY_RECEIPT = 'RECEIPT';

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
}

function mapBlock(row: Record<string, unknown>): SequenceBlockRow {
  const consumed = row['consumed_upto'];
  const exhausted = row['exhausted_at'];
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
  };
}

const SELECT_COLS = `id, sequence_key, location_id, device_node, source,
        CAST(block_start AS TEXT) AS block_start,
        CAST(block_size AS TEXT) AS block_size,
        CAST(consumed_upto AS TEXT) AS consumed_upto,
        issued_at, exhausted_at`;

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
async function readOpenBlock(
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

export interface IssueBlockInput extends SequenceScope {
  readonly id: string;
  readonly deviceNode: string;
  readonly nowIso: string;
  readonly source?: SequenceBlockSource;
  readonly blockSize?: bigint;
  /** Server-allocated ranges say where they start; a self-issued one follows on. */
  readonly blockStart?: bigint;
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

  await db.execute(
    `INSERT INTO sequence_block
       (id, sequence_key, location_id, device_node, source, block_start, block_size,
        consumed_upto, issued_at, exhausted_at)
     VALUES (?, ?, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), NULL, ?, NULL)`,
    [
      input.id,
      input.sequenceKey,
      input.locationId,
      input.deviceNode,
      input.source ?? 'device',
      start.toString(),
      size.toString(),
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

async function consume(
  tx: DbExecutor,
  block: SequenceBlockRow,
  seq: bigint,
  input: AllocateReceiptInput,
): Promise<AllocatedReceipt> {
  const receiptNo = formatReceiptNumber(input.format, {
    locationCode: input.locationCode,
    seq,
    deviceNode: input.deviceNode,
    source: block.source,
  });

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
