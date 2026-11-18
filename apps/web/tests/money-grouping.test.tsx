// @vitest-environment jsdom
/**
 * Presentation-only thousands grouping for the office's figures. The
 * canonical string (`@erp/money` format) stays ungrouped and parseable; the
 * grouping is applied after it and never leaves the screen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { format } from '@erp/money';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { Money, groupDigits } from '../src/money/Money';

afterEach(cleanup);

describe('groupDigits', () => {
  it('groups the whole part only, keeps the fraction and the sign', () => {
    expect(groupDigits('1234567.89')).toBe('1,234,567.89');
    expect(groupDigits('-1234567.89')).toBe('-1,234,567.89');
    expect(groupDigits('999.99')).toBe('999.99');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits('0.05')).toBe('0.05');
  });
  it('is applied after the canonical format, which stays ungrouped', () => {
    expect(format(123456789n, DEV_PLACEHOLDER_CURRENCY)).toBe('1234567.89');
    expect(groupDigits(format(123456789n, DEV_PLACEHOLDER_CURRENCY))).toBe('1,234,567.89');
  });
});

describe('<Money grouped>', () => {
  it('renders the symbol before the grouped figure, sign first', () => {
    render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <Money grouped amount={-123456789n} />
        <Money grouped withSymbol={false} amount={1000n} />
        <Money amount={123456789n} />
      </CurrencyProvider>,
    );
    expect(screen.getByText('-¤1,234,567.89')).toBeTruthy();
    expect(screen.getByText('10.00')).toBeTruthy();
    // Ungrouped by default — the counter is unchanged.
    expect(screen.getByText('¤1234567.89')).toBeTruthy();
  });
});
