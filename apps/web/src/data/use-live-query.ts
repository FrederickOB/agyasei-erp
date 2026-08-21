import { useEffect, useState } from 'react';
import type { LocalDb } from './db.js';

/**
 * Declare the rows a component needs; re-runs when local data changes (§8.2).
 * Results are keyed so a slow query can never overwrite a newer one.
 * `undefined` means "not loaded yet" — distinct from a query that returned
 * nothing. There is no isLoading and no fetch: reads are local.
 */
export function useLiveQuery<T>(
  db: LocalDb,
  run: (db: LocalDb) => Promise<T>,
  deps: readonly unknown[],
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let latest = 0;
    const rerun = (): void => {
      const token = ++latest;
      void run(db).then((result) => {
        if (alive && token === latest) setValue(result);
      });
    };
    rerun();
    const unsubscribe = db.changes.subscribe(rerun);
    return () => {
      alive = false;
      unsubscribe();
    };
    // eslint-style exhaustive deps intentionally replaced by an explicit key list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, ...deps]);

  return value;
}
