/**
 * The repayment builder's own refusals — the ones that keep a permanent
 * server "no" out of an ORDERED upload queue.
 *
 * `classifyRejection` (data/sync/upload.ts) classes an unrecognised rejection
 * RETRYABLE, on purpose: wrongly dead-lettering a write is the loss path. The
 * consequence for this op is sharp — `NOT_FOUND: credit account not found` and
 * a `ce_sign` CHECK violation both arrive with prefixes that are NOT on the
 * definitive list, so either would sit at the head of the queue being retried
 * for ever and every sale behind it would stop draining.
 *
 * So the builder narrows them away on the device, and these are the tests that
 * say so. The wire behaviour itself — real partition, real drain, real
 * Postgres — is `packages/wire-conformance/test/credit-client-to-api.test.ts`;
 * this file is about what never leaves the tablet.
 */
import { describe, expect, it } from 'vitest';
import {
  DuplicateRepaymentError,
  RepaymentAmountError,
  RepaymentContextIncompleteError,
  REPAYMENT_OUTBOX_KIND,
  buildRepaymentPayload,
  recordRepayment,
  repaymentAmountMinor,
} from '../src/data/mutations/recordRepayment';
import { fixedHlc, provisionDevice } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ACCOUNT = '018f3a1e-0000-7000-8000-0000000000a1';
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const ENTRY = '018f3a1e-0000-7000-8000-0000000000e1';

describe('the sign convention lives here, not in a form', () => {
  it('turns what the customer handed over into a NEGATIVE entry', () => {
    expect(repaymentAmountMinor(400_000n)).toBe(-400_000n);
  });

  it('refuses zero — the database CHECK would refuse it as an INTERNAL error', () => {
    expect(() => repaymentAmountMinor(0n)).toThrow(RepaymentAmountError);
  });

  it('refuses a negative figure rather than flipping it back', () => {
    // Somebody typing "-1000" means something, and quietly turning it into a
    // payment of 1000 guesses which. `ce_sign` would refuse the un-flipped
    // version as an INTERNAL_SERVER_ERROR, which retries for ever.
    expect(() => repaymentAmountMinor(-1_000n)).toThrow(RepaymentAmountError);
  });
});

describe('the payload is proved against the shared contract before it is queued', () => {
  it('builds bytes the contract accepts, with money as a decimal string', () => {
    const built = buildRepaymentPayload({
      entryId: ENTRY,
      accountId: ACCOUNT,
      amountReceivedMinor: 400_000n,
      businessDate: '2026-08-22',
      createdAt: '2026-08-22T09:00:00.000Z',
    });
    expect(built.payload.kind).toBe('PAYMENT');
    expect(built.payload.amountMinor).toBe('-400000');
    // The BYTES are what the server receives, so they are what is checked.
    const parsed = JSON.parse(built.payloadJson) as Record<string, unknown>;
    expect(parsed['amountMinor']).toBe('-400000');
    expect(parsed['accountId']).toBe(ACCOUNT);
    expect(parsed['appliesToId']).toBeUndefined();
  });

  it('carries an invoice allocation when one was chosen', () => {
    const built = buildRepaymentPayload({
      entryId: ENTRY,
      accountId: ACCOUNT,
      amountReceivedMinor: 100n,
      businessDate: '2026-08-22',
      appliesToId: '018f3a1e-0000-7000-8000-0000000000b1',
      createdAt: '2026-08-22T09:00:00.000Z',
    });
    expect(built.payload.appliesToId).toBe('018f3a1e-0000-7000-8000-0000000000b1');
  });
});

describe('recording it', () => {
  it('queues exactly one outbox row and never awaits a socket', async () => {
    const db = openTestDb();
    await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
    const result = await recordRepayment(db, {
      entryId: ENTRY,
      accountId: ACCOUNT,
      amountReceivedMinor: 400_000n,
      hlc: fixedHlc(),
      nowIso: '2026-08-22T09:00:00.000Z',
    });
    expect(result.amountMinor).toBe(-400_000n);
    const rows = await db.getAll('SELECT kind, payload FROM outbox');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['kind']).toBe(REPAYMENT_OUTBOX_KIND);
  });

  it('refuses a second write under the same key — never a second payment', async () => {
    const db = openTestDb();
    await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
    const once = {
      entryId: ENTRY,
      accountId: ACCOUNT,
      amountReceivedMinor: 400_000n,
      hlc: fixedHlc(),
      nowIso: '2026-08-22T09:00:00.000Z',
    };
    await recordRepayment(db, once);
    await expect(recordRepayment(db, once)).rejects.toThrow(DuplicateRepaymentError);
    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(1);
  });

  it('refuses when the device cannot say which trading day this belongs to', async () => {
    // Ageing is computed against a business date. A device with no location
    // has no timezone, and dating a payment to a day the outlet never traded
    // moves it across a month end.
    const db = openTestDb();
    await expect(
      recordRepayment(db, {
        entryId: ENTRY,
        accountId: ACCOUNT,
        amountReceivedMinor: 400_000n,
        hlc: fixedHlc(),
      }),
    ).rejects.toThrow(RepaymentContextIncompleteError);
    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(0);
  });
});
