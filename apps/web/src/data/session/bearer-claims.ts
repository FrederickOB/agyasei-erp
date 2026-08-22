/**
 * Reading the device's OWN bearer, for one purpose: to learn which location(s)
 * the session it already holds is scoped to.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS NOT TRUST. IT IS SELF-CONFIGURATION.
 * ═══════════════════════════════════════════════════════════════════════════
 * The token is DECODED here, never verified — no signature check, no expiry
 * check, no attempt at either. That is deliberate and it is safe, because
 * nothing decided here is an authorization decision:
 *
 *   - The server re-verifies the token on every single request and re-derives
 *     the same scope server-side. `assertLocationInScope` (apps/api/src/trpc.ts)
 *     compares the location a write names against the VERIFIED `locs` claim
 *     and answers FORBIDDEN when it does not match. A device that lied to
 *     itself here gets its sales refused there; it does not get to file them.
 *   - The tenant boundary is not read here at all. `tenant_id` is never
 *     asserted by a client (CLAUDE.md §2.1) — the server stamps it from the
 *     verified token on every write. This module deliberately reads no `tid`.
 *
 * So the worst a tampered token achieves is a device that configures itself
 * into a location the server will not accept, and refuses its own sales. The
 * alternative — inventing a location id client-side — is the one that files a
 * sale against an outlet that never saw it.
 *
 * The claim set is the API's (apps/api/src/auth.ts): { tid, uid, role, locs }.
 * Only `locs` is read.
 */

/** A UUID in any version — location ids come from the server, not from us. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BearerScope =
  /** No bearer at all — local-only mode, the offline rehearsal (§8.1). */
  | { readonly kind: 'absent' }
  /** A bearer this device cannot read. Names why, so it can be fixed. */
  | { readonly kind: 'unreadable'; readonly reason: string }
  /** The session's location scope, exactly as the server will enforce it. */
  | { readonly kind: 'scoped'; readonly locationIds: readonly string[] };

function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The `locs` claim of the device's bearer.
 *
 * Every failure is reported, never swallowed into an empty scope: "this token
 * has no locations" and "this token cannot be read" are different problems
 * with different fixes, and a counter cannot act on a message that conflates
 * them.
 */
export function readBearerScope(token: string | null | undefined): BearerScope {
  if (typeof token !== 'string' || token.trim().length === 0) return { kind: 'absent' };

  const parts = token.trim().split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload.length === 0) {
    return { kind: 'unreadable', reason: 'the sign-in token is not in the expected format' };
  }

  let claims: unknown;
  try {
    claims = JSON.parse(decodeBase64Url(payload));
  } catch {
    return { kind: 'unreadable', reason: 'the sign-in token’s claims could not be read' };
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    return { kind: 'unreadable', reason: 'the sign-in token’s claims are not an object' };
  }

  const locs = (claims as Record<string, unknown>)['locs'];
  if (locs === undefined) {
    // Absent is NOT the same as empty: an empty claim is a decision the server
    // made about this user; a missing claim is a token from somewhere else.
    return { kind: 'unreadable', reason: 'the sign-in token carries no location scope' };
  }
  if (!Array.isArray(locs)) {
    return { kind: 'unreadable', reason: 'the sign-in token’s location scope is not a list' };
  }

  const locationIds: string[] = [];
  for (const entry of locs) {
    if (typeof entry !== 'string' || !UUID_RE.test(entry)) {
      return { kind: 'unreadable', reason: 'the sign-in token names a location it cannot identify' };
    }
    // The server's claim is a list; a duplicate in it is not two choices.
    if (!locationIds.includes(entry)) locationIds.push(entry);
  }
  return { kind: 'scoped', locationIds };
}

/**
 * The `uid` claim — WHO this device's session belongs to.
 *
 * Same standing as `readBearerScope` above: decoded, never verified, and used
 * for nothing but self-configuration. Its one job is to key device-local
 * caches of things that belong to a person rather than to a device — today,
 * the remembered capability list (`data/api/session.ts`), so a tablet handed
 * from one member of staff to the next does not show the previous session's
 * affordances while the radio is down. It is compared against a cache, never
 * sent anywhere and never used to decide whether anything is allowed.
 *
 * `null` means "no readable subject", which callers must treat as "no usable
 * cache" — never as "any cache will do".
 */
export function readBearerUserId(token: string | null | undefined): string | null {
  if (typeof token !== 'string' || token.trim().length === 0) return null;
  const parts = token.trim().split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload.length === 0) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(decodeBase64Url(payload));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  const uid = (claims as Record<string, unknown>)['uid'];
  return typeof uid === 'string' && uid.length > 0 ? uid : null;
}
