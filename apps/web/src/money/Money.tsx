/**
 * THE presentation boundary for money (ADR-0004, §8.3): a bigint minor-unit
 * amount becomes a string here, via @erp/money against the configured
 * CurrencySpec, and nowhere else. No literal currency symbol exists in any
 * component — a grep test enforces it.
 */
import type { ReactNode } from 'react';
import { format } from '@erp/money';
import { useCurrencySpec } from './CurrencyContext';

/**
 * Presentation-only thousands grouping: `1234567.89` → `1,234,567.89`. Applied
 * to the canonical string AFTER formatting, so the canonical form is untouched
 * and nothing grouped is ever parsed or sent (the wire rejects separators).
 * The separator is a product presentation default until the jurisdiction pack
 * carries one; it is not a jurisdiction branch.
 */
export function groupDigits(canonical: string): string {
  const negative = canonical.startsWith('-');
  const body = negative ? canonical.slice(1) : canonical;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const fraction = dot === -1 ? '' : body.slice(dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction}`;
}

export function Money({
  amount,
  withSymbol = true,
  grouped = false,
  className,
}: {
  readonly amount: bigint;
  readonly withSymbol?: boolean;
  /** Group thousands for reading at a glance — the office's figures. */
  readonly grouped?: boolean;
  readonly className?: string;
}): ReactNode {
  const spec = useCurrencySpec();
  const canonical = format(amount, spec);
  const shown = grouped ? groupDigits(canonical) : canonical;
  const text = withSymbol
    ? shown.startsWith('-')
      ? `-${spec.symbol}${shown.slice(1)}`
      : `${spec.symbol}${shown}`
    : shown;
  return <span className={className ?? 'money'}>{text}</span>;
}
