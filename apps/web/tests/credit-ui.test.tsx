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
import { writeCreditAccountRef, readCreditAccountRef } from '../src/data/session/credit-account-ref';
import { Credit } from '../src/features/credit/Credit';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { provisionDevice, seedCustomer } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const ACCOUNT = '018f3a1e-0000-7000-8000-0000000000a1';
const CUSTOMER = '018f3a1e-0000-7000-8000-0000000000c1';
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

/** A device that knows the customer and has been told the account reference. */
async function counter(options: { readonly withRef?: boolean } = {}): Promise<LocalDb> {
  const db = openTestDb();
  await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  await seedCustomer(db, { id: CUSTOMER, code: 'CU-001', name: 'Kofi Buildings' });
  if (options.withRef !== false) await writeCreditAccountRef(db, CUSTOMER, ACCOUNT);
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
  const select = await screen.findByLabelText('Which customer');
  await waitFor(() => expect(screen.getByRole('option', { name: /Kofi Buildings/ })).toBeDefined());
  fireEvent.change(select, { target: { value: CUSTOMER } });
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
    expect(await screen.findByRole('option', { name: /Kofi Buildings/ })).toBeDefined();
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
    expect(await screen.findByText(`${SIGN}4944.00`)).toBeDefined();

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
    expect(screen.queryByText(`${SIGN}4944.00`)).toBeNull();
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
    expect(screen.getByText(`${SIGN}4944.00`)).toBeDefined();
    expect(screen.getByText('Limit')).toBeDefined();
    expect(screen.getByText(`${SIGN}50000.00`)).toBeDefined();
    expect(screen.getByText('Left to spend')).toBeDefined();
    expect(screen.getByText(`${SIGN}45056.00`)).toBeDefined();
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
    expect(screen.getByText(`${SIGN}1000.00`)).toBeDefined();
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
    expect(screen.getByText(`${SIGN}3000.00`)).toBeDefined();
    // Twice: once as the bucket total, once as the invoice sitting in it.
    expect(screen.getAllByText(`${SIGN}1944.00`).length).toBe(2);
    expect(screen.getByText(/add up to the figure above, exactly/)).toBeDefined();
    expect(screen.queryByText(/do not add up/)).toBeNull();
    // And the reader is told WHICH ageing this is — days past due, not
    // invoice age — because the two are different questions.
    expect(screen.getAllByText(/days past due/i).length).toBeGreaterThan(0);
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
    expect(alert.textContent).toContain(`${SIGN}4944.00`);
    expect(alert.textContent).toContain(`${SIGN}4000.00`);
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
    expect(screen.getByText(`${SIGN}1000.00`)).toBeDefined();
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

    expect(await screen.findByText(`${SIGN}4944.00`)).toBeDefined();
    expect(screen.getByText(/Not available offline\./)).toBeDefined();
  });
});

describe('addressing an account', () => {
  it('asks for the reference once, states why, and remembers only that', async () => {
    const db = await counter({ withRef: false });
    const asked: string[] = [];
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering(), asked),
    });
    await pickCustomer();

    const field = await screen.findByLabelText('Account reference');
    expect(screen.getByText(/It never remembers a balance/)).toBeDefined();
    // Nothing has been asked of the server yet — there is nothing to ask about.
    expect(asked).toEqual([]);

    fireEvent.change(field, { target: { value: ACCOUNT } });
    fireEvent.click(screen.getByRole('button', { name: 'Look this account up' }));

    expect(await screen.findByText(`${SIGN}4944.00`)).toBeDefined();
    // Remembered — the identifier, and nothing else.
    expect(await readCreditAccountRef(db, CUSTOMER)).toBe(ACCOUNT);
  });

  it('refuses text that is not an account reference, without asking the server', async () => {
    const db = await counter({ withRef: false });
    const asked: string[] = [];
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering(), asked),
    });
    await pickCustomer();

    fireEvent.change(await screen.findByLabelText('Account reference'), {
      target: { value: 'CU-001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look this account up' }));

    expect((await screen.findByRole('alert')).textContent).toContain('not an account reference');
    expect(asked).toEqual([]);
  });

  it('lets somebody replace a reference this device noted, so a wrong one is not a dead end', async () => {
    const db = await counter();
    renderScreen(db, holding([CAPABILITY.creditView]), {
      endpoint: ENDPOINT,
      fetchFn: router(answering()),
    });
    await pickCustomer();
    await screen.findByText(`${SIGN}4944.00`);

    fireEvent.click(screen.getByRole('button', { name: 'Use a different account reference' }));

    // The note is gone and the screen is asking for the reference again —
    // never stuck on a refusal it cannot correct.
    await waitFor(() => expect(screen.getByLabelText('Account reference')).toBeDefined());
    expect(await readCreditAccountRef(db, CUSTOMER)).toBeNull();
  });

  it('shows the server’s refusal when the reference names no account', async () => {
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

    // A wrong IDENTIFIER fails loudly; that is exactly why an identifier may be
    // remembered on the device and a figure may not.
    expect(await screen.findByText(/The server would not answer this request\./)).toBeDefined();
    expect(screen.getByText(/credit account not found/)).toBeDefined();
    expect(screen.queryByText('Balance')).toBeNull();
  });
});
