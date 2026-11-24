// @vitest-environment jsdom
/**
 * THE P&L SHEET — Books' first tab: the management profit and loss and the
 * expenses that feed it (migration 0033; apps/api/src/routers/expenses.ts).
 *
 * Tested for what it must SAY, not for how it renders:
 *  1. It is the default tab, and the ledger's statement is "Ledger P&L" now —
 *     two things called "Profit & loss" on one screen would be one too many.
 *  2. It says, every time, that these are management figures and not the
 *     audited ledger.
 *  3. The statement reads Sales → Cost of goods sold → Gross profit (margin) →
 *     expenses by category → Total → Net profit / Net LOSS, with the figures
 *     the server sent (bigint end to end; a loss shown as a loss, not "-").
 *  4. What is estimated is named (stated cost) and what is missing is listed
 *     with what to do about it — never silently zero.
 *  5. An empty period is a sentence, not an error.
 *  6. "Record expense" is offered only to someone holding expense.record; the
 *     form refuses too many decimal places before sending, sends the amount
 *     as the TEXT typed, and holds ONE idempotency key across a retry.
 *  7. A void asks for a reason, in place, and sends it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import type { PermissionsState } from '../src/data/api/session';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Books } from '../src/features/books/Books';
import { CurrencyProvider } from '../src/money/CurrencyContext';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const OUT1 = '018f3a1e-0000-7000-8000-00000000aaa1';
const OUT2 = '018f3a1e-0000-7000-8000-00000000aaa2';
const CAT_RENT = '018f3a1e-0000-7000-8000-0000000000c1';
const CAT_FUEL = '018f3a1e-0000-7000-8000-0000000000c2';
const CAT_ACC = '018f3a1e-0000-7000-8000-0000000000c3';
const EXP_1 = '018f3a1e-0000-7000-8000-0000000000e1';

type Answer = { ok: true; json: unknown } | 'reject';
interface Sent {
  readonly path: string;
  readonly method: string;
  readonly input: Record<string, unknown> | null;
}

/** A fake server: answers by path (a function may vary its answer per call) and records what was sent. */
function server(answers: Readonly<Record<string, Answer | ((n: number) => Answer)>>) {
  const sent: Sent[] = [];
  const counts = new Map<string, number>();
  const fetchFn: ApiFetch = (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace('/trpc/', '');
    const raw = init.method === 'GET' ? u.searchParams.get('input') : (init.body ?? null);
    const parsed = raw === null ? null : (JSON.parse(raw) as { json?: Record<string, unknown> }).json ?? null;
    sent.push({ path, method: init.method, input: parsed });
    const n = (counts.get(path) ?? 0) + 1;
    counts.set(path, n);
    const spec = answers[path];
    const answer = typeof spec === 'function' ? spec(n) : spec;
    if (answer === undefined || answer === 'reject') return Promise.reject(new Error('no radio'));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { data: { json: answer.json } } }),
    });
  };
  const options: ApiCallOptions = { endpoint: ENDPOINT, fetchFn };
  return { sent, options };
}

function figures(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    netSalesMinor: '0', cogsMinor: '0', cogsAtStatedCostMinor: '0', cogsComplete: true, missingCostCount: 0,
    grossProfitMinor: '0', grossMarginPctE4: null, expenses: [], totalExpensesMinor: '0', netProfitMinor: '0',
    ...over,
  };
}

/** The API test's own hand-computed month, as the wire carries it. */
const SHEET = {
  from: '2026-08-01',
  to: '2026-08-31',
  currencyCode: 'XTS',
  basis: 'MANAGEMENT',
  note: 'Management figures from your sales, costs and recorded expenses — not the audited ledger.',
  scope: { network: true, locationCount: 2 },
  wholeBusinessIncluded: true,
  consolidated: figures({
    netSalesMinor: '54000', cogsMinor: '35958', cogsAtStatedCostMinor: '3704', cogsComplete: false, missingCostCount: 1,
    grossProfitMinor: '18042', grossMarginPctE4: '334111',
    expenses: [
      { categoryId: CAT_ACC, categoryName: 'Accountant fee', amountMinor: '80000' },
      { categoryId: CAT_FUEL, categoryName: 'Fuel', amountMinor: '35075' },
      { categoryId: CAT_RENT, categoryName: 'Rent', amountMinor: '150000' },
    ],
    totalExpensesMinor: '265075', netProfitMinor: '-247033',
  }),
  wholeBusiness: {
    expenses: [{ categoryId: CAT_ACC, categoryName: 'Accountant fee', amountMinor: '80000' }],
    totalExpensesMinor: '80000',
  },
  locations: [
    {
      locationId: OUT1, locationCode: 'OUT-01', locationName: 'First outlet', kind: 'OUTLET',
      ...figures({
        netSalesMinor: '43000', cogsMinor: '27958', cogsAtStatedCostMinor: '3704', cogsComplete: false, missingCostCount: 1,
        grossProfitMinor: '15042', grossMarginPctE4: '349814',
        expenses: [
          { categoryId: CAT_FUEL, categoryName: 'Fuel', amountMinor: '35075' },
          { categoryId: CAT_RENT, categoryName: 'Rent', amountMinor: '150000' },
        ],
        totalExpensesMinor: '185075', netProfitMinor: '-170033',
      }),
    },
    {
      locationId: OUT2, locationCode: 'OUT-02', locationName: 'Second outlet', kind: 'OUTLET',
      ...figures({ netSalesMinor: '11000', cogsMinor: '8000', grossProfitMinor: '3000', grossMarginPctE4: '272727', netProfitMinor: '3000' }),
    },
  ],
  missingCost: [
    {
      productId: '018f3a1e-0000-7000-8000-0000000000f1', skuCode: 'SKU-NOCOST', productName: 'Binding wire',
      uomCode: 'roll', qtyScale: 0, qtySold: '4', byLocation: [{ locationId: OUT1, qtySold: '4' }],
    },
  ],
  method: 'Sales are ex-tax, after discounts, net of voids and returns.',
};

const LIST = {
  from: '2026-08-01',
  to: '2026-08-31',
  wholeBusinessIncluded: true,
  expenses: [
    {
      expenseId: EXP_1, expenseDate: '2026-08-05', locationId: OUT1, locationCode: 'OUT-01', locationName: 'First outlet',
      categoryId: CAT_RENT, categoryName: 'Rent', amountMinor: '150000', currencyCode: 'XTS', paidFrom: 'BANK',
      payee: 'Landlord', reference: 'AUG-RENT', note: null, recordedBy: '018f3a1e-0000-7000-8000-0000000000u1',
      recordedByName: 'Ama', recordedAt: '2026-08-05T10:00:00.000Z', voided: false, voidReason: null,
      voidedByName: null, voidedAt: null,
    },
  ],
};

const NO_EXCEPTIONS = { openCount: 0, exceptions: [] };

function permissions(codes: readonly string[]): PermissionsState {
  return {
    status: 'live',
    asOfMs: 0,
    snapshot: {
      userId: '018f3a1e-0000-7000-8000-0000000000u1',
      grants: codes.flatMap((code) => [OUT1, OUT2].map((locationId) => ({ code, locationId }))),
      codes,
      locationIds: [OUT1, OUT2],
    },
  };
}

function renderBooks(options: ApiCallOptions, perms?: PermissionsState) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Books apiOptions={options} permissions={perms} />
    </CurrencyProvider>,
  );
}

const READY = {
  'expenses.profitSheet': { ok: true as const, json: SHEET },
  'expenses.list': { ok: true as const, json: LIST },
  'ledger.postingExceptions': { ok: true as const, json: NO_EXCEPTIONS },
};

/** The statement's row for a label, as text — e.g. "Sales 540.00". */
function rowText(table: HTMLElement, label: RegExp): string {
  const row = within(table).getByRole('rowheader', { name: label }).closest('tr');
  return (row?.textContent ?? '').replace(/\s+/g, ' ');
}

afterEach(cleanup);

describe('rule 1 — the P&L sheet is the first tab; the ledger’s is "Ledger P&L"', () => {
  it('opens on the P&L sheet, and no tab is called "Profit & loss" any more', async () => {
    renderBooks(server(READY).options);
    expect((await screen.findByRole('button', { name: 'P&L sheet' })).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Ledger P&L' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Profit & loss' })).toBeNull();
    // The header no longer claims nothing here can be edited.
    expect(screen.getByText(/expenses you record here/)).toBeTruthy();
  });
});

describe('rules 2–4 — management figures, said so; the statement in order; estimates named, gaps listed', () => {
  it('shows the consolidated statement exactly as the server computed it', async () => {
    const { options, sent } = server(READY);
    renderBooks(options);
    const table = await screen.findByRole('table', { name: /profit and loss/i });
    expect(screen.getByText(/not the audited ledger/)).toBeTruthy();

    expect(rowText(table, /^Sales/)).toMatch(/540\.00/);
    expect(rowText(table, /^Cost of goods sold/)).toMatch(/359\.58/);
    expect(rowText(table, /^Cost of goods sold/)).toMatch(/incomplete/);
    expect(rowText(table, /^Gross profit/)).toMatch(/margin 33\.41%.*180\.42/);
    expect(rowText(table, /^Accountant fee/)).toMatch(/800\.00/);
    expect(rowText(table, /^Fuel/)).toMatch(/350\.75/);
    expect(rowText(table, /^Rent/)).toMatch(/1,500\.00/);
    expect(rowText(table, /^Total expenses/)).toMatch(/2,650\.75/);
    // A loss is called a loss, and shown as its size — never a bare minus sign.
    expect(rowText(table, /^Net loss/)).toMatch(/2,470\.33/);
    expect(rowText(table, /^Net loss/)).not.toMatch(/-/);
    // The order a person reads a P&L in.
    const order = Array.from(table.querySelectorAll('tr > th:first-child')).map((h) =>
      (h.textContent ?? '').split(/margin|incomplete/)[0]!.trim(),
    );
    expect(order).toEqual(['Sales', 'Cost of goods sold', 'Gross profit', 'Operating expenses', 'Accountant fee', 'Fuel', 'Rent', 'Total expenses', 'Net loss']);

    // Estimated: named, with its amount. Missing: listed with what to do.
    expect(screen.getByText(/uses the cost price stated in\s+Products/).textContent).toMatch(/37\.04/);
    const warn = screen.getByRole('note');
    expect(warn.textContent).toMatch(/1 product was sold with no\s+cost at all/);
    expect(warn.textContent).toMatch(/profit above is overstated/);
    expect(warn.textContent).toMatch(/Add a cost\s+price in Products/);
    expect(warn.textContent).toMatch(/Binding wire \(SKU-NOCOST\) — 4 roll sold/);
    expect(screen.getByText(/booked to the whole business rather than to one/).textContent).toMatch(/800\.00/);

    // Asked for this month, unfiltered, as a query — no location narrowing on the wire.
    const ask = sent.find((s) => s.path === 'expenses.profitSheet')!;
    expect(ask.method).toBe('GET');
    expect(ask.input).not.toHaveProperty('locationIds');
  });

  it('one location: its own figures, and the whole-business expenses said to belong to none', async () => {
    renderBooks(server(READY).options);
    await screen.findByRole('table', { name: /profit and loss/i });
    fireEvent.change(screen.getByRole('combobox', { name: 'Location' }), { target: { value: OUT2 } });
    const table = await screen.findByRole('table', { name: /profit and loss/i });
    expect(screen.getByRole('heading', { name: /Profit & loss · OUT-02/ })).toBeTruthy();
    expect(rowText(table, /^Sales/)).toMatch(/110\.00/);
    expect(rowText(table, /^Gross profit/)).toMatch(/margin 27\.27%/);
    expect(rowText(table, /^No expenses recorded/)).toMatch(/0\.00/);
    expect(rowText(table, /^Net profit/)).toMatch(/30\.00/);
    expect(screen.getByText(/count only under All locations/)).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull(); // OUT-02's cost of goods is complete
    // The expense list narrows with it: OUT-01's rent is not shown at OUT-02.
    expect(screen.getByText(/No expenses recorded at this location in this period/)).toBeTruthy();
  });

  it('switching to Last month asks for the whole previous calendar month', async () => {
    const { options, sent } = server(READY);
    renderBooks(options);
    await screen.findByRole('table', { name: /profit and loss/i });
    fireEvent.click(screen.getByRole('button', { name: 'Last month' }));
    await waitFor(() => expect(sent.filter((s) => s.path === 'expenses.profitSheet').length).toBe(2));
    const last = sent.filter((s) => s.path === 'expenses.profitSheet')[1]!.input!;
    expect(String(last['from'])).toMatch(/^\d{4}-\d{2}-01$/);
    const to = String(last['to']);
    const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000);
    expect(next.getUTCDate()).toBe(1); // `to` is the last day of its month
  });
});

describe('rule 5 — an empty period is a state', () => {
  it('says nothing was sold and nothing spent, with no error and no table of zeros', async () => {
    renderBooks(
      server({
        ...READY,
        'expenses.profitSheet': { ok: true, json: { ...SHEET, consolidated: figures(), wholeBusiness: { expenses: [], totalExpensesMinor: '0' }, locations: [], missingCost: [] } },
        'expenses.list': { ok: true, json: { ...LIST, expenses: [] } },
      }).options,
    );
    expect(await screen.findByText(/Nothing was sold and no expenses were recorded in this period/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: /profit and loss/i })).toBeNull();
    expect(screen.queryByText(/could not|refused/i)).toBeNull();
  });

  it('with the radio off, it refuses out loud rather than showing a blank sheet', async () => {
    renderBooks(server({}).options);
    expect((await screen.findAllByRole('status')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table', { name: /profit and loss/i })).toBeNull();
  });
});

describe('rule 6 — recording an expense', () => {
  it('is not offered without expense.record', async () => {
    renderBooks(server(READY).options, permissions(['gl.view']));
    await screen.findByRole('table', { name: /profit and loss/i });
    expect(screen.queryByRole('button', { name: /Record expense/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Void/ })).toBeNull();
  });

  it('refuses too many decimals before sending; sends the typed text; ONE key across a retry', async () => {
    const { options, sent } = server({
      ...READY,
      'expenses.categories': { ok: true, json: { categories: [{ categoryId: CAT_RENT, code: null, name: 'Rent', sortOrder: 0 }] } },
      // The first attempt is lost on the radio; the retry lands.
      'expenses.record': (n) =>
        n === 1
          ? 'reject'
          : { ok: true, json: { expenseId: 'x', expenseDate: '2026-08-05', locationId: null, categoryId: CAT_RENT, categoryName: 'Rent', categoryCreated: false, amountMinor: '125050', currencyCode: 'XTS', paidFrom: 'BANK' } },
    });
    renderBooks(options, permissions(['gl.view', 'expense.record']));
    fireEvent.click(await screen.findByRole('button', { name: /Record expense/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Record an expense' });
    const submit = within(dialog).getByRole('button', { name: /Record expense/ });

    fireEvent.change(within(dialog).getByRole('combobox', { name: /Category/ }), { target: { value: 'rent' } });
    // Once the categories arrive, "rent" is recognised as the existing "Rent".
    await waitFor(() => expect(within(dialog).queryByText(/New category/)).toBeNull());
    const amount = within(dialog).getByRole('textbox', { name: /Amount/ });
    fireEvent.change(amount, { target: { value: '12.505' } });
    expect(within(dialog).getByText(/at most 2 decimal places/)).toBeTruthy();
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(amount, { target: { value: '1250.50' } });
    expect(within(dialog).getByText(/Records/).textContent).toMatch(/1,250\.50/);
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Where/ }), { target: { value: '' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Paid from/ }), { target: { value: 'BANK' } });
    fireEvent.click(submit);
    expect(await within(dialog).findByRole('alert')).toBeTruthy(); // the radio dropped
    fireEvent.click(submit); // retry
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/Expense recorded/)).toBeTruthy();

    const posts = sent.filter((s) => s.path === 'expenses.record');
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.method === 'POST')).toBe(true);
    expect(posts[0]!.input!['idempotencyKey']).toBe(posts[1]!.input!['idempotencyKey']);
    expect(posts[1]!.input).toMatchObject({
      amount: '1250.50', // the TEXT typed, in major units — the server parses it exactly
      locationId: null, // the whole business
      category: { id: CAT_RENT }, // "rent" matched the existing "Rent"
      paidFrom: 'BANK',
    });
    expect(posts[1]!.input).not.toHaveProperty('tenantId');
    // The sheet and the list asked again, so the P&L counts it.
    await waitFor(() => expect(sent.filter((s) => s.path === 'expenses.profitSheet').length).toBeGreaterThanOrEqual(2));
  });

  it('a new category name is sent as a name, to be created with the expense', async () => {
    const { options, sent } = server({
      ...READY,
      'expenses.categories': { ok: true, json: { categories: [] } },
      'expenses.record': { ok: true, json: { expenseId: 'x', expenseDate: '2026-08-05', locationId: OUT1, categoryId: 'y', categoryName: 'Generator fuel', categoryCreated: true, amountMinor: '5000', currencyCode: 'XTS', paidFrom: 'CASH' } },
    });
    renderBooks(options, permissions(['gl.view', 'expense.record']));
    fireEvent.click(await screen.findByRole('button', { name: /Record expense/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Category/ }), { target: { value: 'Generator fuel' } });
    expect(within(dialog).getByText(/New category/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Amount/ }), { target: { value: '50' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Where/ }), { target: { value: OUT1 } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Record expense/ }));
    await waitFor(() => expect(sent.some((s) => s.path === 'expenses.record')).toBe(true));
    expect(sent.find((s) => s.path === 'expenses.record')!.input).toMatchObject({
      category: { name: 'Generator fuel' }, amount: '50', locationId: OUT1, paidFrom: 'CASH',
    });
  });
});

describe('rule 7 — a void asks why, in place', () => {
  it('needs a reason, then sends it with the expense id', async () => {
    const { options, sent } = server({
      ...READY,
      'expenses.void': { ok: true, json: { voidId: 'v', expenseId: EXP_1, reason: 'entered twice' } },
    });
    renderBooks(options, permissions(['gl.view', 'expense.record']));
    fireEvent.click(await screen.findByRole('button', { name: /^Void Rent expense/ }));
    const confirm = screen.getByRole('button', { name: 'Void expense' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // no reason, no void
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /Why is this expense void/ }), { target: { value: 'entered twice' } });
    fireEvent.click(confirm);
    expect(await screen.findByText(/Voided the Rent expense of 2026-08-05/)).toBeTruthy();
    expect(sent.find((s) => s.path === 'expenses.void')!.input).toMatchObject({ expenseId: EXP_1, reason: 'entered twice' });
  });

  it('a voided expense is marked, struck through, and offers no second void', async () => {
    renderBooks(
      server({
        ...READY,
        'expenses.list': { ok: true, json: { ...LIST, expenses: [{ ...LIST.expenses[0]!, voided: true, voidReason: 'typed twice', voidedAt: '2026-08-06T00:00:00.000Z' }] } },
      }).options,
      permissions(['gl.view', 'expense.record']),
    );
    expect(await screen.findByText(/Voided — typed twice/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Void Rent expense/ })).toBeNull();
  });
});
