/**
 * The credit read/write client — CLAUDE.md §2.7 category 1: every figure on
 * this path is money.
 *
 * Three properties are load-bearing and each has tests here.
 *
 * 1. **Every money figure is a `bigint` off a decimal string, or the answer is
 *    `malformed`.** A JSON number is a float64 in every consumer, so a server
 *    that started sending one must make this client go loud rather than let it
 *    become a balance somebody reads at a counter.
 * 2. **The breakdown reconciles to the headline, exactly, in integers.**
 *    `exposure = Σ buckets − on-account credit + fee outstanding`. When it
 *    does not, that is a fact to state, not a rounding detail to hide.
 * 3. **`412 FEE_POLICY_UNCONFIRMED` is a HUMAN GATE, not a failure.** It is
 *    classified apart from every other refusal so no screen can render it with
 *    a "Try again" button — trying again is not what is missing (CLAUDE.md
 *    §2.8, open-questions Q4).
 */
import { describe, expect, it } from 'vitest';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import {
  accrueFacilityFee,
  checkAgreement,
  fetchAgeing,
  fetchCreditPosition,
  fetchExposure,
  type CreditAgeing,
  type CreditExposure,
} from '../src/data/api/credit';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const ACCOUNT = '018f3a1e-0000-7000-8000-0000000000a1';
const AS_OF = '2026-08-22';

type Answer =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string }
  | 'reject';

function router(answers: Readonly<Record<string, Answer>>, asked: string[] = []): ApiFetch {
  return (url) => {
    const path = new URL(url).pathname.replace('/trpc/', '');
    asked.push(path);
    const answer = answers[path];
    if (answer === undefined || answer === 'reject') return Promise.reject(new Error('no radio'));
    if (!answer.ok) {
      return Promise.resolve({
        ok: false,
        status: answer.status,
        json: () =>
          Promise.resolve({
            error: { json: { message: answer.message, data: { code: 'PRECONDITION_FAILED' } } },
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { data: { json: answer.json } } }),
    });
  };
}

function exposurePayload(over: Record<string, unknown> = {}): unknown {
  return {
    accountId: ACCOUNT,
    exposureMinor: '494400',
    creditLimitMinor: '5000000',
    availableMinor: '4505600',
    status: 'ACTIVE',
    termsDays: 30,
    limitVersionId: '018f3a1e-0000-7000-8000-0000000000a9',
    ...over,
  };
}

function ageingPayload(over: Record<string, unknown> = {}): unknown {
  return {
    accountId: ACCOUNT,
    asOf: AS_OF,
    agedBy: 'days_past_due',
    buckets: [
      { label: 'current', amountMinor: '300000' },
      { label: '1-30', amountMinor: '194400' },
      { label: '61+', amountMinor: '0' },
    ],
    onAccountCreditMinor: '0',
    feeOutstandingMinor: '0',
    invoices: [
      {
        chargeId: '018f3a1e-0000-7000-8000-0000000000b1',
        dueDate: '2026-07-20',
        daysPastDue: 33,
        outstandingMinor: '194400',
        bucket: '1-30',
      },
    ],
    ...over,
  };
}

function feePayload(over: Record<string, unknown> = {}): unknown {
  return {
    accountId: ACCOUNT,
    asOf: AS_OF,
    provisional: true,
    label: 'provisional — not chargeable',
    accruals: [
      {
        chargeId: '018f3a1e-0000-7000-8000-0000000000b1',
        dueDate: '2026-07-20',
        basisMinor: '194400',
        elapsedDays30: 1,
        cumulativeMinor: '3888',
        alreadyPostedMinor: '0',
        deltaMinor: '3888',
      },
    ],
    totalDeltaMinor: '3888',
    ...over,
  };
}

const ALL: Readonly<Record<string, Answer>> = {
  'credit.exposure': { ok: true, json: exposurePayload() },
  'credit.ageing': { ok: true, json: ageingPayload() },
  'credit.previewFacilityFee': { ok: true, json: feePayload() },
};

// ---------------------------------------------------------------------------

describe('money crosses as a decimal string and becomes bigint, or nothing does', () => {
  it('maps every figure to bigint', async () => {
    const result = await fetchExposure(ACCOUNT, { endpoint: ENDPOINT, fetchFn: router(ALL) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.exposureMinor).toBe(494400n);
    expect(result.data.creditLimitMinor).toBe(5_000_000n);
    expect(result.data.availableMinor).toBe(4_505_600n);
    expect(typeof result.data.exposureMinor).toBe('bigint');
  });

  it('is malformed — loudly — when a balance arrives as a JSON number', async () => {
    const result = await fetchExposure(ACCOUNT, {
      endpoint: ENDPOINT,
      fetchFn: router({
        'credit.exposure': { ok: true, json: exposurePayload({ exposureMinor: 4944 }) },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed');
    expect(result.failure.detail).toContain('exposureMinor');
  });

  it('is malformed when a figure is a fractional string a float would have taken', async () => {
    const result = await fetchExposure(ACCOUNT, {
      endpoint: ENDPOINT,
      fetchFn: router({
        'credit.exposure': { ok: true, json: exposurePayload({ availableMinor: '4505.6' }) },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed');
  });

  it('says offline — not empty, not zero — when the server cannot be reached', async () => {
    const result = await fetchAgeing(ACCOUNT, AS_OF, {
      endpoint: ENDPOINT,
      fetchFn: () => Promise.reject(new Error('down')),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('offline');
  });
});

describe('the breakdown reconciles to the headline, in integers', () => {
  function exposureOf(minor: bigint): CreditExposure {
    return {
      accountId: ACCOUNT,
      exposureMinor: minor,
      creditLimitMinor: 5_000_000n,
      availableMinor: 5_000_000n - minor,
      status: 'ACTIVE',
      termsDays: 30,
      limitVersionId: null,
    };
  }
  function ageingOf(
    buckets: readonly bigint[],
    onAccount: bigint,
    fee: bigint,
  ): CreditAgeing {
    return {
      accountId: ACCOUNT,
      asOf: AS_OF,
      agedBy: 'days_past_due',
      buckets: buckets.map((amountMinor, i) => ({ label: String(i), amountMinor })),
      onAccountCreditMinor: onAccount,
      feeOutstandingMinor: fee,
      invoices: [],
    };
  }

  it('agrees on the drill’s own shape: Σ buckets = balance', () => {
    expect(checkAgreement(exposureOf(494_400n), ageingOf([300_000n, 194_400n], 0n, 0n)).kind).toBe(
      'agrees',
    );
  });

  it('agrees when an unapplied payment is sitting outside every bucket', () => {
    // Σ buckets 494,400 − on-account 100,000 = 394,400 owed.
    expect(
      checkAgreement(exposureOf(394_400n), ageingOf([300_000n, 194_400n], 100_000n, 0n)).kind,
    ).toBe('agrees');
  });

  it('agrees when fee already posted is part of the balance but not of trade ageing', () => {
    expect(
      checkAgreement(exposureOf(498_288n), ageingOf([300_000n, 194_400n], 0n, 3_888n)).kind,
    ).toBe('agrees');
  });

  it('reports the exact difference rather than rendering a total that does not add up', () => {
    const agreement = checkAgreement(exposureOf(500_000n), ageingOf([300_000n, 194_400n], 0n, 0n));
    expect(agreement.kind).toBe('disagrees');
    if (agreement.kind !== 'disagrees') return;
    expect(agreement.compositionMinor).toBe(494_400n);
    expect(agreement.differenceMinor).toBe(5_600n);
  });
});

describe('one position, three requests', () => {
  it('assembles balance, ageing and the fee working', async () => {
    const result = await fetchCreditPosition(ACCOUNT, AS_OF, {
      endpoint: ENDPOINT,
      fetchFn: router(ALL),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.exposure.exposureMinor).toBe(494_400n);
    expect(result.data.ageing.buckets.length).toBe(3);
    expect(result.data.fee?.totalDeltaMinor).toBe(3_888n);
    expect(result.data.agreement.kind).toBe('agrees');
  });

  it('still gives the balance when the fee working is refused, and names the reason', async () => {
    const result = await fetchCreditPosition(ACCOUNT, AS_OF, {
      endpoint: ENDPOINT,
      fetchFn: router({
        'credit.exposure': { ok: true, json: exposurePayload() },
        'credit.ageing': { ok: true, json: ageingPayload() },
        'credit.previewFacilityFee': { ok: false, status: 403, message: 'PERMISSION_DENIED' },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fee).toBeNull();
    expect(result.data.feeFailure?.kind).toBe('forbidden');
    // What the customer owes is the answer the counter needs; the fee is a
    // provisional number nobody may charge.
    expect(result.data.exposure.exposureMinor).toBe(494_400n);
  });

  it('fails whole rather than partly when the balance itself cannot be read', async () => {
    const result = await fetchCreditPosition(ACCOUNT, AS_OF, {
      endpoint: ENDPOINT,
      fetchFn: router({
        'credit.ageing': { ok: true, json: ageingPayload() },
        'credit.previewFacilityFee': { ok: true, json: feePayload() },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('offline');
  });

  it('refuses a malformed account reference on the device, sending nothing', async () => {
    const asked: string[] = [];
    const result = await fetchCreditPosition('not-a-reference', AS_OF, {
      endpoint: ENDPOINT,
      fetchFn: router(ALL, asked),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('invalid-request');
    expect(asked).not.toContain('credit.exposure');
  });

  it('refuses a date that is not a calendar date, sending nothing', async () => {
    const asked: string[] = [];
    const result = await fetchAgeing(ACCOUNT, '2026-02-30', {
      endpoint: ENDPOINT,
      fetchFn: router(ALL, asked),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('invalid-request');
    expect(asked).toEqual([]);
  });
});

describe('the fee gate is not an error', () => {
  const input = {
    idempotencyKey: '018f3a1e-0000-7000-8000-0000000000f1',
    clientWallAt: '2026-08-22T09:00:00.000Z',
    accountId: ACCOUNT,
    asOf: AS_OF,
  };
  const GATE =
    'FEE_POLICY_UNCONFIRMED: the credit policy (Q4 decisions D-1..D-5) has not been confirmed ' +
    'by an Accounts-role human — accrual refuses to post (06 §6.4.5).';

  it('classifies a 412 apart from every other refusal', async () => {
    const outcome = await accrueFacilityFee(input, {
      endpoint: ENDPOINT,
      fetchFn: router({ 'credit.accrueFacilityFee': { ok: false, status: 412, message: GATE } }),
    });
    expect(outcome.kind).toBe('policy-unconfirmed');
    if (outcome.kind !== 'policy-unconfirmed') return;
    expect(outcome.detail).toContain('FEE_POLICY_UNCONFIRMED');
  });

  it('recognises the server’s own code even if the status ever moved', async () => {
    const outcome = await accrueFacilityFee(input, {
      endpoint: ENDPOINT,
      fetchFn: router({ 'credit.accrueFacilityFee': { ok: false, status: 400, message: GATE } }),
    });
    expect(outcome.kind).toBe('policy-unconfirmed');
  });

  it('keeps an ordinary refusal ordinary — a missing capability is not the gate', async () => {
    const outcome = await accrueFacilityFee(input, {
      endpoint: ENDPOINT,
      fetchFn: router({
        'credit.accrueFacilityFee': {
          ok: false,
          status: 403,
          message: 'PERMISSION_DENIED: credit.fee.accrue is not held by this user',
        },
      }),
    });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.failure.kind).toBe('forbidden');
  });

  it('reports what was posted once the policy has been confirmed', async () => {
    const outcome = await accrueFacilityFee(input, {
      endpoint: ENDPOINT,
      fetchFn: router({
        'credit.accrueFacilityFee': {
          ok: true,
          json: {
            accountId: ACCOUNT,
            asOf: AS_OF,
            postings: [{ entryId: 'e1' }, { entryId: 'e2' }],
            totalPostedMinor: '3888',
          },
        },
      }),
    });
    expect(outcome.kind).toBe('posted');
    if (outcome.kind !== 'posted') return;
    expect(outcome.result.postedCount).toBe(2);
    expect(outcome.result.totalPostedMinor).toBe(3_888n);
  });

  it('refuses a malformed write on the device, sending nothing', async () => {
    const asked: string[] = [];
    const outcome = await accrueFacilityFee(
      { ...input, idempotencyKey: 'not-a-key' },
      { endpoint: ENDPOINT, fetchFn: router({}, asked) },
    );
    expect(outcome.kind).toBe('refused');
    expect(asked).toEqual([]);
  });
});

describe('nothing is cached', () => {
  it('sends no tenant identity in any spelling', async () => {
    const seen: string[] = [];
    const fetchFn: ApiFetch = (url) => {
      seen.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { data: { json: exposurePayload() } } }),
      });
    };
    const options: ApiCallOptions = { endpoint: ENDPOINT, fetchFn };
    await fetchExposure(ACCOUNT, options);
    expect(seen[0]).not.toContain('tenant');
  });

  it('asks the server again on the next read rather than answering from memory', async () => {
    const asked: string[] = [];
    const options: ApiCallOptions = { endpoint: ENDPOINT, fetchFn: router(ALL, asked) };
    await fetchExposure(ACCOUNT, options);
    await fetchExposure(ACCOUNT, options);
    // Two reads, two requests. There is no place in this module for a balance
    // to be remembered, and that is the point.
    expect(asked.filter((p) => p === 'credit.exposure').length).toBe(2);
  });
});
