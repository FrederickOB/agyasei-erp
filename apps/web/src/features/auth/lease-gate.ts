/**
 * The offline lease as the SCREENS see it (02-security §2.7).
 *
 *   full        nothing changes — the server decides every write at ingest.
 *   restricted  only `offline_mode = always` capabilities are offered: cash at
 *               the list price, lookups, reprints. Credit, adjustments,
 *               receipts and the rest are taken off the screen until a sync.
 *   sealed      read-only: no capability is offered; queued writes are kept.
 *
 * Applied to the PermissionsState the shell already routes on, so the
 * destination rail and every "may I offer this?" question follow the lease
 * with no second mechanism. Like every client gate this is a control ON THE
 * DEVICE — a rooted tablet defeats it (§2.7 says so) — which is why the
 * sync-service liveness join and server re-authorization carry the weight.
 */
import { createContext, useContext } from 'react';
import type { LeaseClaims } from '@erp/contracts';
import type { CapabilityGrant, PermissionsState } from '../../data/api/session';
import { offlineAllows, type LeaseMode, type LeaseVerdict } from '../../data/auth/lease';

export interface LeaseGate {
  /** 'none' on the dev and local-only paths: no lease exists, nothing is gated. */
  readonly mode: LeaseMode | 'none';
  readonly allows: (code: string) => boolean;
  readonly secondsLeft: number | null;
  readonly reason: LeaseVerdict['reason'] | null;
}

export const ALLOW_ALL: LeaseGate = { mode: 'none', allows: () => true, secondsLeft: null, reason: null };

export const LeaseContext = createContext<LeaseGate>(ALLOW_ALL);

export function useLeaseGate(): LeaseGate {
  return useContext(LeaseContext);
}

export function gateFrom(verdict: LeaseVerdict, claims: LeaseClaims | null): LeaseGate {
  if (verdict.mode === 'full') {
    return { mode: 'full', allows: () => true, secondsLeft: verdict.secondsLeft, reason: verdict.reason };
  }
  return {
    mode: verdict.mode,
    allows: (code) => offlineAllows(verdict, claims, code),
    secondsLeft: verdict.secondsLeft,
    reason: verdict.reason,
  };
}

/**
 * Narrow a permission state to what the lease allows. `full` and `none` pass
 * it through untouched; restricted keeps only lease-`always` grants; sealed
 * keeps none. A state with no snapshot is given one built from the lease, so
 * "I could not ask the server" never re-opens what the lease has closed.
 */
export function applyLease(state: PermissionsState, gate: LeaseGate, scope: readonly string[] = []): PermissionsState {
  if (gate.mode === 'none' || gate.mode === 'full') return state;
  const keep = (g: CapabilityGrant): boolean => gate.allows(g.code);
  if (state.status === 'live' || state.status === 'remembered') {
    const grants = state.snapshot.grants.filter(keep);
    return {
      ...state,
      snapshot: {
        ...state.snapshot,
        grants,
        codes: [...new Set(grants.map((g) => g.code))].sort(),
        locationIds: [...new Set(grants.map((g) => g.locationId))].sort(),
      },
    };
  }
  if (state.status === 'no-session') return state;
  // resolving / unknown: the lease is the only answer this device has.
  return {
    status: 'remembered',
    asOfMs: Date.now(),
    failure: {
      kind: 'offline',
      message: 'Working offline on the last lease.',
      detail: `lease ${gate.mode}`,
      status: null,
    },
    snapshot: { userId: '', grants: [], codes: [], locationIds: [...scope] },
  };
}
