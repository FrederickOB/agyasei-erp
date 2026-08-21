/**
 * The session's own view of itself.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THIS IS A UX AFFORDANCE. IT IS NOT THE CONTROL.
 * ═════════════════════════════════════════════════════════════════════════
 * `session.permissions` exists so a till can grey out the button it must not
 * offer, and so a clerk gets an immediate, comprehensible refusal instead of
 * filling in a form that will be rejected after the customer has walked out
 * with the goods. That is layer 3 of 02 §2.3, and layer 3 "protects nothing.
 * Usability only. Fails trivially, via devtools."
 *
 * The control is the server re-deriving the decision when the write arrives
 * (`apps/api/src/permissions.ts`). Nothing in this response is trusted on the
 * way back in: the client cannot send a permission, cannot send a location
 * scope, and cannot send a bound. A device that edits its local copy of this
 * payload — trivial on a rooted tablet, and the threat model assumes physical
 * possession — changes what its own screen offers and changes nothing about
 * what the server accepts.
 *
 * It is also NOT a sync-scope answer. What comes down to a tablet is decided
 * by the sync rules and the device's `sync_profile`, which are strictly
 * narrower than "may read" (02 §2.5: the right to see something is not the
 * right to have it on your device).
 *
 * Deliberately NOT bolted onto `GET /sync/token`: minting that token must not
 * touch the database — `apps/api/test/sync-token.test.ts` wires a runner that
 * throws if it does — and a permission answer is a database answer.
 */
import { permissionState } from '../permissions.js';
import { router, tenantProcedure } from '../trpc.js';

export interface SessionGrant {
  code: string;
  locationId: string;
  /**
   * The merged, most-permissive bound, or null for unbounded. Money members
   * are DECIMAL STRINGS in the currency's minor unit (ADR-0004) — a JSON
   * number would be a float64 the moment the client parsed it.
   */
  bound: Record<string, string | number | boolean> | null;
}

export const sessionRouter = router({
  /**
   * Every capability this user holds and WHERE, resolved from the database
   * for this request. Never read from the token — the same resolution the
   * enforcement path uses, so the screen and the server cannot drift.
   */
  permissions: tenantProcedure.query(async ({ ctx }) => {
    const state = await permissionState(ctx);

    const grants: SessionGrant[] = [];
    for (const [code, byLocation] of state.effective.byCode) {
      for (const [locationId, resolved] of byLocation) {
        grants.push({
          code,
          locationId,
          bound: resolved.bound === null ? null : { ...resolved.bound },
        });
      }
    }
    grants.sort((a, b) => a.code.localeCompare(b.code) || a.locationId.localeCompare(b.locationId));

    return {
      /**
       * Stated in the payload, not only in this file's header, because the
       * next person to read it will be reading it in a network tab.
       */
      advisory:
        'UX AFFORDANCE ONLY — the server re-authorises every write at ingest. ' +
        'Do not treat absence here as security, or presence here as permission.',
      userId: state.userId,
      grants,
      /** Distinct locations this session may act at in some way. */
      locationIds: [...new Set(grants.map((g) => g.locationId))].sort(),
    };
  }),
});
