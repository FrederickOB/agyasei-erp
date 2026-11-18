/**
 * Gives the counter and the printer screens the device's one PrintService.
 *
 * Optional by design: a component rendered WITHOUT a provider gets `null` and
 * simply has no printing — which is exactly how the counter's existing tests run
 * and how the counter behaves if printing could not start. Printing is never a
 * precondition of selling.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import { PrintService } from '../../printing/service';
import type { PrinterSettings } from '../../printing/settings';

const Ctx = createContext<PrintService | null>(null);

export function PrintingProvider({
  db,
  service,
  children,
}: {
  readonly db: LocalDb;
  /** Test seam. */
  readonly service?: PrintService;
  readonly children: ReactNode;
}): ReactNode {
  const svc = useMemo(() => service ?? new PrintService(db), [db, service]);
  useEffect(() => {
    let alive = true;
    void svc.loadSettings().then(() => {
      if (alive) svc.startAutoRetry();
    });
    return () => {
      alive = false;
      svc.stopAutoRetry();
    };
  }, [svc]);
  return <Ctx.Provider value={svc}>{children}</Ctx.Provider>;
}

export function usePrintService(): PrintService | null {
  return useContext(Ctx);
}

/** Re-renders when the service's settings or busy state change. */
export function usePrintServiceState(svc: PrintService | null): { settings: PrinterSettings | null; busy: boolean } {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (svc === null) return;
    return svc.subscribe(() => setVersion((v) => v + 1));
  }, [svc]);
  void version; // the state change itself is what re-renders the caller
  return { settings: svc?.settings ?? null, busy: svc?.isBusy ?? false };
}
