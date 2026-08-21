/**
 * The CurrencySpec reaches components through context, loaded from the local
 * config record (§8.9, ADR-0007). No component ever holds a currency symbol
 * or a minor-unit scale of its own.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { CurrencySpec } from '@erp/money';

const CurrencyCtx = createContext<CurrencySpec | null>(null);

export function CurrencyProvider({
  spec,
  children,
}: {
  readonly spec: CurrencySpec;
  readonly children: ReactNode;
}): ReactNode {
  return <CurrencyCtx.Provider value={spec}>{children}</CurrencyCtx.Provider>;
}

export function useCurrencySpec(): CurrencySpec {
  const spec = useContext(CurrencyCtx);
  if (spec === null) {
    throw new Error(
      'useCurrencySpec: no CurrencyProvider above this component — money cannot render without the tenant currency configuration',
    );
  }
  return spec;
}
