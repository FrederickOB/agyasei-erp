// @vitest-environment jsdom
/**
 * CLAUDE.md §2.7 category 1: money rendering. The Money component is THE
 * presentation boundary — @erp/money format()/formatWithSymbol() against the
 * CurrencySpec from configuration. The scale is a jurisdiction value: a
 * scale-0 spec must render with no decimals (nothing assumes 100 minor units).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CurrencySpec } from '@erp/money';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { Money } from '../src/money/Money';

afterEach(cleanup);

const GENERIC_SIGN = '¤'; // the placeholder symbol from dev config
const scale2: CurrencySpec = { code: 'XTS', symbol: GENERIC_SIGN, scale: 2 };
const scale0: CurrencySpec = { code: 'XTS', symbol: GENERIC_SIGN, scale: 0 };

function renderMoney(amount: bigint, spec: CurrencySpec, withSymbol = true): void {
  render(
    <CurrencyProvider spec={spec}>
      <Money amount={amount} withSymbol={withSymbol} />
    </CurrencyProvider>,
  );
}

describe('<Money>', () => {
  it('renders through format() with the configured symbol and scale', () => {
    renderMoney(123456n, scale2);
    expect(screen.getByText(`${GENERIC_SIGN}1,234.56`)).toBeTruthy();
  });

  it('renders negatives with the sign before the symbol', () => {
    renderMoney(-5n, scale2);
    expect(screen.getByText(`-${GENERIC_SIGN}0.05`)).toBeTruthy();
  });

  it('respects a scale-0 currency — no assumed 100 minor units', () => {
    renderMoney(1234n, scale0);
    expect(screen.getByText(`${GENERIC_SIGN}1,234`)).toBeTruthy();
  });

  it('can render the bare canonical amount without a symbol', () => {
    renderMoney(150n, scale2, false);
    expect(screen.getByText('1.50')).toBeTruthy();
  });

  it('refuses to render without a CurrencyProvider — no fallback symbol exists', () => {
    expect(() => render(<Money amount={1n} />)).toThrow(/CurrencyProvider/);
  });
});
