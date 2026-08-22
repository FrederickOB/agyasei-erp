/**
 * The session's capability list, resolved once per session and remembered.
 *
 * Separate from `useApiQuery` on purpose: that hook DISCARDS its previous
 * answer when a refresh fails, which is right for a figure somebody acts on
 * and wrong for a navigation bar. A tab that vanishes when the radio drops,
 * and reappears when it comes back, is worse than one that stays put — and
 * nothing behind the tab is authorised by its presence anyway
 * (`data/api/session.ts`).
 */
import { useCallback, useEffect, useState } from 'react';
import type { LocalDb } from '../db';
import { resolvePermissions, type PermissionsState } from './session';
import type { ApiCallOptions } from './client';

export interface PermissionsHandle {
  readonly state: PermissionsState;
  readonly refresh: () => void;
}

export function usePermissions(
  db: LocalDb,
  bearerToken: string | null,
  options: ApiCallOptions = {},
): PermissionsHandle {
  const [state, setState] = useState<PermissionsState>({ status: 'resolving' });
  const [attempt, setAttempt] = useState(0);
  const { endpoint, fetchFn, timeoutMs, nowMs } = options;

  useEffect(() => {
    let alive = true;
    void resolvePermissions(db, {
      bearerToken,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(fetchFn === undefined ? {} : { fetchFn }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(nowMs === undefined ? {} : { nowMs }),
    }).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [db, bearerToken, attempt, endpoint, fetchFn, timeoutMs, nowMs]);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, refresh };
}
