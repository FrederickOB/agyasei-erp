/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CUSTOMER PAYS DOWN THEIR BALANCE — the third thing this device may write,
 * and the first one that is money coming IN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Until this module existed the platform could put a customer INTO debt from a
 * screen (a credit sale writes a CHARGE server-side) and could not take a
 * cedi back out of it from any screen at all. `credit.recordEntry` was guarded,
 * tested, in the shared contract, in `DEVICE_OP_KINDS` — and clientless. The
 * consequence is not a missing feature, it is a WRONG NUMBER: every ageing
 * bucket and every exposure figure drifts from reality the moment somebody
 * pays and the system has no way to hear about it.
 *
 * ---------------------------------------------------------------------------
 * THIS ONE IS QUEUED. OPENING AN ACCOUNT IS NOT. THE DIFFERENCE IS THE POINT.
 * ---------------------------------------------------------------------------
 * `data/api/credit.ts` refuses `openAccount` offline and says why at length.
 * A repayment goes the other way, for four reasons that do not apply there:
 *
 *  1. **It is trade, not configuration.** The money is in the drawer whether or
 *     not the tower is up. A screen that refused to record it until the radio
 *     came back teaches a clerk to write the receipt on paper, and paper never
 *     reaches the ledger — the same argument `adjustStock.ts` makes for a bag
 *     of cement that broke in the yard.
 *  2. **It cannot conflict.** `credit_entry` is append-only signed integers and
 *     exposure is Σ (06 §6.2). Two offline batches arriving in either order
 *     produce the same sum. There is no conflict case for a review queue to
 *     hold, and no ancestor anybody has to reconstruct.
 *  3. **It only ever reduces exposure.** A late-arriving payment makes a
 *     customer look like they owe MORE than they do. That is recoverable, and
 *     it is the opposite direction of risk from a late-arriving limit raise.
 *  4. **The device already uploads the other half offline.** A queued credit
 *     sale writes a CHARGE server-side on upload. Taking charges offline and
 *     refusing payments offline would bias the ledger in exactly the wrong
 *     direction, systematically, all day.
 *
 * ---------------------------------------------------------------------------
 * THE HONESTY CONSTRAINT, WHICH IS NOT NEGOTIABLE
 * ---------------------------------------------------------------------------
 * This module returns what was QUEUED. It never returns, computes or implies a
 * resulting balance, and no caller may subtract this amount from a figure on
 * screen. `app.credit_entry` is in no sync bucket, so the device does not hold
 * the ledger this payment belongs to; a "new balance" derived on the device
 * would be a client-side subtraction against an unknown base — the exact thing
 * CLAUDE.md's brief for this work forbids. Balance stays behind a server
 * answer, always, and the screen says "recorded here, not yet sent".
 *
 * ---------------------------------------------------------------------------
 * PAYMENT ONLY. ADJUSTMENT AND WRITE_OFF ARE NOT OFFERED HERE.
 * ---------------------------------------------------------------------------
 * The contract carries four kinds. Two of them — `ADJUSTMENT` and `WRITE_OFF` —
 * are accounting JUDGEMENTS, not trade: writing off a bad debt is a decision
 * somebody signs for, and an ordered upload queue on a tablet is not where it
 * gets authorised. `CHARGE` is absent for a different reason: charges are
 * written server-side by the sale that caused them, and a second way to mint
 * one would be a second source of truth for what a customer owes.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSALS THAT WOULD WEDGE THE ORDERED QUEUE
 * ---------------------------------------------------------------------------
 * `classifyRejection` (data/sync/upload.ts) classes an unrecognised rejection
 * RETRYABLE. Three permanent refusals from `credit.recordEntry` arrive with
 * prefixes that are NOT on the definitive list, so each would sit at the head
 * of the queue being retried for ever and every sale behind it would stop
 * draining:
 *
 *   `NOT_FOUND: credit account not found`
 *   `FORBIDDEN: PERMISSION_DENIED: credit.entry.record is not held by this user`
 *   `INTERNAL_SERVER_ERROR: … violates check constraint "ce_sign"`
 *
 * None of the three can be produced by this builder. The account id comes from
 * a position the SERVER answered a moment ago (`credit.accountForCustomer`),
 * never from anything typed; the capability is checked with
 * `holdsCapabilityForQueuedWrite`, which answers NO when it could not ask —
 * the one place in this client where an unanswerable permission question is
 * treated as a refusal, and `data/api/session.ts` says why; and the sign rule
 * is checked here against the same predicate the database's `ce_sign` CHECK
 * states. `BAD_REQUEST` is definitive, so a payload the router rejects
 * dead-letters into the visible attention state instead.
 *
 * Money is `bigint` minor units end to end and crosses as a decimal STRING
 * (ADR-0004). A JSON number is a float64 in every consumer.
 */
import { recordEntryInput, type RecordEntryInput } from '@erp/contracts';
import { businessDateFor } from '../../lib/business-date';
import type { ClaimedHlcClock } from '../../lib/hlc';
import type { DbExecutor, LocalDb } from '../db';
import { readDeviceLocation } from '../queries/session';
import { nextQueueSeq } from '../sync/queue-seq';

/** The outbox `kind` for this op. `data/sync/transport.ts` maps it to the wire. */
export const REPAYMENT_OUTBOX_KIND = 'credit_payment';

/**
 * The one entry kind this builder will write.
 *
 * Typed against the contract's union, so narrowing it to a kind the shared
 * declaration does not carry is a compile error rather than a `BAD_REQUEST`
 * somebody discovers at a counter.
 */
export const REPAYMENT_KIND = 'PAYMENT' satisfies RecordEntryInput['kind'];

// ---------------------------------------------------------------------------
// The named refusals
// ---------------------------------------------------------------------------

/** The device cannot name where it stands, so it cannot date the trading day. */
export class RepaymentContextIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepaymentContextIncompleteError';
  }
}

/**
 * Zero is not a payment, and a NEGATIVE amount typed by a person is a payment
 * they meant to record backwards.
 *
 * The screen takes what the customer HANDED OVER — a positive number — and
 * this module applies the sign. That keeps the one place where the debit
 * convention lives (a PAYMENT reduces what is owed, so it is negative) out of
 * the hands of whoever is typing, and out of every screen.
 */
export class RepaymentAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepaymentAmountError';
  }
}

/** Already queued under this key. Never a second row; never a silent success. */
export class DuplicateRepaymentError extends Error {
  constructor(readonly entryId: string) {
    super(`repayment ${entryId} is already recorded on this device`);
    this.name = 'DuplicateRepaymentError';
  }
}

/**
 * The payload does not satisfy the shared contract. Thrown BEFORE the outbox
 * insert, so a malformed entry is caught with the customer still at the desk.
 */
export class RepaymentPayloadInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`repayment payload does not match the wire contract: ${issues.join('; ')}`);
    this.name = 'RepaymentPayloadInvalidError';
  }
}

// ---------------------------------------------------------------------------
// Building the payload
// ---------------------------------------------------------------------------

export interface RepaymentPayloadInput {
  /** The idempotency key, minted when the form opened (§8.2). */
  readonly entryId: string;
  readonly accountId: string;
  /**
   * What the customer handed over: POSITIVE minor units. The sign convention
   * is applied here and nowhere else.
   */
  readonly amountReceivedMinor: bigint;
  readonly businessDate: string;
  /** The invoice this settles, when the person knows which. Optional (06 §6.3.2). */
  readonly appliesToId?: string | undefined;
  readonly claimedHlc?: string | undefined;
  readonly createdAt: string;
}

export interface BuiltRepaymentPayload {
  /** The exact bytes the outbox stores and the transport ships. */
  readonly payloadJson: string;
  readonly payload: RecordEntryInput;
}

/**
 * THE SIGN RULE, mirrored from the database's own `ce_sign` CHECK
 * (`packages/db/migrations/0004_app_trade.sql`): a PAYMENT is strictly
 * negative. Duplicated on purpose — a violation surfaces from Postgres as an
 * `INTERNAL_SERVER_ERROR`, which is RETRYABLE, so it would wedge the queue
 * rather than dead-letter.
 */
export function repaymentAmountMinor(amountReceivedMinor: bigint): bigint {
  if (amountReceivedMinor <= 0n) {
    throw new RepaymentAmountError(
      amountReceivedMinor === 0n
        ? 'A payment has to be for some amount.'
        : 'Enter what the customer handed over, as a positive amount. This device records which way it goes.',
    );
  }
  return -amountReceivedMinor;
}

export function buildRepaymentPayload(input: RepaymentPayloadInput): BuiltRepaymentPayload {
  const amountMinor = repaymentAmountMinor(input.amountReceivedMinor);

  // TYPED AS THE CONTRACT. Add a key the API does not accept, or drop one it
  // requires, and this stops compiling. Do not widen it.
  const payload: RecordEntryInput = {
    idempotencyKey: input.entryId,
    ...(input.claimedHlc !== undefined ? { claimedHlc: input.claimedHlc } : {}),
    clientWallAt: input.createdAt,
    accountId: input.accountId,
    kind: REPAYMENT_KIND,
    // A decimal STRING of minor units — a JSON number is a float64 in every
    // consumer (ADR-0004).
    amountMinor: amountMinor.toString(),
    businessDate: input.businessDate,
    ...(input.appliesToId === undefined ? {} : { appliesToId: input.appliesToId }),
  };

  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (err) {
    throw new RepaymentPayloadInvalidError([
      `payload is not serialisable: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  // Re-parsed from the BYTES, because the bytes are what the server receives.
  const parsed = recordEntryInput.safeParse(JSON.parse(payloadJson));
  if (!parsed.success) {
    throw new RepaymentPayloadInvalidError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return { payloadJson, payload };
}

// ---------------------------------------------------------------------------
// Recording it
// ---------------------------------------------------------------------------

export interface RecordRepaymentInput {
  /** Minted when the form opened; stable across every retry of THIS payment. */
  readonly entryId: string;
  /** From a server answer, never from anything a person typed. */
  readonly accountId: string;
  /** POSITIVE minor units — what the customer handed over. */
  readonly amountReceivedMinor: bigint;
  readonly appliesToId?: string | undefined;
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
  /** An asserted trading day; derived from the location's timezone otherwise. */
  readonly businessDate?: string;
}

export interface RecordRepaymentResult {
  readonly entryId: string;
  /** The SIGNED amount that went to the wire. Negative, always. */
  readonly amountMinor: bigint;
  readonly businessDate: string;
  readonly appliesToId: string | null;
}

/**
 * Queue one repayment. Local, atomic, and complete in single-digit
 * milliseconds whether or not there is a network.
 *
 * The row is `pending` from the moment it commits and becomes `Saved` only
 * when the server acks it by key. NOTHING HERE RETURNS A BALANCE, and nothing
 * here asks the server anything.
 */
export async function recordRepayment(
  db: LocalDb,
  input: RecordRepaymentInput,
): Promise<RecordRepaymentResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const claimedHlc = input.hlc.next();

  const result = await db.writeTransaction(async (tx: DbExecutor) => {
    const location = await readDeviceLocation(tx);
    if (location === null) {
      throw new RepaymentContextIncompleteError(
        'This device has no location assigned, so it cannot say which trading day this payment belongs to.',
      );
    }

    // Defence in depth against a double-tap; the authoritative guard is the
    // per-tenant primary key of app.write_log at ingest.
    const duplicate = await tx.getAll('SELECT 1 AS hit FROM outbox WHERE idempotency_key = ?', [
      input.entryId,
    ]);
    if (duplicate.length > 0) throw new DuplicateRepaymentError(input.entryId);

    // The trading day is the LOCATION's, never the tablet's calendar: ageing
    // is computed against a business date and a tablet on the wrong zone must
    // not date a payment to a day the outlet never traded.
    const businessDate = input.businessDate ?? businessDateFor(nowIso, location.timeZone);

    const built = buildRepaymentPayload({
      entryId: input.entryId,
      accountId: input.accountId,
      amountReceivedMinor: input.amountReceivedMinor,
      businessDate,
      appliesToId: input.appliesToId,
      claimedHlc,
      createdAt: nowIso,
    });

    // The queue position, taken inside this transaction (data/sync/queue-seq.ts).
    const queueSeq = await nextQueueSeq(tx);

    await tx.execute(
      `INSERT INTO outbox
         (id, idempotency_key, claimed_hlc, kind, payload, created_at, queue_seq,
          server_ack_at, rejected_at, reject_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        input.entryId,
        input.entryId,
        claimedHlc,
        REPAYMENT_OUTBOX_KIND,
        built.payloadJson,
        nowIso,
        queueSeq,
      ],
    );

    return {
      entryId: input.entryId,
      amountMinor: BigInt(built.payload.amountMinor as string),
      businessDate,
      appliesToId: input.appliesToId ?? null,
    };
  });

  db.changes.notify();
  return result;
}
