// @vitest-environment jsdom
/**
 * CREDIT, OFFLINE — the figures a partitioned device may show, and the ones it
 * may not.
 *
 * `app.credit_entry` used to be in no sync bucket, so the screen's only honest
 * answer with the radio off was "not available". Honesty is not visibility, and
 * criterion 3 asks for a balance and an ageing that are VISIBLE AND CORRECT.
 * Migration 0013 and the `tenant_credit` bucket put a bounded, server-derived
 * position on the device; these tests hold that addition to the standard the
 * old refusal met.
 *
 * FOUR THINGS ARE PROVEN HERE, and the fourth is the one that would be quietly
 * lost:
 *
 *  1. **The device's arithmetic is the server's arithmetic.** The identity
 *     `balance = Σ buckets − on-account + fee` is checked on the synced
 *     position by `checkAgreement` — literally the same function the online
 *     path runs against the server's own answer — so the two cannot drift
 *     without saying so.
 *  2. **Staleness renders, in the same sentence as the number.** Never a bare
 *     "Balance", never a tick, never an approval.
 *  3. **The offline path returns real figures**, not `ServerUnavailable`, when
 *     the device genuinely holds a position.
 *  4. **The old honesty rules still hold.** A device with NO snapshot still
 *     shows nothing; a previously fetched figure is still discarded on a failed
 *     refresh; and a synced figure never appears where a verified one goes.
 *     "We now have local data" must not have quietly become "we now show an old
 *     number in the confident place".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { checkAgreement, type CreditAgeing, type CreditExposure } from '../src/data/api/credit';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import {
  loadAccountIdForCustomer,
  loadStatementLines,
  loadSyncedCreditPosition,
} from '../src/data/queries/credit-position';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Credit } from '../src/features/credit/Credit';
import { SyncedPositionPanel } from '../src/features/credit/SyncedPosition';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice, seedCustomer } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const ACCOUNT = '018f3a1e-0000-7000-8000-0000000000a1';
const CUSTOMER = '018f3a1e-0000-7000-8000-0000000000c1';
const SIGN = DEV_PLACEHOLDER_CURRENCY.symbol;

/**
 * ONE set of numbers, used on both sides of every comparison below.
 *
 * They are the `drill:credit` figures: a 494,400 balance made of 300,000 not
 * yet due and 194,400 that is, against a 5,000,000 limit. 205,600 of the
 * account's history has archived out of the device's window, so the local log
 * is SHORT — which is the whole reason the balance is synced rather than
 * summed.
 */
const BALANCE = '700000';
const LIMIT = '5000000';
const AVAILABLE = '4300000';
const CURRENT_BUCKET = '300000';
const OVERDUE_BUCKET = '194400';
const ON_ACCOUNT = '0';
const FEE_OUTSTANDING = '205600';
const OPENING_BEFORE_WINDOW = '150000';
const AS_OF = '2026-08-22';
/** Fixed-width, collation "C": lexicographic order IS causal order. */
const hlc = (ms: number, counter = 0): string =>
  `${String(ms).padStart(13, '0')}-${String(counter).padStart(5, '0')}-${'ab'.repeat(16)}`;
const SNAPSHOT_HLC = hlc(1_755_000_000_000, 40);
const COMPUTED_AT = '2026-08-22T06:40:00.000Z';

interface SnapshotOverrides {
  readonly balanceMinor?: string;
  readonly buckets?: readonly (readonly [string, string])[];
  readonly feeConfirmedAt?: string | null;
  readonly asOfHlc?: string;
}

/**
 * Seed exactly what the `tenant_credit` bucket delivers: the account header,
 * the server-derived snapshot, its bucket vector, and a SHORT window of entry
 * rows. No test here ever computes a figure from the entry rows — that is the
 * behaviour under test, not a fixture convenience.
 */
async function seedSyncedBook(db: LocalDb, over: SnapshotOverrides = {}): Promise<void> {
  const balance = over.balanceMinor ?? BALANCE;
  const buckets = over.buckets ?? ([
    ['current', CURRENT_BUCKET],
    ['1-30', OVERDUE_BUCKET],
  ] as const);
  await db.execute(
    `INSERT INTO customer_account
       (id, tenant_id, customer_id, credit_limit_minor, terms_days,
        facility_fee_bp_per_month, status, hlc, created_at, updated_at)
     VALUES (?, NULL, ?, CAST(? AS INTEGER), 30, 250, 'ACTIVE', ?, NULL, NULL)`,
    [ACCOUNT, CUSTOMER, LIMIT, SNAPSHOT_HLC],
  );
  await db.execute(
    `INSERT INTO credit_position_snapshot
       (id, tenant_id, account_id, customer_id, status, terms_days,
        credit_limit_minor, limit_version_id, balance_minor, trade_exposure_minor,
        available_minor, on_account_credit_minor, fee_outstanding_minor,
        opening_before_window_minor, aged_by, fee_confirmed_at, entry_window_days,
        as_of, as_of_hlc, computed_at)
     VALUES (?, NULL, ?, ?, 'ACTIVE', 30,
             CAST(? AS INTEGER), NULL, CAST(? AS INTEGER), CAST(? AS INTEGER),
             CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER),
             CAST(? AS INTEGER), 'days_past_due', ?, 400, ?, ?, ?)`,
    [
      'snap-1',
      ACCOUNT,
      CUSTOMER,
      LIMIT,
      balance,
      '494400',
      AVAILABLE,
      ON_ACCOUNT,
      FEE_OUTSTANDING,
      OPENING_BEFORE_WINDOW,
      over.feeConfirmedAt ?? null,
      AS_OF,
      over.asOfHlc ?? SNAPSHOT_HLC,
      COMPUTED_AT,
    ],
  );
  let seq = 0;
  for (const [label, amount] of buckets) {
    await db.execute(
      `INSERT INTO credit_position_bucket
         (id, tenant_id, account_id, seq, label, from_dpd, to_dpd, amount_minor, as_of, as_of_hlc)
       VALUES (?, NULL, ?, ?, ?, NULL, NULL, CAST(? AS INTEGER), ?, ?)`,
      [`b-${String(seq)}`, ACCOUNT, seq, label, amount, AS_OF, over.asOfHlc ?? SNAPSHOT_HLC],
    );
    seq += 1;
  }
  // The window this device holds — deliberately SHORT of the balance.
  await db.execute(
    `INSERT INTO credit_entry
       (id, tenant_id, account_id, kind, amount_minor, business_date, due_date,
        source_kind, source_id, applies_to_id, hlc, created_at)
     VALUES (?, NULL, ?, 'CHARGE', CAST(? AS INTEGER), ?, ?, NULL, NULL, NULL, ?, NULL)`,
    ['e-1', ACCOUNT, CURRENT_BUCKET, '2026-08-20', '2026-09-19', hlc(1_755_000_000_000, 10)],
  );
  await db.execute(
    `INSERT INTO credit_entry
       (id, tenant_id, account_id, kind, amount_minor, business_date, due_date,
        source_kind, source_id, applies_to_id, hlc, created_at)
     VALUES (?, NULL, ?, 'CHARGE', CAST(? AS INTEGER), ?, ?, NULL, NULL, NULL, ?, NULL)`,
    ['e-2', ACCOUNT, OVERDUE_BUCKET, '2026-07-20', '2026-07-20', hlc(1_755_000_000_000, 20)],
  );
}

/** A movement stamped AFTER the snapshot: shown, never folded in. */
async function seedMovementSince(db: LocalDb): Promise<void> {
  await db.execute(
    `INSERT INTO credit_entry
       (id, tenant_id, account_id, kind, amount_minor, business_date, due_date,
        source_kind, source_id, applies_to_id, hlc, created_at)
     VALUES (?, NULL, ?, 'PAYMENT', CAST(? AS INTEGER), ?, NULL, NULL, NULL, NULL, ?, NULL)`,
    ['e-9', ACCOUNT, '-100000', '2026-08-22', hlc(1_755_000_000_000, 90)],
  );
}

async function device(): Promise<LocalDb> {
  const db = openTestDb();
  await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  await seedCustomer(db, { id: CUSTOMER, code: 'CU-001', name: 'Kofi Buildings' });
  return db;
}

function holding(codes: readonly string[]): PermissionsState {
  return {
    status: 'live',
    asOfMs: 0,
    snapshot: {
      userId: 'u1',
      grants: codes.map((code) => ({ code, locationId: LOC })),
      codes: [...codes],
      locationIds: [LOC],
    },
  };
}

const DEAD_RADIO: ApiFetch = () => Promise.reject(new Error('no radio'));

function renderScreen(db: LocalDb, apiOptions: ApiCallOptions) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Credit db={db} permissions={holding([CAPABILITY.creditView])} apiOptions={apiOptions} />
    </CurrencyProvider>,
  );
}

async function pickCustomer(): Promise<void> {
  const select = await screen.findByLabelText('Which customer');
  await waitFor(() => expect(screen.getByRole('option', { name: /Kofi Buildings/ })).toBeDefined());
  fireEvent.change(select, { target: { value: CUSTOMER } });
}

afterEach(cleanup);

// ---------------------------------------------------------------------------

describe('the local read', () => {
  it('finds the account without the radio, once the book has synced', async () => {
    const db = await device();
    expect(await loadAccountIdForCustomer(db, CUSTOMER)).toBeNull();
    await seedSyncedBook(db);
    expect(await loadAccountIdForCustomer(db, CUSTOMER)).toBe(ACCOUNT);
  });

  it('answers `unavailable` — no figures at all — when nothing has synced', async () => {
    const db = await device();
    const read = await loadSyncedCreditPosition(db, ACCOUNT);
    expect(read.kind).toBe('unavailable');
    expect(Object.keys(read)).toEqual(['kind']);
  });

  it('reads every money figure as bigint minor units, never a float', async () => {
    const db = await device();
    await seedSyncedBook(db);
    const read = await loadSyncedCreditPosition(db, ACCOUNT);
    if (read.kind !== 'synced_as_of') throw new Error('expected a synced position');
    const p = read.position;
    expect(p.balanceMinor).toBe(700_000n);
    expect(p.creditLimitMinor).toBe(5_000_000n);
    expect(p.availableMinor).toBe(4_300_000n);
    expect(p.feeOutstandingMinor).toBe(205_600n);
    expect(p.openingBeforeWindowMinor).toBe(150_000n);
    for (const bucket of p.buckets) expect(typeof bucket.amountMinor).toBe('bigint');
  });
});

describe('the device arithmetic is the server arithmetic', () => {
  /**
   * The claim under test: for the SAME entries, the identity the device checks
   * locally is the identity the server's own answer is checked against —
   * `checkAgreement`, one implementation, both paths.
   */
  it('reconciles the synced position with the SAME function the online path uses', async () => {
    const db = await device();
    await seedSyncedBook(db);
    const read = await loadSyncedCreditPosition(db, ACCOUNT);
    if (read.kind !== 'synced_as_of') throw new Error('expected a synced position');
    expect(read.position.agreement.kind).toBe('agrees');

    // The same numbers arriving over the wire, checked by the online path.
    const exposure: CreditExposure = {
      accountId: ACCOUNT,
      exposureMinor: 700_000n,
      creditLimitMinor: 5_000_000n,
      availableMinor: 4_300_000n,
      status: 'ACTIVE',
      termsDays: 30,
      limitVersionId: null,
    };
    const ageing: CreditAgeing = {
      accountId: ACCOUNT,
      asOf: AS_OF,
      agedBy: 'days_past_due',
      buckets: [
        { label: 'current', amountMinor: 300_000n },
        { label: '1-30', amountMinor: 194_400n },
      ],
      onAccountCreditMinor: 0n,
      feeOutstandingMinor: 205_600n,
      invoices: [],
    };
    expect(checkAgreement(exposure, ageing)).toEqual(read.position.agreement);
  });

  it('says the parts do not add up rather than showing a headline that lies', async () => {
    const db = await device();
    // One bucket short of the balance: exactly the drift a divergent server
    // projection would produce, and it must surface rather than be absorbed.
    await seedSyncedBook(db, { buckets: [['current', CURRENT_BUCKET]] });
    const read = await loadSyncedCreditPosition(db, ACCOUNT);
    if (read.kind !== 'synced_as_of') throw new Error('expected a synced position');
    const agreement = read.position.agreement;
    if (agreement.kind !== 'disagrees') throw new Error('expected a disagreement');
    expect(agreement.balanceMinor).toBe(700_000n);
    expect(agreement.compositionMinor).toBe(505_600n);
    expect(agreement.differenceMinor).toBe(194_400n);
  });

  it('never adds a movement the snapshot does not include — it lists it', async () => {
    const db = await device();
    await seedSyncedBook(db);
    await seedMovementSince(db);
    const read = await loadSyncedCreditPosition(db, ACCOUNT);
    if (read.kind !== 'synced_as_of') throw new Error('expected a synced position');
    // The balance is UNCHANGED by the later payment…
    expect(read.position.balanceMinor).toBe(700_000n);
    // …and the payment is visible as its own thing, by its server HLC.
    expect(read.position.movementsSince.map((m) => m.id)).toEqual(['e-9']);
    expect(read.position.movementsSince[0]?.amountMinor).toBe(-100_000n);
    const since = read.position.movementsSince[0];
    if (since === undefined) throw new Error('expected one movement since the snapshot');
    expect(since.hlc > read.position.asOfHlc).toBe(true);
  });

  it('treats entries at or before the snapshot HLC as already included', async () => {
    const db = await device();
    await seedSyncedBook(db);
    const read = await loadSyncedCreditPosition(db, ACCOUNT);
    if (read.kind !== 'synced_as_of') throw new Error('expected a synced position');
    // Both seeded entries are stamped BEFORE the snapshot, so neither is
    // "since" — a positive control for the check above, which would otherwise
    // pass on a query that returns nothing whatever the data.
    expect(read.position.movementsSince).toEqual([]);
    expect((await loadStatementLines(db, ACCOUNT)).length).toBe(2);
  });
});

describe('staleness renders', () => {
  function panel(position: Parameters<typeof SyncedPositionPanel>[0]['position']) {
    return render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <SyncedPositionPanel position={position} nowMs={Date.parse(COMPUTED_AT)} />
      </CurrencyProvider>,
    );
  }

  async function synced(db: LocalDb) {
    const read = await loadSyncedCreditPosition(db, ACCOUNT);
    if (read.kind !== 'synced_as_of') throw new Error('expected a synced position');
    return read.position;
  }

  it('states the age in the same sentence as every figure, and never says "Balance" alone', async () => {
    const db = await device();
    await seedSyncedBook(db);
    panel(await synced(db));

    // The figure IS shown — this is the visibility criterion 3 asks for.
    expect(screen.getByText(`${SIGN}7000.00`)).toBeDefined();
    // …and its label carries its own age.
    const labels = screen.getAllByText(/^Balance as at \d\d:\d\d today$/);
    expect(labels.length).toBe(1);
    // The unqualified word is reserved for a verified figure (R3 rule 2).
    expect(screen.queryByText('Balance')).toBeNull();
    expect(screen.queryByText('Limit')).toBeNull();
    expect(screen.queryByText('Left to spend')).toBeNull();
  });

  it('claims no check it did not make — no tick, no "limit check passed", no approval', async () => {
    const db = await device();
    await seedSyncedBook(db);
    const { container } = panel(await synced(db));
    const text = container.textContent ?? '';
    expect(/limit check/i.test(text)).toBe(false);
    expect(/checked just now/i.test(text)).toBe(false);
    expect(/approved/i.test(text)).toBe(false);
    expect(container.querySelector('[data-provenance="synced_as_of"]')).not.toBeNull();
    // It says the opposite, in words.
    expect(screen.getByText(/it is not a check made just now/)).toBeDefined();
  });

  it('says what the window is, so a short statement never reads as "no activity"', async () => {
    const db = await device();
    await seedSyncedBook(db);
    panel(await synced(db));
    expect(screen.getByText(/holds the last 400 days of this account/)).toBeDefined();
    expect(screen.getByText(`${SIGN}1500.00`)).toBeDefined(); // the opening balance
  });

  it('labels the facility fee provisional while nobody has confirmed the policy', async () => {
    const db = await device();
    await seedSyncedBook(db);
    panel(await synced(db));
    expect(screen.getByText(/provisional and not chargeable/)).toBeDefined();
  });

  it('lists a movement recorded since, and says it is NOT in the figure', async () => {
    const db = await device();
    await seedSyncedBook(db);
    await seedMovementSince(db);
    panel(await synced(db));
    expect(screen.getByText(/1 movement has been recorded since/)).toBeDefined();
    expect(screen.getByText(/NOT included in it/)).toBeDefined();
    // Shown as its own line, and the headline is still the synced one.
    expect(screen.getByText(`${SIGN}7000.00`)).toBeDefined();
    expect(screen.queryByText(`${SIGN}6000.00`)).toBeNull();
  });
});

describe('the screen, with the radio off', () => {
  it('shows the synced position instead of only a refusal', async () => {
    const db = await device();
    await seedSyncedBook(db);
    renderScreen(db, { endpoint: ENDPOINT, fetchFn: DEAD_RADIO });
    await pickCustomer();

    expect(await screen.findByText(`${SIGN}7000.00`)).toBeDefined();
    expect(screen.getByText(/What this device last received/)).toBeDefined();
    // Still says the office could not be reached — the figure does not replace
    // the refusal, it sits beside it with its age on it.
    expect(screen.getByText(/Not available offline\./)).toBeDefined();
  });

  it('shows NOTHING when this device holds no position — the old rule, unchanged', async () => {
    const db = await device();
    renderScreen(db, { endpoint: ENDPOINT, fetchFn: DEAD_RADIO });
    await pickCustomer();

    expect(await screen.findByText(/Not available offline\./)).toBeDefined();
    expect(screen.queryByText(/What this device last received/)).toBeNull();
    expect(screen.queryByText(new RegExp(`\\${SIGN}\\d`))).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('never renders a synced figure where a verified one goes', async () => {
    const db = await device();
    await seedSyncedBook(db);
    const answers: Record<string, unknown> = {
      'credit.accountForCustomer': { accountId: ACCOUNT, customerId: CUSTOMER, status: 'ACTIVE' },
      'credit.exposure': {
        accountId: ACCOUNT,
        exposureMinor: '494400',
        creditLimitMinor: LIMIT,
        availableMinor: '4505600',
        status: 'ACTIVE',
        termsDays: 30,
        limitVersionId: null,
      },
      'credit.ageing': {
        accountId: ACCOUNT,
        asOf: AS_OF,
        agedBy: 'days_past_due',
        buckets: [
          { label: 'current', amountMinor: CURRENT_BUCKET },
          { label: '1-30', amountMinor: OVERDUE_BUCKET },
        ],
        onAccountCreditMinor: '0',
        feeOutstandingMinor: '0',
        invoices: [],
      },
    };
    const fetchFn: ApiFetch = (url) => {
      const path = new URL(url).pathname.replace('/trpc/', '');
      const json = answers[path];
      if (json === undefined) return Promise.reject(new Error('no radio'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { data: { json } } }),
      });
    };
    renderScreen(db, { endpoint: ENDPOINT, fetchFn });
    await pickCustomer();

    // The verified answer is on screen…
    expect(await screen.findByText(`${SIGN}4944.00`)).toBeDefined();
    expect(screen.getByText('Balance')).toBeDefined();
    // …and the synced panel is absent entirely. Two provenances, never mixed.
    expect(screen.queryByText(/What this device last received/)).toBeNull();
    expect(screen.queryByText(`${SIGN}7000.00`)).toBeNull();
  });

  it('still discards a verified figure when the refresh fails', async () => {
    const db = await device();
    // No snapshot on this device, so the ONLY thing that could put an old
    // figure back on screen is the very cache `useApiQuery` refuses to keep.
    let live = true;
    const answers: Record<string, unknown> = {
      'credit.accountForCustomer': { accountId: ACCOUNT, customerId: CUSTOMER, status: 'ACTIVE' },
      'credit.exposure': {
        accountId: ACCOUNT,
        exposureMinor: '494400',
        creditLimitMinor: LIMIT,
        availableMinor: '4505600',
        status: 'ACTIVE',
        termsDays: 30,
        limitVersionId: null,
      },
      'credit.ageing': {
        accountId: ACCOUNT,
        asOf: AS_OF,
        agedBy: 'days_past_due',
        buckets: [
          { label: 'current', amountMinor: CURRENT_BUCKET },
          { label: '1-30', amountMinor: OVERDUE_BUCKET },
        ],
        onAccountCreditMinor: '0',
        feeOutstandingMinor: '0',
        invoices: [],
      },
    };
    const fetchFn: ApiFetch = (url) => {
      if (!live) return Promise.reject(new Error('down'));
      const path = new URL(url).pathname.replace('/trpc/', '');
      const json = answers[path];
      if (json === undefined) return Promise.reject(new Error('no radio'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: { data: { json } } }),
      });
    };
    const view = render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <Credit
          db={db}
          permissions={holding([CAPABILITY.creditView])}
          apiOptions={{ endpoint: ENDPOINT, fetchFn }}
        />
      </CurrencyProvider>,
    );
    await pickCustomer();
    expect(await screen.findByText(`${SIGN}4944.00`)).toBeDefined();

    live = false;
    view.rerender(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <Credit
          db={db}
          permissions={holding([CAPABILITY.creditView])}
          apiOptions={{ endpoint: ENDPOINT, fetchFn: (u, i) => fetchFn(u, i) }}
        />
      </CurrencyProvider>,
    );
    await pickCustomer();
    await waitFor(() => expect(screen.getByText(/Not available offline\./)).toBeDefined());
    expect(screen.queryByText(`${SIGN}4944.00`)).toBeNull();
  });
});
