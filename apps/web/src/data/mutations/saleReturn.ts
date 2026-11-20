/**
 * Voids and returns at the counter — ONE local transaction each, like
 * checkout, and riding the same ordered outbox (`sale_return` →
 * `sale.return`; migration 0030; 08 §8.7).
 *
 * Inside the transaction:
 *   1. read the open till (no till, no refund — a refund leaves a drawer);
 *   2. read what can still come back of the sale (data/queries/returns.ts);
 *   3. draw a number for the return slip from this device's receipt block —
 *      the same series as receipts, so the continuity monitor accounts for it;
 *   4. build the payload as the shared contract's type and PARSE it;
 *   5. insert the outbox row: `total_minor` the refund (a magnitude),
 *      `drawer_minor` the cash leaving THIS till (NEGATIVE), so cash-up's
 *      expected figure falls by exactly what was handed back.
 *
 * WHAT A VOID IS HERE: the whole sale, in the till it was rung in, before
 * anything of it has come back. A void states no lines and no split — the
 * server reverses exactly what it recorded, and the money goes back the way it
 * came. That is also why a sale rung minutes ago and not yet synced CAN be
 * voided offline: nothing about it needs pricing.
 *
 * WHAT A RETURN IS HERE: some lines, some quantity, from today's till at the
 * same location, once the sale's lines have synced. Priced from the sale's own
 * snapshot by the server's rule; on account first, the rest through the method
 * the counter chose. The device's split is a CLAIM the server compares.
 *
 * Refusals happen HERE, while the customer is still at the counter, so the
 * server never has to refuse a refund that has already been paid.
 */
import { createSaleReturnInput, type CreateSaleReturnInput } from '@erp/contracts';
import { serializeMoney } from '@erp/money';
import { deviceNodeFromClaimedHlc, type ClaimedHlcClock } from '../../lib/hlc';
import { uuidv7 } from '../../lib/uuidv7';
import type { DbExecutor, LocalDb } from '../db';
import { loadReturnableSale, priceReturn, type PricedReturn, type ReturnPick } from '../queries/returns';
import { readDeviceLocation, readReceiptFormat } from '../queries/session';
import type { TenderMethod } from '../queries/tender-methods';
import { allocateReceiptNumber } from '../sequence';
import { nextQueueSeq } from '../sync/queue-seq';
import { readOpenTill, tillIsStale } from './till';

export const SALE_RETURN_OUTBOX_KIND = 'sale_return';

export class SaleReturnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaleReturnError';
  }
}

export interface RecordedReturn {
  readonly returnId: string;
  readonly returnNo: string;
  readonly kind: 'VOID' | 'RETURN';
  readonly totalMinor: bigint;
  /** Cash handed back out of the drawer. */
  readonly cashOutMinor: bigint;
  readonly onAccountMinor: bigint;
}

interface Common {
  readonly saleKey: string;
  readonly reason: string;
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
  readonly newId?: () => string;
}

export interface VoidInput extends Common {}

export interface ReturnInput extends Common {
  readonly picks: readonly ReturnPick[];
  /** An IMMEDIATE method: what any non-account part goes back through. */
  readonly method: TenderMethod;
  readonly reference?: string;
}

function prove(payload: CreateSaleReturnInput): string {
  const json = JSON.stringify(payload);
  const parsed = createSaleReturnInput.safeParse(JSON.parse(json));
  if (!parsed.success) {
    throw new SaleReturnError(
      `return payload does not match the wire contract: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return json;
}

async function context(tx: DbExecutor, nowIso: string) {
  const location = await readDeviceLocation(tx);
  if (location === null || location.code.length === 0) {
    throw new SaleReturnError('This device has no location yet, so it cannot take anything back.');
  }
  const till = await readOpenTill(tx);
  if (till === null) throw new SaleReturnError('No till is open. Open the till before giving money back.');
  if (await tillIsStale(tx, till, nowIso)) {
    throw new SaleReturnError(`The till for ${till.businessDate} closed at midnight. Open today's till first.`);
  }
  return { location, till };
}

async function enqueue(
  tx: DbExecutor,
  args: { id: string; claimedHlc: string; payloadJson: string; total: bigint; returnNo: string; tillId: string; drawer: bigint; nowIso: string },
): Promise<void> {
  const queueSeq = await nextQueueSeq(tx);
  await tx.execute(
    `INSERT INTO outbox
       (id, idempotency_key, claimed_hlc, kind, payload, total_minor, receipt_no,
        tendered_minor, change_minor, cash_session_id, drawer_minor, created_at, queue_seq,
        server_ack_at, rejected_at, reject_reason)
     VALUES (?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, NULL, NULL, ?, CAST(? AS INTEGER), ?, ?, NULL, NULL, NULL)`,
    [
      args.id, args.id, args.claimedHlc, SALE_RETURN_OUTBOX_KIND, args.payloadJson, args.total.toString(),
      args.returnNo, args.tillId, args.drawer.toString(), args.nowIso, queueSeq,
    ],
  );
}

function reasonOf(reason: string): string {
  const r = reason.trim();
  if (r.length === 0) throw new SaleReturnError('Say why — a void or a return needs a reason.');
  return r.slice(0, 200);
}

export async function recordVoid(db: LocalDb, input: VoidInput): Promise<RecordedReturn> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const claimedHlc = input.hlc.next();
  const id = (input.newId ?? uuidv7)();
  const reason = reasonOf(input.reason);
  const result = await db.writeTransaction(async (tx) => {
    const { location, till } = await context(tx, nowIso);
    const sale = await loadReturnableSale(tx, input.saleKey);
    if (sale === null) throw new SaleReturnError('This device does not hold that sale.');
    if (sale.cashSessionId !== till.id) {
      throw new SaleReturnError('That sale was rung in an earlier till. Take the goods back with "Return items" instead.');
    }
    if (sale.alreadyVoided) throw new SaleReturnError('That sale has already been voided.');
    if (sale.anyReturned) {
      throw new SaleReturnError('Part of that sale has already come back. Return the rest with "Return items".');
    }
    const number = await allocateReceiptNumber(tx, {
      locationId: location.id, locationCode: location.code, deviceNode: deviceNodeFromClaimedHlc(claimedHlc),
      format: await readReceiptFormat(tx), nowIso, newId: input.newId ?? uuidv7,
    });
    const payload: CreateSaleReturnInput = {
      idempotencyKey: id,
      claimedHlc,
      clientWallAt: nowIso,
      kind: 'VOID',
      originalSaleId: sale.key,
      locationId: location.id,
      cashSessionId: till.id,
      returnNo: number.receiptNo,
      reason,
      occurredAt: nowIso,
      clientTotalMinor: serializeMoney(sale.totalMinor),
    };
    const payloadJson = prove(payload);
    await enqueue(tx, {
      id, claimedHlc, payloadJson, total: sale.totalMinor, returnNo: number.receiptNo, tillId: till.id,
      drawer: -sale.drawerCashMinor, nowIso,
    });
    const onAccount = sale.tenders.filter((t) => t.isOnAccount).reduce((a, t) => a + t.amountMinor, 0n);
    return {
      returnId: id, returnNo: number.receiptNo, kind: 'VOID' as const, totalMinor: sale.totalMinor,
      cashOutMinor: sale.drawerCashMinor, onAccountMinor: onAccount,
    };
  });
  db.changes.notify();
  return result;
}

export async function recordReturn(db: LocalDb, input: ReturnInput): Promise<RecordedReturn & { priced: PricedReturn }> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const claimedHlc = input.hlc.next();
  const id = (input.newId ?? uuidv7)();
  const reason = reasonOf(input.reason);
  if (input.method.isOnAccount) {
    throw new SaleReturnError('Choose how money is handed back. An account credit is decided by the sale itself.');
  }
  const reference = input.reference?.trim() ?? '';
  const result = await db.writeTransaction(async (tx) => {
    const { location, till } = await context(tx, nowIso);
    const sale = await loadReturnableSale(tx, input.saleKey);
    if (sale === null) throw new SaleReturnError('This device does not hold that sale.');
    if (sale.alreadyVoided) throw new SaleReturnError('That sale has been voided; nothing is left to return.');
    const priced = priceReturn(sale, input.picks);
    if (input.method.requiresReference && priced.immediateMinor > 0n && reference.length === 0) {
      throw new SaleReturnError(`${input.method.name} needs a reference — a transaction id or cheque number.`);
    }
    const number = await allocateReceiptNumber(tx, {
      locationId: location.id, locationCode: location.code, deviceNode: deviceNodeFromClaimedHlc(claimedHlc),
      format: await readReceiptFormat(tx), nowIso, newId: input.newId ?? uuidv7,
    });
    const payload: CreateSaleReturnInput = {
      idempotencyKey: id,
      claimedHlc,
      clientWallAt: nowIso,
      kind: 'RETURN',
      originalSaleId: sale.key,
      locationId: location.id,
      cashSessionId: till.id,
      returnNo: number.receiptNo,
      reason,
      occurredAt: nowIso,
      lines: priced.lines.map((l) => ({ originalLineNo: l.line.lineNo, qty: l.qty.toString(), disposition: l.disposition })),
      refund: {
        methodId: input.method.id,
        ...(reference.length === 0 ? {} : { reference }),
        onAccountClaimMinor: serializeMoney(priced.onAccountMinor),
        immediateClaimMinor: serializeMoney(priced.immediateMinor),
      },
      clientTotalMinor: serializeMoney(priced.totalMinor),
    };
    const payloadJson = prove(payload);
    const cashOut = input.method.isCash ? priced.immediateMinor : 0n;
    await enqueue(tx, {
      id, claimedHlc, payloadJson, total: priced.totalMinor, returnNo: number.receiptNo, tillId: till.id,
      drawer: -cashOut, nowIso,
    });
    return {
      returnId: id, returnNo: number.receiptNo, kind: 'RETURN' as const, totalMinor: priced.totalMinor,
      cashOutMinor: cashOut, onAccountMinor: priced.onAccountMinor, priced,
    };
  });
  db.changes.notify();
  return result;
}
