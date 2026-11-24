// @vitest-environment jsdom
/**
 * The credit screen, tested for the one failure that costs real money.
 *
 * **A stale credit balance shown confidently at a counter is how somebody
 * extends credit that is not there.** The credit book is in no sync bucket, so
 * a partitioned device does not know what a customer owes — and the whole
 * design of this screen is that it says so rather than showing an old figure,
 * a zero, or an empty ageing table, all three of which read as information.
 *
 * The rest follows from the same principle:
 *  · the ageing buckets must add up to the balance IN THE RENDERED VIEW, and
 *    when they do not, the screen says that instead of showing a headline with
 *    a breakdown under it that disagrees;
 *  · the fee carries the SERVER's own label, verbatim, and is stated to be
 *    not chargeable;
 *  · `412 FEE_POLICY_UNCONFIRMED` renders as a decision a person has to make —
 *    never as an error with a "Try again", because trying again is not what is
 *    missing (CLAUDE.md §2.8, open-questions Q4).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { CAPABILITY, type PermissionsState } from '../src/data/api/session';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { readPendingOps } from '../src/data/sync/upload';
import { Credit } from '../src/features/credit/Credit';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice, seedCustomer } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const ACCOUNT = '018f3a1e-0000-7000-8000-0000000000a1';
const CUSTOMER = '018f3a1e-0000-7000-8000-0000000000c1';
const VERSION = '018f3a1e-0000-7000-8000-0000000000v1'.replace('v', 'a');
const SIGN = DEV_PLACEHOLDER_CURRENCY.symbol;

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
    limitVersionId: VERSION,
    ...over,
  };
}

function ageingPayload(over: Record<string, unknown> = {}): unknown {
  return {
    accountId: ACCOUNT,
    asOf: '2026-08-22',
    agedBy: 'days_past_due',
    buckets: [
      { label: 'current', amountMinor: '300000' },
      { label: '1-30', amountMinor: '194400' },
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
    asOf: '2026-08-22',
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

function answering(over: Readonly<Record<string, Answer>> = {}): Readonly<Record<string, Answer>> {
  return {
    'credit.accountForCustomer': {
      ok: true,
      json: { accountId: ACCOUNT, customerId: CUSTOMER, status: 'ACTIVE' },
    },
    'credit.exposure': { ok: true, json: exposurePayload() },
    'credit.ageing': { ok: true, json: ageingPayload() },
    'credit.previewFacilityFee': { ok: true, json: feePayload() },
    ...over,
  };
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

/**
 * A device that knows the customer. It knows NOTHING about their account — no
 * identifier, no figure — because `credit.accountForCustomer` is the only
 * thing that can say which account belongs to whom.
 */
async function counter(): Promise<LocalDb> {
  const db = openTestDb();
  await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  await seedCustomer(db, { id: CUSTOMER, code: 'CU-001', name: 'Kofi Buildings' });
  return db;
}

function renderScreen(db: LocalDb, permissions: PermissionsState, apiOptions: ApiCallOptions) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Credit db={db} permissions={permissions} apiOptions={apiOptions} />
    </CurrencyProvider>,
  );
}

async function pickCustomer(): Promise<void> {
  // Either a row in the list or, if already chosen, the summary at the top:
  // picking the same customer twice is a no-op, as it was with the dropdown.
  const name = await screen.findByText('Kofi Buildings');
  const row = name.closest('button.customer-row');
  if (row !== null) fireEvent.click(row);
}

afterEach(cleanup);

// ---------------------------------------------------------------------------

describe('offline', () => {
  it('says unavailable offline and shows no balance at all', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: () => Promise.reject(new Error('down')),
    });
    await pickCustomer();

    expect(await screen.findByText(/Not available offline\./)).toBeDefined();
    // No figure, no zero, no empty ageing table.
    expect(screen.queryByText('Balance')).toBeNull();
    expect(screen.queryByText('Left to spend')).toBeNull();
    expect(screen.queryByText(new RegExp(`\\${SIGN}0\\.00`))).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('still lets somebody find the customer, because identity is on the device', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: () => Promise.reject(new Error('down')),
    });
    // The customer list is local (`tenant_customers` carries identity only),
    // so finding WHO works offline even though WHAT THEY OWE cannot.
    expect(await screen.findByRole('button', { name: /Kofi Buildings/ })).toBeDefined();
  });

  it('never shows a previously fetched balance after the connection drops', async () => {
    const db = await counter();
    let live = true;
    const fetchFn: ApiFetch = (url, init) =>
      live
        ? router(answering())(url, init)
        : Promise.reject(new Error('down'));
    const { rerender } = render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <Credit
          db={db}
          permissions={holding([CAPABILITY.creditView])}
          apiOptions={{ endpoint: ENDPOINT, fetchFn }}
        />
      </CurrencyProvider>,
    );
    await pickCustomer();
    expect(await screen.findByText(`${SIGN}4,944.00`)).toBeDefined();

    // The radio drops and the screen is asked again.
    live = false;
    rerender(
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
    // The old figure is GONE. `useApiQuery` discards the previous answer on a
    // failed refresh precisely so this cannot happen.
    expect(screen.queryByText(`${SIGN}4,944.00`)).toBeNull();
  });
});

describe('the balance and the headroom', () => {
  it('shows what is owed, the limit and what is left', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering()),
    });
    await pickCustomer();

    expect(await screen.findByText('Balance')).toBeDefined();
    expect(screen.getByText(`${SIGN}4,944.00`)).toBeDefined();
    expect(screen.getByText('Limit')).toBeDefined();
    // The limit is stated twice — in the headline figures and again beside the
    // control that changes it, which is where a person decides against it.
    expect(screen.getAllByText(`${SIGN}50,000.00`).length).toBeGreaterThan(0);
    expect(screen.getByText('Left to spend')).toBeDefined();
    expect(screen.getByText(`${SIGN}45,056.00`)).toBeDefined();
  });

  it('says an account is PAST its limit rather than showing a negative headroom', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.exposure': {
            ok: true,
            json: exposurePayload({ exposureMinor: '5100000', availableMinor: '-100000' }),
          },
          'credit.ageing': {
            ok: true,
            json: ageingPayload({
              buckets: [
                { label: 'current', amountMinor: '4905600' },
                { label: '1-30', amountMinor: '194400' },
              ],
            }),
          },
        }),
      ),
    });
    await pickCustomer();

    expect(await screen.findByText('Over the limit by')).toBeDefined();
    expect(screen.getByText(`${SIGN}1,000.00`)).toBeDefined();
    expect(screen.getByText(/already past its limit/)).toBeDefined();
  });
});

describe('the ageing buckets add up to the balance, in the rendered view', () => {
  it('renders every bucket and states that they reconcile', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering()),
    });
    await pickCustomer();

    const rows = await screen.findAllByRole('row');
    const text = rows.map((r) => r.textContent ?? '').join('|');
    expect(text).toContain('current');
    expect(text).toContain('1-30');
    // 3000.00 + 1944.00 = 4944.00, the balance above.
    expect(screen.getByText(`${SIGN}3,000.00`)).toBeDefined();
    // Twice: once as the bucket total, once as the invoice sitting in it.
    expect(screen.getAllByText(`${SIGN}1,944.00`).length).toBe(2);
    expect(screen.getByText(/add up to the figure above, exactly/)).toBeDefined();
    expect(screen.queryByText(/do not add up/)).toBeNull();
    // And the reader is told WHICH ageing this is — days past due, not
    // invoice age — because the two are different questions.
    expect(screen.getAllByText(/days past due/i).length).toBeGreaterThan(0);
  });

  it('words an invoice not yet due as days to go, never as negative days late', async () => {
    const db = await counter();
    const invoice = (id: string, daysPastDue: number) => ({
      chargeId: `018f3a1e-0000-7000-8000-0000000000${id}`,
      dueDate: '2026-09-17',
      daysPastDue,
      outstandingMinor: '100',
      bucket: 'current',
    });
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.ageing': {
            ok: true,
            json: ageingPayload({
              invoices: [invoice('b2', -26), invoice('b3', -1), invoice('b4', 0), invoice('b5', 33)],
            }),
          },
        }),
      ),
    });
    await pickCustomer();
    expect(await screen.findByText('Not due — 26 days to go')).toBeDefined();
    expect(screen.getByText('Not due — 1 day to go')).toBeDefined();
    expect(screen.getByText('Due today')).toBeDefined();
    expect(screen.getByText('33')).toBeDefined();
    expect(screen.queryByText('-26')).toBeNull();
  });

  it('says so, loudly, when the two answers do not reconcile', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.ageing': {
            ok: true,
            json: ageingPayload({
              buckets: [
                { label: 'current', amountMinor: '300000' },
                { label: '1-30', amountMinor: '100000' },
              ],
            }),
          },
        }),
      ),
    });
    await pickCustomer();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('do not add up');
    expect(alert.textContent).toContain(`${SIGN}4,944.00`);
    expect(alert.textContent).toContain(`${SIGN}4,000.00`);
    expect(screen.queryByText(/add up to the figure above, exactly/)).toBeNull();
  });

  it('keeps money paid but not yet applied on its own line', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.exposure': { ok: true, json: exposurePayload({ exposureMinor: '394400' }) },
          'credit.ageing': {
            ok: true,
            json: ageingPayload({ onAccountCreditMinor: '100000' }),
          },
        }),
      ),
    });
    await pickCustomer();

    expect(await screen.findByText('Paid, not yet put against an invoice')).toBeDefined();
    expect(screen.getByText(`${SIGN}1,000.00`)).toBeDefined();
    expect(screen.getByText(/never quietly taken off the oldest one/)).toBeDefined();
    expect(screen.queryByText(/do not add up/)).toBeNull();
  });
});

describe('the fee', () => {
  it('carries the server’s own label and says it is not chargeable', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering()),
    });
    await pickCustomer();

    // VERBATIM. Not re-worded on the device — somebody will quote it.
    expect(await screen.findByText('provisional — not chargeable')).toBeDefined();
    expect(screen.getByText(/not charged and not chargeable/)).toBeDefined();
    expect(screen.getByText(/must not be quoted as owing/)).toBeDefined();
    expect(screen.getByText(`${SIGN}38.88`)).toBeDefined();
  });

  it('does not offer posting to somebody who does not hold the capability', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering()),
    });
    await pickCustomer();
    await screen.findByText('provisional — not chargeable');
    expect(screen.queryByRole('button', { name: 'Post this to the account' })).toBeNull();
  });

  it('offers it to somebody who does — a courtesy, since the server checks again', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView, CAPABILITY.creditFeeAccrue]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering()),
    });
    await pickCustomer();
    expect(await screen.findByRole('button', { name: 'Post this to the account' })).toBeDefined();
  });

  it('renders the 412 as a decision a person has to make, with nothing to retry', async () => {
    const db = await counter();
    const asked: string[] = [];
    renderScreen(db, holding([CAPABILITY.creditView, CAPABILITY.creditFeeAccrue]), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.accrueFacilityFee': {
            ok: false,
            status: 412,
            message:
              'FEE_POLICY_UNCONFIRMED: the credit policy (Q4 decisions D-1..D-5) has not been ' +
              'confirmed by an Accounts-role human — accrual refuses to post (06 §6.4.5).',
          },
        }),
        asked,
      ),
    });
    await pickCustomer();
    fireEvent.click(await screen.findByRole('button', { name: 'Post this to the account' }));

    expect(await screen.findByText(/A person has to settle the fee rules first/)).toBeDefined();
    expect(screen.getByText(/Nothing has been posted and nothing is waiting to be/)).toBeDefined();
    expect(screen.getByText(/trying again will not change that/)).toBeDefined();
    // NOT an error state, and nothing offers to repeat the request.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The control that led here is now inert rather than inviting a second go.
    expect(
      screen.getByRole('button', { name: 'Post this to the account' }).hasAttribute('disabled'),
    ).toBe(true);
    // The server's own sentence is still available for whoever gets called.
    expect(screen.getByText(/FEE_POLICY_UNCONFIRMED/)).toBeDefined();
  });

  it('reports an ordinary refusal as one — nothing posted, and it is not the gate', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView, CAPABILITY.creditFeeAccrue]), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.accrueFacilityFee': {
            ok: false,
            status: 403,
            message: 'PERMISSION_DENIED: credit.fee.accrue is not held by this user',
          },
        }),
      ),
    });
    await pickCustomer();
    fireEvent.click(await screen.findByRole('button', { name: 'Post this to the account' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nothing was posted');
    expect(screen.queryByText(/A person has to settle the fee rules first/)).toBeNull();
  });

  it('shows the balance even when the fee working itself is refused', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering({ 'credit.previewFacilityFee': 'reject' })),
    });
    await pickCustomer();

    expect(await screen.findByText(`${SIGN}4,944.00`)).toBeDefined();
    expect(screen.getByText(/Not available offline\./)).toBeDefined();
  });
});

describe('finding the account, without asking a person for a UUID', () => {
  it('asks the server which account this customer has, and shows their position', async () => {
    const db = await counter();
    const asked: string[] = [];
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering(), asked),
    });
    await pickCustomer();

    expect(await screen.findByText(`${SIGN}4,944.00`)).toBeDefined();
    // The device asked; it did not remember, and it did not make anybody type.
    expect(asked).toContain('credit.accountForCustomer');
    expect(screen.queryByLabelText('Account reference')).toBeNull();
  });

  it('says the customer buys for cash when the server ANSWERS that they have none', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.accountForCustomer': {
            ok: false,
            status: 404,
            message: 'NO_CREDIT_ACCOUNT: this customer has no credit account.',
          },
        }),
      ),
    });
    await pickCustomer();

    expect(await screen.findByText(/buys for cash/)).toBeDefined();
    // No balance, no zero, no ageing table — there is nothing to owe.
    expect(screen.queryByText('Balance')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('OFFLINE it does NOT say "no account" — silence is not an answer', async () => {
    // The distinction that costs money: "this customer has no account" is the
    // only state in which opening one is offered, and reading it out of a dead
    // radio opens a second book for somebody who already has one.
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView, CAPABILITY.creditAccountManage]), {
      endpoint: ENDPOINT,
      fetchFn: () => Promise.reject(new Error('down')),
    });
    await pickCustomer();

    expect(await screen.findByText(/Not available offline\./)).toBeDefined();
    expect(screen.queryByText(/buys for cash/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open a credit account' })).toBeNull();
  });

  it('shows the server’s refusal when the account read fails', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.exposure': {
            ok: false,
            status: 404,
            message: 'credit account not found',
          },
        }),
      ),
    });
    await pickCustomer();

    expect(await screen.findByText(/The server would not answer this request\./)).toBeDefined();
    expect(screen.getByText(/credit account not found/)).toBeDefined();
    expect(screen.queryByText('Balance')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Who is offered what — permission-driven rendering, never a role name
// ---------------------------------------------------------------------------

const ACCOUNTS_CODES = [
  CAPABILITY.creditView,
  CAPABILITY.creditAccountManage,
  CAPABILITY.creditLimitChange,
  CAPABILITY.creditEntryRecord,
];

/** The outlet manager's real credit holding, per the template: the read only. */
const MANAGER_CODES = [CAPABILITY.creditView];

describe('what each session is offered', () => {
  it('ACCOUNTS is offered the limit change and the payment form', async () => {
    const db = await counter();
    renderScreen(db, holding(ACCOUNTS_CODES), {
      endpoint: ENDPOINT,
      fetchFn: router(answering()),
    });
    await pickCustomer();

    expect(await screen.findByRole('button', { name: 'Change the limit' })).toBeDefined();
    expect(screen.getByLabelText('Amount received')).toBeDefined();
  });

  it('AN OUTLET MANAGER sees the account and cannot create or amend it', async () => {
    const db = await counter();
    renderScreen(db, holding(MANAGER_CODES), {
      endpoint: ENDPOINT,
      fetchFn: router(answering()),
    });
    await pickCustomer();

    // Sees the money.
    expect(await screen.findByText(`${SIGN}4,944.00`)).toBeDefined();
    // Cannot change what they may owe, and is told whose decision it is.
    expect(screen.queryByRole('button', { name: 'Change the limit' })).toBeNull();
    expect(screen.getByText(/decided at the office/)).toBeDefined();
    // Cannot take a payment either — that is `credit.entry.record`.
    expect(screen.queryByLabelText('Amount received')).toBeNull();
  });

  it('AN OUTLET MANAGER is not offered to open an account for a cash customer', async () => {
    const db = await counter();
    renderScreen(db, holding(MANAGER_CODES), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.accountForCustomer': {
            ok: false,
            status: 404,
            message: 'NO_CREDIT_ACCOUNT: this customer has no credit account.',
          },
        }),
      ),
    });
    await pickCustomer();

    expect(await screen.findByText(/buys for cash/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Open a credit account' })).toBeNull();
    expect(screen.getByText(/decided at the office/)).toBeDefined();
  });

  it('ACCOUNTS is offered to open one, and the form sets the limit and the terms', async () => {
    const db = await counter();
    const asked: string[] = [];
    renderScreen(db, holding(ACCOUNTS_CODES), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.accountForCustomer': {
            ok: false,
            status: 404,
            message: 'NO_CREDIT_ACCOUNT: this customer has no credit account.',
          },
          'credit.openAccount': {
            ok: true,
            json: {
              accountId: ACCOUNT,
              customerId: CUSTOMER,
              termsDays: 30,
              feeRateBpPerMonth: 200,
              creditLimitMinor: '5000000',
            },
          },
        }),
        asked,
      ),
    });
    await pickCustomer();

    fireEvent.click(await screen.findByRole('button', { name: 'Open a credit account' }));
    fireEvent.change(screen.getByLabelText('Credit limit'), { target: { value: '50000' } });
    fireEvent.change(screen.getByLabelText('Terms in days'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open the account' }));

    await waitFor(() => expect(asked).toContain('credit.openAccount'));
  });

  it('somebody who may open an account but NOT set a limit is stopped at a non-zero one', async () => {
    // The constitution's hardest credit prohibition, as the SERVER states it:
    // `credit.limit.change` is required in addition, and only when the limit is
    // non-zero. The server checks it again; this saves a wasted round trip.
    const db = await counter();
    const asked: string[] = [];
    renderScreen(db, holding([CAPABILITY.creditView, CAPABILITY.creditAccountManage]), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.accountForCustomer': {
            ok: false,
            status: 404,
            message: 'NO_CREDIT_ACCOUNT: this customer has no credit account.',
          },
        }),
        asked,
      ),
    });
    await pickCustomer();

    fireEvent.click(await screen.findByRole('button', { name: 'Open a credit account' }));
    fireEvent.change(screen.getByLabelText('Credit limit'), { target: { value: '50000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open the account' }));

    expect((await screen.findByRole('alert')).textContent).toContain('separate permission');
    expect(asked).not.toContain('credit.openAccount');
  });
});

// ---------------------------------------------------------------------------
// The limit change — the compare-and-set, and the refusal that is not an error
// ---------------------------------------------------------------------------

function limitChangedPayload(): unknown {
  return {
    accountId: ACCOUNT,
    versionId: '018f3a1e-0000-7000-8000-0000000000a2',
    supersedesId: VERSION,
    previousLimitMinor: '5000000',
    creditLimitMinor: '8000000',
    previousTermsDays: 30,
    termsDays: 30,
    feeRateBpPerMonth: 200,
    effectiveFrom: '2026-08-22',
  };
}

async function openLimitForm(answers: Readonly<Record<string, Answer>>, asked: string[] = []) {
  const db = await counter();
  renderScreen(db, holding(ACCOUNTS_CODES), {
    endpoint: ENDPOINT,
    fetchFn: router(answers, asked),
  });
  await pickCustomer();
  fireEvent.click(await screen.findByRole('button', { name: 'Change the limit' }));
}

describe('changing the limit', () => {
  it('sends the version the person was looking at — the compare-and-set', async () => {
    const bodies: string[] = [];
    const capturing: ApiFetch = (url, init) => {
      if (new URL(url).pathname.endsWith('credit.setLimit')) bodies.push(init.body ?? '');
      return router(answering({ 'credit.setLimit': { ok: true, json: limitChangedPayload() } }))(
        url,
        init,
      );
    };
    const db = await counter();
    renderScreen(db, holding(ACCOUNTS_CODES), { endpoint: ENDPOINT, fetchFn: capturing });
    await pickCustomer();
    fireEvent.click(await screen.findByRole('button', { name: 'Change the limit' }));

    fireEvent.change(screen.getByLabelText('New credit limit'), { target: { value: '80000' } });
    fireEvent.change(screen.getByLabelText('Why the limit is changing'), {
      target: { value: 'deposit cleared' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change the limit' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    const sent = JSON.parse(bodies[0]!) as { json: Record<string, unknown> };
    // The claim, without which the write is last-write-wins wearing a contract.
    expect(sent.json['supersedesId']).toBe(VERSION);
    // Money as a decimal string of MINOR units, never a JS number.
    expect(sent.json['creditLimitMinor']).toBe('8000000');
    expect(sent.json['reason']).toBe('deposit cleared');
  });

  it('will not send without a reason', async () => {
    const asked: string[] = [];
    await openLimitForm(answering(), asked);
    fireEvent.change(screen.getByLabelText('New credit limit'), { target: { value: '80000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change the limit' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Say why');
    expect(asked).not.toContain('credit.setLimit');
  });

  it('renders a LOST compare-and-set as somebody else’s decision, with nothing to re-send', async () => {
    await openLimitForm(
      answering({
        'credit.setLimit': {
          ok: false,
          status: 409,
          message:
            "LIMIT_VERSION_STALE: this account's limit was decided by somebody else while you " +
            'were deciding. Nothing has been changed. The limit in force is 8000000 minor units.',
        },
      }),
    );
    fireEvent.change(screen.getByLabelText('New credit limit'), { target: { value: '30000' } });
    fireEvent.change(screen.getByLabelText('Why the limit is changing'), {
      target: { value: 'heard they are slow paying' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change the limit' }));

    expect(await screen.findByText(/Somebody else decided this limit first\./)).toBeDefined();
    // NOT AN ERROR AND NOT RETRYABLE. There is no way to push the same figure
    // over the top of theirs — 06 §6.6.3 deletes last-write-wins by name.
    expect(screen.queryByRole('button', { name: /Try again/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change the limit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Look at the account again' })).toBeDefined();
  });

  it('OFFLINE it says nothing was saved and nothing was queued', async () => {
    const db = await counter();
    // The position loads, then the radio dies before the decision is sent.
    let alive = true;
    const flaky: ApiFetch = (url, init) => {
      if (!alive && new URL(url).pathname.endsWith('credit.setLimit')) {
        return Promise.reject(new Error('down'));
      }
      return router(answering())(url, init);
    };
    renderScreen(db, holding(ACCOUNTS_CODES), { endpoint: ENDPOINT, fetchFn: flaky });
    await pickCustomer();
    fireEvent.click(await screen.findByRole('button', { name: 'Change the limit' }));
    alive = false;

    fireEvent.change(screen.getByLabelText('New credit limit'), { target: { value: '80000' } });
    fireEvent.change(screen.getByLabelText('Why the limit is changing'), {
      target: { value: 'raised while the radio was down' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change the limit' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nothing was queued');
    // Nothing entered the outbox: a limit is not a queued write, ever.
    expect(await readPendingOps(db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Taking a payment — queued, honest, and never a client-side balance
// ---------------------------------------------------------------------------

describe('recording a repayment', () => {
  async function takePayment(amount: string): Promise<LocalDb> {
    const db = await counter();
    renderScreen(db, holding(ACCOUNTS_CODES), {
      endpoint: ENDPOINT,
      fetchFn: router(answering()),
    });
    await pickCustomer();
    fireEvent.change(await screen.findByLabelText('Amount received'), {
      target: { value: amount },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record the payment' }));
    return db;
  }

  it('queues it locally, SIGNED, without waiting on a socket', async () => {
    const db = await takePayment('1000');
    await waitFor(async () => expect(await readPendingOps(db)).toHaveLength(1));

    const [op] = await readPendingOps(db);
    expect(op!.kind).toBe('credit_payment');
    const payload = JSON.parse(op!.payloadJson) as Record<string, unknown>;
    expect(payload['kind']).toBe('PAYMENT');
    // The person typed a positive figure; the sign convention is applied by
    // the builder, matching the database's own `ce_sign` CHECK.
    expect(payload['amountMinor']).toBe('-100000');
    expect(payload['accountId']).toBe(ACCOUNT);
  });

  it('says it is on this device and NOT YET SENT', async () => {
    await takePayment('1000');
    const receipt = await screen.findByText(/Recorded on this device/);
    expect(receipt.textContent).toContain('will be sent when there is a connection');
  });

  it('DOES NOT CHANGE THE BALANCE ON SCREEN, and says the balance excludes it', async () => {
    // The rule this whole feature turns on. The device does not hold the credit
    // ledger, so any "new balance" it produced would be a subtraction against a
    // base it cannot see. Balance stays behind a server answer.
    await takePayment('1000');
    await screen.findByText(/Recorded on this device/);

    expect(screen.getByText(`${SIGN}4,944.00`)).toBeDefined();
    // 4944.00 − 1000.00 would be 3944.00. It must appear nowhere.
    expect(screen.queryByText(`${SIGN}3,944.00`)).toBeNull();
    expect(screen.getByText(/does not include it/)).toBeDefined();
  });

  it('refuses a zero payment on the device, queueing nothing', async () => {
    const db = await takePayment('0');
    expect((await screen.findByRole('alert')).textContent).toContain('some amount');
    expect(await readPendingOps(db)).toHaveLength(0);
  });

  it('is not offered when the capability could not be checked — a queued write is strict', async () => {
    // `holdsCapability` answers TRUE for `unknown`, on purpose, for READS. A
    // QUEUED write is asked the other way: a FORBIDDEN ack is retried for ever
    // at the head of an ordered queue and every sale behind it stops draining.
    const db = await counter();
    renderScreen(
      db,
      {
        status: 'unknown',
        failure: { kind: 'offline', message: 'no', detail: null, status: null },
      },
      { endpoint: ENDPOINT, fetchFn: router(answering()) },
    );
    await pickCustomer();
    await screen.findByText(`${SIGN}4,944.00`);

    expect(screen.queryByLabelText('Amount received')).toBeNull();
    expect(screen.getByText(/not part of what this device may do/)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cutting a customer off — the switch behind a check that already existed
// ---------------------------------------------------------------------------

/**
 * The till has always refused a credit sale on an account that is not ACTIVE.
 * Nothing could move an account off ACTIVE, so a customer who stopped paying
 * could not be cut off from a screen at all.
 *
 * What this group holds the screen to:
 *  · the STATUS is visible to everybody who can read the account, and the
 *    control is offered only to whoever holds `credit.account.manage`;
 *  · the decision carries the status the person was looking at, so it cannot
 *    be applied over the top of somebody else's;
 *  · a refusal to CLOSE an account that still owes money names the thing that
 *    would work — suspend it — rather than an error code;
 *  · the screen never claims a reach it does not have: a till that is dark now
 *    keeps selling on credit until it syncs, and it says so.
 */
function statusPayload(over: Record<string, unknown> = {}): unknown {
  return {
    accountId: ACCOUNT,
    changed: true,
    fromStatus: 'ACTIVE',
    status: 'SUSPENDED',
    changeId: '018f3a1e-0000-7000-8000-0000000000d1',
    exposureMinor: '494400',
    ...over,
  };
}

async function openStatusForm(
  answers: Readonly<Record<string, Answer>>,
  asked: string[] = [],
): Promise<LocalDb> {
  const db = await counter();
  renderScreen(db, holding(ACCOUNTS_CODES), { endpoint: ENDPOINT, fetchFn: router(answers, asked) });
  await pickCustomer();
  fireEvent.click(await screen.findByRole('button', { name: 'Stop this account' }));
  return db;
}

describe('stopping and reopening an account', () => {
  it('the holder is offered the control; the outlet manager SEES the status and is not', async () => {
    const db = await counter();
    renderScreen(db, holding(ACCOUNTS_CODES), { endpoint: ENDPOINT, fetchFn: router(answering()) });
    await pickCustomer();
    expect(await screen.findByRole('button', { name: 'Stop this account' })).toBeDefined();
    cleanup();

    const db2 = await counter();
    renderScreen(db2, holding(MANAGER_CODES), { endpoint: ENDPOINT, fetchFn: router(answering()) });
    await pickCustomer();
    // The STATUS is not hidden from them — it is on the balance panel and said
    // again in words. Only the decision is somebody else's.
    expect(await screen.findByText(/Whether they may buy on account at all/)).toBeDefined();
    expect(screen.getAllByText(/ACTIVE/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Stop this account' })).toBeNull();
    expect(screen.getByText(/Stopping or reopening this account/)).toBeDefined();
  });

  it('sends the status the person was looking at — the compare-and-set', async () => {
    const bodies: string[] = [];
    const capturing: ApiFetch = (url, init) => {
      if (new URL(url).pathname.endsWith('credit.setStatus')) bodies.push(init.body ?? '');
      return router(answering({ 'credit.setStatus': { ok: true, json: statusPayload() } }))(
        url,
        init,
      );
    };
    const db = await counter();
    renderScreen(db, holding(ACCOUNTS_CODES), { endpoint: ENDPOINT, fetchFn: capturing });
    await pickCustomer();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop this account' }));

    fireEvent.change(screen.getByLabelText('Why the status is changing'), {
      target: { value: 'cheque returned unpaid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save this decision' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    const sent = JSON.parse(bodies[0]!) as { json: Record<string, unknown> };
    expect(sent.json['status']).toBe('SUSPENDED');
    expect(sent.json['expectedStatus']).toBe('ACTIVE');
    expect(sent.json['reason']).toBe('cheque returned unpaid');
  });

  it('says what suspending actually does — credit stops, cash does not', async () => {
    await openStatusForm(answering());
    const note = screen.getByText(/No new credit sales/);
    expect(note.textContent).toContain('still buy for cash');
    expect(note.textContent).toContain('still owe what they owe');
  });

  it('will not send without a reason', async () => {
    const asked: string[] = [];
    await openStatusForm(answering(), asked);
    fireEvent.click(screen.getByRole('button', { name: 'Save this decision' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Say why');
    expect(asked).not.toContain('credit.setStatus');
  });

  it('renders a LOST compare-and-set as somebody else’s decision, with nothing to re-send', async () => {
    await openStatusForm(
      answering({
        'credit.setStatus': {
          ok: false,
          status: 409,
          message:
            'CREDIT_STATUS_STALE: you decided against an account you believed was ACTIVE, and ' +
            'it is SUSPENDED. Nothing has been changed.',
        },
      }),
    );
    fireEvent.change(screen.getByLabelText('Why the status is changing'), {
      target: { value: 'heard they are slow paying' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save this decision' }));

    expect(await screen.findByText(/This account moved while you were deciding\./)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Try again/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save this decision' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Look at the account again' })).toBeDefined();
  });

  it('a refused CLOSE names the thing that would work, instead of an error code', async () => {
    await openStatusForm(
      answering({
        'credit.setStatus': {
          ok: false,
          status: 412,
          message:
            'CREDIT_STATUS_CLOSE_BLOCKED: this account still stands at 494400 minor units.',
        },
      }),
    );
    fireEvent.change(screen.getByLabelText('New account status'), { target: { value: 'CLOSED' } });
    fireEvent.change(screen.getByLabelText('Why the status is changing'), {
      target: { value: 'tidying the ledger' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save this decision' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Suspend it instead');
    expect(alert.textContent).toContain('leaves the debt exactly where it is');
    expect(alert.textContent).not.toContain('CREDIT_STATUS_CLOSE_BLOCKED');
  });

  it('a SUSPENDED account offers reopening, not stopping, and says the till refuses it', async () => {
    const db = await counter();
    renderScreen(db, holding(ACCOUNTS_CODES), {
      endpoint: ENDPOINT,
      fetchFn: router(
        answering({
          'credit.exposure': { ok: true, json: exposurePayload({ status: 'SUSPENDED' }) },
        }),
      ),
    });
    await pickCustomer();
    expect(
      await screen.findByRole('button', { name: 'Change the account status' }),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Stop this account' })).toBeNull();
    expect(screen.getByText(/The till will refuse a credit sale on it/)).toBeDefined();
  });

  it('OFFLINE it says nothing was saved, and nothing enters the outbox', async () => {
    const db = await counter();
    let alive = true;
    const flaky: ApiFetch = (url, init) => {
      if (!alive && new URL(url).pathname.endsWith('credit.setStatus')) {
        return Promise.reject(new Error('down'));
      }
      return router(answering())(url, init);
    };
    renderScreen(db, holding(ACCOUNTS_CODES), { endpoint: ENDPOINT, fetchFn: flaky });
    await pickCustomer();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop this account' }));
    alive = false;

    fireEvent.change(screen.getByLabelText('Why the status is changing'), {
      target: { value: 'decided while the radio was down' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save this decision' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nothing was queued');
    // A suspension is NEVER a queued write: it would sit in an ordered outbox
    // behind the very credit sales it was written to stop.
    expect(await readPendingOps(db)).toHaveLength(0);
  });

  it('does not claim a reach it has not got — a dark till keeps selling until it syncs', async () => {
    await openStatusForm(answering());
    const note = screen.getByText(/A till that is offline right now/);
    expect(note.textContent).toContain('can keep selling on account until then');
  });
});
