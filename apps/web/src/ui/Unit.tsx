/**
 * A unit of measure, named the way the tenant named it.
 *
 * Server reads (low stock, orders, receipts, reports) carry a unit's CODE —
 * `BAR_12M`, `BAG`, `KG` — because a code is what joins. A code is not what a
 * person reads: "503 BAR_12M" is a database talking. The tenant's own name
 * for each unit is already on this device (the synced `unit_of_measure` table),
 * so this resolves code → name once, live, for every screen.
 *
 * Tenant vocabulary arrives as data (§2.9): nothing here names a unit. When a
 * code has no synced row — a unit created since the last sync, or a screen
 * rendered without a provider (tests) — the code itself is shown, which is
 * what every screen showed before this existed.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { LocalDb } from '../data/db';
import { useLiveQuery } from '../data/use-live-query';

type UnitNames = ReadonlyMap<string, string>;

const EMPTY: UnitNames = new Map();
const UnitNamesCtx = createContext<UnitNames>(EMPTY);

async function loadUnitNames(db: LocalDb): Promise<UnitNames> {
  const rows = await db.getAll('SELECT code, name FROM unit_of_measure');
  const names = new Map<string, string>();
  for (const row of rows) {
    const code = row['code'];
    const name = row['name'];
    if (typeof code === 'string' && typeof name === 'string' && name.trim().length > 0) {
      names.set(code, name.trim());
    }
  }
  return names;
}

export function UnitNamesProvider({ db, children }: { readonly db: LocalDb; readonly children: ReactNode }): ReactNode {
  const names = useLiveQuery(db, loadUnitNames, []);
  return <UnitNamesCtx.Provider value={names ?? EMPTY}>{children}</UnitNamesCtx.Provider>;
}

/** The display name for a unit code; the code itself when none is known. */
export function useUnitName(): (code: string) => string {
  const names = useContext(UnitNamesCtx);
  return (code) => names.get(code) ?? code;
}

/**
 * Inline unit name, lower-cased for reading after a number: "503 12m bar".
 * Plain text, not an element, so "503 12m bar" stays one run of text for a
 * screen reader, for copy-paste and for anything that matches on it.
 */
export function Unit({ code }: { readonly code: string }): ReactNode {
  const name = useUnitName()(code);
  return <>{name === code ? code : name.toLowerCase()}</>;
}
