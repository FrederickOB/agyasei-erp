/**
 * THE TILL — opening, cashing up, and the midnight close (08 §8.2a; 04 §4.8a).
 *
 * The counter's first screen when no till is open is the open-till screen,
 * and there is no path to a sale without one: a sale's business date IS its
 * till's (03 §3.4.2). Everything in this file is local and synchronous with
 * respect to the network — a till opens and closes with the radio off — and
 * both writes ride the ordered outbox as trade (`cash_session.open`,
 * `cash_session.close`), carrying the client's idempotency key and claimed
 * HLC exactly like a sale.
 *
 * ── THE RULES, EACH ONE A REFUSAL HERE RATHER THAN A HOPE ─────────────────
 *  · One OPEN till on this device, and one till per location per business
 *    date. A second open for a day already opened is §3.6 class #17 if it
 *    ever reaches the server; it is refused here so it never does.
 *  · Online, the date is checked against the SERVER's date (±1 day) and the
 *    period's state first — `data/api/cash-session.ts`, run by the screen.
 *    Offline the open is permitted and FLAGGED `openedOffline`.
 *  · Never into a closed or locked accounting period, judged from the synced
 *    `accounting_period` rows when the device holds them.
 *  · One calendar day at most. At local midnight in the LOCATION's timezone
 *    the till closes itself, uncounted, and the counter offers to open a NEW
 *    till for the new day carrying the drawer over — it never extends the old
 *    one (`autoCloseStaleTill`).
 *  · Cash-up shows expected, counted and variance BEFORE it is confirmed, and
 *    refuses while a sale is in progress.
 *
 * Money is bigint minor units throughout (ADR-0004); SQLite integers are read
 * through CAST(… AS TEXT) and written through CAST(? AS INTEGER).
 */
import {
  closeCashSessionInput,
  openCashSessionInput,
  type CloseCashSessionInput,
  type OpenCashSessionInput,
} from '@erp/contracts';
import { businessDateFor } from '../../lib/business-date';
import type { ClaimedHlcClock } from '../../lib/hlc';
import { uuidv7 } from '../../lib/uuidv7';
import type { DbExecutor, DbRow, LocalDb } from '../db';
import { readDeviceLocation } from '../queries/session';
import { nextQueueSeq } from '../sync/queue-seq';

/** Outbox kinds — mapped to the wire discriminators in data/sync/transport.ts. */
export const TILL_OPEN_OUTBOX_KIND = 'cash_session_open';
export const TILL_CLOSE_OUTBOX_KIND = 'cash_session_close';

export interface Till {
  /** The session id: the open's idempotency key, and the server's row id. */
  readonly id: string;
  readonly locationId: string;
  readonly businessDate: string;
  readonly drawer: 'DEVICE' | 'SHARED';
  readonly openingFloatMinor: bigint;
  readonly openedAt: string;
  readonly openedOffline: boolean;
  readonly status: 'OPEN' | 'CLOSED';
  readonly closedAt: string | null;
  readonly autoClosed: boolean;
  readonly countedMinor: bigint | null;
  readonly bankedMinor: bigint | null;
  /** What THIS DEVICE computed as expected at close. Null while open. */
  readonly expectedMinor: bigint | null;
}

export class TillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TillError';
  }
}

/** The payload failed the shared contract — caught here, not at sync. */
export class TillPayloadInvalidError extends TillError {
  constructor(readonly issues: readonly string[]) {
    super(`till payload does not match the wire contract: ${issues.join('; ')}`);
    this.name = 'TillPayloadInvalidError';
  }
}

const TILL_COLUMNS = `id, location_id, business_date, drawer,
  CAST(opening_float_minor AS TEXT) AS opening_float_minor, opened_at, opened_offline,
  status, closed_at, auto_closed,
  CAST(counted_minor AS TEXT) AS counted_minor,
  CAST(banked_minor AS TEXT) AS banked_minor,
  CAST(expected_minor AS TEXT) AS expected_minor`;

function big(v: unknown): bigint | null {
  return v === null || v === undefined ? null : BigInt(String(v));
}

function mapTill(row: DbRow): Till {
  return {
    id: String(row['id']),
    locationId: String(row['location_id']),
    businessDate: String(row['business_date']),
    drawer: row['drawer'] === 'SHARED' ? 'SHARED' : 'DEVICE',
    openingFloatMinor: BigInt(String(row['opening_float_minor'] ?? '0')),
    openedAt: String(row['opened_at']),
    openedOffline: row['opened_offline'] === 1 || row['opened_offline'] === '1',
    status: row['status'] === 'CLOSED' ? 'CLOSED' : 'OPEN',
    closedAt: row['closed_at'] === null || row['closed_at'] === undefined ? null : String(row['closed_at']),
    autoClosed: row['auto_closed'] === 1 || row['auto_closed'] === '1',
    countedMinor: big(row['counted_minor']),
    bankedMinor: big(row['banked_minor']),
    expectedMinor: big(row['expected_minor']),
  };
}

/** The OPEN till at this device's location, or null. */
export async function readOpenTill(db: DbExecutor): Promise<Till | null> {
  const location = await readDeviceLocation(db);
  if (location === null) return null;
  const rows = await db.getAll(
    `SELECT ${TILL_COLUMNS} FROM till_session
      WHERE location_id = ? AND status = 'OPEN'
      ORDER BY business_date DESC LIMIT 1`,
    [location.id],
  );
  const row = rows[0];
  return row === undefined ? null : mapTill(row);
}

/** The most recent till at this location, open or closed — for carry-over. */
export async function readLatestTill(db: DbExecutor): Promise<Till | null> {
  const location = await readDeviceLocation(db);
  if (location === null) return null;
  const rows = await db.getAll(
    `SELECT ${TILL_COLUMNS} FROM till_session
      WHERE location_id = ?
      ORDER BY business_date DESC, opened_at DESC LIMIT 1`,
    [location.id],
  );
  const row = rows[0];
  return row === undefined ? null : mapTill(row);
}

/**
 * What the drawer should hold: the float plus the cash APPLIED to every sale
 * rung into this till on this device, LESS the cash paid back out of it by
 * every void and return (whose `drawer_minor` is negative) — whatever their
 * sync state, because the money is in or out of the drawer whether or not the
 * server has heard of it yet. Summed here in bigint, never in SQL (§8.3).
 */
export async function tillExpectedCash(db: DbExecutor, till: Till): Promise<bigint> {
  const rows = await db.getAll(
    `SELECT CAST(drawer_minor AS TEXT) AS drawer_minor
       FROM outbox WHERE kind IN ('sale', 'sale_return') AND cash_session_id = ?`,
    [till.id],
  );
  let cash = 0n;
  for (const r of rows) cash += BigInt(String(r['drawer_minor'] ?? '0'));
  return till.openingFloatMinor + cash;
}

/** The trading day the counter would propose now, at this location (§8.2a). */
export async function proposedBusinessDate(db: DbExecutor, nowIso: string): Promise<string | null> {
  const location = await readDeviceLocation(db);
  if (location === null) return null;
  return businessDateFor(nowIso, location.timeZone);
}

/**
 * The state of the accounting period covering `businessDate`, from the synced
 * calendar — or null when this device holds no period that covers it (the
 * calendar has not synced, or the tenant has no ledger yet). Null does not
 * refuse: the server flags a closed-period open it lands (§8.2a).
 */
export async function localPeriodStatus(
  db: DbExecutor,
  businessDate: string,
): Promise<'open' | 'closed' | 'locked' | null> {
  const rows = await db.getAll(
    `SELECT status FROM accounting_period
      WHERE starts_on <= ? AND ends_on >= ? LIMIT 1`,
    [businessDate, businessDate],
  );
  const status = rows[0]?.['status'];
  return status === 'open' || status === 'closed' || status === 'locked' ? status : null;
}

export interface OpenTillInput {
  readonly openingFloatMinor: bigint;
  /** The date the PERSON confirmed, shown to them large and unabbreviated. */
  readonly businessDate: string;
  /** True when the server's date could not be checked (§8.2a). */
  readonly openedOffline: boolean;
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
  readonly drawer?: 'DEVICE' | 'SHARED';
  /** The session id / idempotency key. Injected for deterministic tests. */
  readonly sessionId?: string;
}

export async function openTill(db: LocalDb, input: OpenTillInput): Promise<Till> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const sessionId = input.sessionId ?? uuidv7();
  const claimedHlc = input.hlc.next();
  if (input.openingFloatMinor < 0n) throw new TillError('The opening float cannot be negative.');

  const till = await db.writeTransaction(async (tx) => {
    const location = await readDeviceLocation(tx);
    if (location === null) {
      throw new TillError('This device has no location assigned. It must be set up before a till can open.');
    }
    const open = await tx.getAll(
      `SELECT business_date FROM till_session WHERE location_id = ? AND status = 'OPEN' LIMIT 1`,
      [location.id],
    );
    if (open.length > 0) {
      throw new TillError(`A till is already open here for ${String(open[0]!['business_date'])}. Cash it up first.`);
    }
    const sameDay = await tx.getAll(
      `SELECT 1 AS hit FROM till_session WHERE location_id = ? AND business_date = ? LIMIT 1`,
      [location.id, input.businessDate],
    );
    if (sameDay.length > 0) {
      // One session per till per business date (04 §4.8a). A second one is
      // class #17 at the server; refusing it here keeps it from ever being one.
      throw new TillError(
        `This till has already been opened for ${input.businessDate}. A till opens once a day.`,
      );
    }
    const period = await localPeriodStatus(tx, input.businessDate);
    if (period === 'closed' || period === 'locked') {
      throw new TillError(
        `The accounting period covering ${input.businessDate} is ${period}. A till cannot open into it.`,
      );
    }

    const payload: OpenCashSessionInput = {
      idempotencyKey: sessionId,
      claimedHlc,
      clientWallAt: nowIso,
      locationId: location.id,
      businessDate: input.businessDate,
      openingFloatMinor: input.openingFloatMinor.toString(10),
      openedAt: nowIso,
      openedOffline: input.openedOffline,
      drawer: input.drawer ?? 'DEVICE',
    };
    const payloadJson = proveAgainst(openCashSessionInput, payload);

    await tx.execute(
      `INSERT INTO till_session
         (id, location_id, business_date, drawer, opening_float_minor, opened_at, opened_offline,
          status, closed_at, auto_closed, counted_minor, banked_minor, expected_minor)
       VALUES (?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, 'OPEN', NULL, 0, NULL, NULL, NULL)`,
      [
        sessionId, location.id, input.businessDate, input.drawer ?? 'DEVICE',
        input.openingFloatMinor.toString(10), nowIso, input.openedOffline ? 1 : 0,
      ],
    );
    await enqueue(tx, sessionId, claimedHlc, TILL_OPEN_OUTBOX_KIND, payloadJson, nowIso);

    const rows = await tx.getAll(`SELECT ${TILL_COLUMNS} FROM till_session WHERE id = ?`, [sessionId]);
    return mapTill(rows[0]!);
  });
  db.changes.notify();
  return till;
}

export interface CloseTillInput {
  readonly tillId: string;
  /** The drawer count. Absent ONLY for the midnight auto-close. */
  readonly countedMinor?: bigint;
  /** Taken out of the drawer for the bank. Never more than was counted. */
  readonly bankedMinor?: bigint;
  readonly autoClosed?: boolean;
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
  /** The close op's idempotency key. Injected for deterministic tests. */
  readonly closeKey?: string;
}

export interface ClosedTill {
  readonly till: Till;
  readonly expectedMinor: bigint;
  /** counted − expected, or null when nobody counted. */
  readonly varianceMinor: bigint | null;
}

/** The cash-up preview: what the screen shows BEFORE anything is confirmed. */
export function tillVariance(expectedMinor: bigint, countedMinor: bigint): bigint {
  return countedMinor - expectedMinor;
}

export async function closeTill(db: LocalDb, input: CloseTillInput): Promise<ClosedTill> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const closeKey = input.closeKey ?? uuidv7();
  const claimedHlc = input.hlc.next();
  const autoClosed = input.autoClosed === true;
  if (!autoClosed && input.countedMinor === undefined) {
    throw new TillError('Count the drawer before closing the till.');
  }
  if (autoClosed && (input.countedMinor !== undefined || input.bankedMinor !== undefined)) {
    throw new TillError('The automatic close counts nothing.');
  }
  if (input.countedMinor !== undefined && input.countedMinor < 0n) {
    throw new TillError('A count cannot be negative.');
  }
  if (input.bankedMinor !== undefined) {
    if (input.bankedMinor < 0n) throw new TillError('Banked cash cannot be negative.');
    if (input.countedMinor !== undefined && input.bankedMinor > input.countedMinor) {
      throw new TillError('You cannot bank more than you counted.');
    }
  }

  const closed = await db.writeTransaction(async (tx) => {
    const rows = await tx.getAll(`SELECT ${TILL_COLUMNS} FROM till_session WHERE id = ?`, [input.tillId]);
    const row = rows[0];
    if (row === undefined) throw new TillError('No such till on this device.');
    const till = mapTill(row);
    if (till.status !== 'OPEN') throw new TillError(`This till is already closed.`);
    if (!autoClosed) {
      // §8.2a: "A session cannot close while a sale is in flight." The sale
      // on the counter is in flight; a DRAFT set aside is not — no money has
      // moved — and it waits on this device for the customer to come back.
      const inCart = await tx.getAll(
        `SELECT 1 AS hit FROM cart_line l JOIN cart c ON c.id = l.cart_id
          WHERE c.status = 'open' LIMIT 1`,
      );
      if (inCart.length > 0) {
        throw new TillError('A sale is in progress. Finish it or clear the cart before cashing up.');
      }
    }

    const expected = await tillExpectedCash(tx, till);
    const counted = input.countedMinor ?? null;
    const variance = counted === null ? null : tillVariance(expected, counted);

    const payload: CloseCashSessionInput = {
      idempotencyKey: closeKey,
      claimedHlc,
      clientWallAt: nowIso,
      locationId: till.locationId,
      cashSessionId: till.id,
      closedAt: nowIso,
      autoClosed,
      ...(counted === null ? {} : { countedMinor: counted.toString(10) }),
      ...(input.bankedMinor === undefined ? {} : { bankedMinor: input.bankedMinor.toString(10) }),
      clientExpectedMinor: expected.toString(10),
    };
    const payloadJson = proveAgainst(closeCashSessionInput, payload);

    await tx.execute(
      `UPDATE till_session
          SET status = 'CLOSED', closed_at = ?, auto_closed = ?,
              counted_minor = CAST(? AS INTEGER), banked_minor = CAST(? AS INTEGER),
              expected_minor = CAST(? AS INTEGER)
        WHERE id = ? AND status = 'OPEN'`,
      [
        nowIso, autoClosed ? 1 : 0,
        counted === null ? null : counted.toString(10),
        input.bankedMinor === undefined ? null : input.bankedMinor.toString(10),
        expected.toString(10),
        till.id,
      ],
    );
    await enqueue(tx, closeKey, claimedHlc, TILL_CLOSE_OUTBOX_KIND, payloadJson, nowIso);

    const after = await tx.getAll(`SELECT ${TILL_COLUMNS} FROM till_session WHERE id = ?`, [till.id]);
    return { till: mapTill(after[0]!), expectedMinor: expected, varianceMinor: variance };
  });
  db.changes.notify();
  return closed;
}

/**
 * THE MIDNIGHT CLOSE (08 §8.2a). If the open till's business date is behind
 * today at the location — the clock has passed local midnight — close it,
 * uncounted, and return it so the counter can offer the carry-over. Returns
 * null when there is nothing to close. A till dated AHEAD of the device clock
 * is left alone: that is a clock problem for a person, not a reason to stop
 * the counter, and the server flags it.
 */
export async function autoCloseStaleTill(
  db: LocalDb,
  input: { readonly hlc: ClaimedHlcClock; readonly nowIso?: string },
): Promise<ClosedTill | null> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const till = await readOpenTill(db);
  if (till === null) return null;
  const today = await proposedBusinessDate(db, nowIso);
  if (today === null || till.businessDate >= today) return null;
  return closeTill(db, { tillId: till.id, autoClosed: true, hlc: input.hlc, nowIso });
}

/** True when the open till belongs to an earlier day than `nowIso` at this location. */
export async function tillIsStale(db: DbExecutor, till: Till, nowIso: string): Promise<boolean> {
  const today = await proposedBusinessDate(db, nowIso);
  return today !== null && till.businessDate < today;
}

// ---------------------------------------------------------------------------

function proveAgainst(
  schema: { safeParse(v: unknown): { success: boolean; error?: unknown } },
  payload: unknown,
): string {
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (err) {
    throw new TillPayloadInvalidError([err instanceof Error ? err.message : String(err)]);
  }
  const parsed = schema.safeParse(JSON.parse(payloadJson));
  if (!parsed.success) {
    const issues = (parsed.error as { issues?: { path: (string | number)[]; message: string }[] })?.issues ?? [];
    throw new TillPayloadInvalidError(
      issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return payloadJson;
}

async function enqueue(
  tx: DbExecutor,
  key: string,
  claimedHlc: string,
  kind: string,
  payloadJson: string,
  nowIso: string,
): Promise<void> {
  const queueSeq = await nextQueueSeq(tx);
  await tx.execute(
    `INSERT INTO outbox
       (id, idempotency_key, claimed_hlc, kind, payload, created_at, queue_seq,
        server_ack_at, rejected_at, reject_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    [key, key, claimedHlc, kind, payloadJson, nowIso, queueSeq],
  );
}
