/**
 * THE presentation boundary for money (ADR-0004, §8.3): a bigint minor-unit
 * amount becomes a string here, via @erp/money against the configured
 * CurrencySpec, and nowhere else. No literal currency symbol exists in any
 * component — a grep test enforces it.
 */
import type { ReactNode } from 'react';
import { format, formatWithSymbol } from '@erp/money';
import { useCurrencySpec } from './CurrencyContext';

export function Money({
  amount,
  withSymbol = true,
  className,
}: {
  readonly amount: bigint;
  readonly withSymbol?: boolean;
  readonly className?: string;
}): ReactNode {
  const spec = useCurrencySpec();
  const text = withSymbol ? formatWithSymbol(amount, spec) : format(amount, spec);
  return <span className={className ?? 'money'}>{text}</span>;
}
