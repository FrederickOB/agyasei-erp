// @vitest-environment jsdom
/**
 * THE BOOKS SCREEN — tested for its three rules, not for rendering.
 *
 *  1. An EMPTY ledger is a state with a reason (the §2.8 accountant gate),
 *     never an error and never a silent blank.
 *  2. The mid-year balance-sheet gap is SHOWN and explained as unclosed
 *     profit — the screen must not hide it or pretend the sheet balances.
 *  3. Open posting exceptions render ABOVE the statements as an alert,
 *     because a statement over an incomplete ledger is quietly wrong.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Books } from '../src/features/books/Books';
import { CurrencyProvider } from '../src/money/CurrencyContext';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';

type Answer = { ok: true; json: unknown } | 'reject';

function router(answers: Readonly<Record<string, Answer>>): ApiFetch {
  return (url) => {
    const path = new URL(url).pathname.replace('/trpc/', '');
    const answer = answers[path];
    if (answer === undefined || answer === 'reject') return Promise.reject(new Error('no radio'));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { data: { json: answer.json } } }),
    });
  };
}

function options(answers: Readonly<Record<string, Answer>>): ApiCallOptions {
  return { endpoint: ENDPOINT, fetchFn: router(answers) };
}

const NO_EXCEPTIONS = { openCount: 0, exceptions: [] };
const EMPTY_TB = {
  accountCount: 0, rows: [], debitMinor: '0', creditMinor: '0', balanced: true, byLocation: [],
};

function statementRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: '018f3a1e-0000-7000-8000-0000000000a1', code: '4100', name: 'Sales revenue',
    accountType: 'INCOME', reportLineKey: 'line:4100', locationId: null, locationCode: null,
    netDebitMinor: '-515000', amountMinor: '515000', ...over,
  };
}

function renderBooks(answers: Readonly<Record<string, Answer>>) {
  return render(
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <Books apiOptions={options(answers)} />
    </CurrencyProvider>,
  );
}

afterEach(cleanup);

describe('rule 1 — an empty ledger is a state with a reason', () => {
  it('says there is no chart of accounts yet, and why, and shows no error', async () => {
    renderBooks({
      'ledger.trialBalance': { ok: true, json: EMPTY_TB },
      'ledger.postingExceptions': { ok: true, json: NO_EXCEPTIONS },
    });
    expect(await screen.findByText(/no chart of accounts yet/i)).toBeTruthy();
    expect(screen.getByText(/qualified accountant/i)).toBeTruthy();
    expect(screen.getByText(/deliberate, not a fault/i)).toBeTruthy();
    expect(screen.queryByText(/could not reach|refused/i)).toBeNull();
  });
});

describe('rule 2 — the mid-year gap is shown and explained, never hidden', () => {
  const BS = {
    accountCount: 7,
    rows: [statementRow({ accountType: 'ASSET', code: '1000', name: 'Till', amountMinor: '824000', netDebitMinor: '824000' })],
    assetMinor: '824000', liabilityMinor: '103000', equityMinor: '0',
    gapMinor: '206000', reconciles: true, resultMinor: '206000',
  };

  it('names the gap as unclosed profit that agrees with the P&L', async () => {
    renderBooks({
      'ledger.balanceSheet': { ok: true, json: BS },
      'ledger.postingExceptions': { ok: true, json: NO_EXCEPTIONS },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Balance sheet/ }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/unclosed\s+profit/i);
    expect(status.textContent).toMatch(/agrees with the profit & loss exactly/i);
  });

  it('…and when the statements DISAGREE, it says so as the failure it is', async () => {
    renderBooks({
      'ledger.balanceSheet': { ok: true, json: { ...BS, reconciles: false, resultMinor: '999' } },
      'ledger.postingExceptions': { ok: true, json: NO_EXCEPTIONS },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Balance sheet/ }));
    expect((await screen.findByRole('status')).textContent).toMatch(/STATEMENTS DISAGREE/);
  });
});

describe('rule 3 — open exceptions are the headline', () => {
  it('renders an alert above the statements naming the incomplete ledger', async () => {
    renderBooks({
      'ledger.trialBalance': {
        ok: true,
        json: {
          accountCount: 7, rows: [statementRow()], debitMinor: '515000', creditMinor: '515000',
          balanced: true,
          byLocation: [{ locationId: LOC, debitMinor: '515000', creditMinor: '515000', balanced: true }],
        },
      },
      'ledger.postingExceptions': {
        ok: true,
        json: {
          openCount: 3,
          exceptions: [{
            exceptionId: '018f3a1e-0000-7000-8000-0000000000e1',
            sourceKind: 'cash_sale', sourceId: '018f3a1e-0000-7000-8000-0000000000e2',
            locationId: LOC, documentDate: '2026-08-15', postingRole: 'COGS',
            errorCode: 'GL_MAPPING_MISSING', errorDetail: '1 posting role(s) are not mapped: COGS',
            severity: 1, openedAt: '2026-08-15T09:00:00.000Z', resolvedAt: null,
          }],
        },
      },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/3 settled document\(s\) have no journal entry/);
    expect(alert.textContent).toMatch(/cannot close/);
    expect(alert.textContent).toMatch(/GL_MAPPING_MISSING/);
  });

  it('a balanced trial balance says so at every location', async () => {
    renderBooks({
      'ledger.trialBalance': {
        ok: true,
        json: {
          accountCount: 7, rows: [statementRow()], debitMinor: '515000', creditMinor: '515000',
          balanced: true,
          byLocation: [{ locationId: LOC, debitMinor: '515000', creditMinor: '515000', balanced: true }],
        },
      },
      'ledger.postingExceptions': { ok: true, json: NO_EXCEPTIONS },
    });
    expect(await screen.findByText(/sums to zero.*every location/i)).toBeTruthy();
  });

  it('an UNBALANCED one is the loud failure, naming the location', async () => {
    renderBooks({
      'ledger.trialBalance': {
        ok: true,
        json: {
          accountCount: 7, rows: [statementRow()], debitMinor: '515000', creditMinor: '514999',
          balanced: false,
          byLocation: [{ locationId: LOC, debitMinor: '515000', creditMinor: '514999', balanced: false }],
        },
      },
      'ledger.postingExceptions': { ok: true, json: NO_EXCEPTIONS },
    });
    expect(await screen.findByText(/DOES NOT SUM TO ZERO/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`location ${LOC}`))).toBeTruthy();
  });
});

describe('a per-location statement names the outlet', () => {
  it('shows the outlet code when rows carry one — three "Till cash" rows are unreadable without it', async () => {
    renderBooks({
      'ledger.trialBalance': {
        ok: true,
        json: {
          accountCount: 7,
          rows: [
            statementRow({ code: '1000', name: 'Till cash', locationId: LOC, locationCode: 'OUT-01', amountMinor: '12296645', netDebitMinor: '12296645', accountType: 'ASSET' }),
            statementRow({ code: '1000', name: 'Till cash', locationId: '018f3a1e-0000-7000-8000-00000000bbbb', locationCode: 'OUT-02', amountMinor: '15085852', netDebitMinor: '15085852', accountType: 'ASSET' }),
          ],
          debitMinor: '27382497', creditMinor: '27382497', balanced: true,
          byLocation: [
            { locationId: LOC, debitMinor: '12296645', creditMinor: '12296645', balanced: true },
            { locationId: '018f3a1e-0000-7000-8000-00000000bbbb', debitMinor: '15085852', creditMinor: '15085852', balanced: true },
          ],
        },
      },
      'ledger.postingExceptions': { ok: true, json: NO_EXCEPTIONS },
    });
    expect(await screen.findByText('OUT-01')).toBeTruthy();
    expect(screen.getByText('OUT-02')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Outlet' })).toBeTruthy();
  });

  it('…and omits the column entirely on a consolidated statement', async () => {
    renderBooks({
      'ledger.trialBalance': {
        ok: true,
        json: {
          accountCount: 7, rows: [statementRow()], debitMinor: '515000', creditMinor: '515000',
          balanced: true, byLocation: [],
        },
      },
      'ledger.postingExceptions': { ok: true, json: NO_EXCEPTIONS },
    });
    await screen.findByText('Sales revenue');
    expect(screen.queryByRole('columnheader', { name: 'Outlet' })).toBeNull();
  });
});

describe('with the radio off, it refuses out loud', () => {
  it('shows the shared refusal, never a blank ledger', async () => {
    renderBooks({});
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByText(/no chart of accounts yet/i)).toBeNull();
  });
});
