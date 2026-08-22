/**
 * WHICH LOCATIONS MAY THIS CALLER SEE — resolved from the database, per
 * request, for every cross-location read.
 *
 * `requiresPermission` answers "may this user do X at THIS place?" — the
 * right question for a write, which names one place. A cross-location report
 * asks the inverse: "which places may this user be told about at all?" There
 * is no single location to check, and getting the answer wrong in the
 * permissive direction leaks one outlet's takings to another outlet's
 * manager, or one region's margins to a neighbouring region — without
 * showing a single row that looks out of place.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIVE RULES THIS MODULE MAKES STRUCTURAL
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. **The scope is the intersection, never the union.** The request may
 *    NARROW what it asks for; it can never widen it. A requested location the
 *    caller does not hold the capability at is REFUSED, not silently dropped
 *    — a total that quietly excluded a location is a wrong number wearing a
 *    right number's clothes.
 *
 * 2. **Every aggregate is computed over the SAME resolved set as its parts.**
 *    The caller gets one list of location ids and both the per-location rows
 *    and the total are computed from it, so Σ(rows) = total is true by
 *    construction rather than by a second query that might disagree.
 *
 * 3. **A grouping node expands DOWN the closure.** Asking for a region node
 *    means "everything under it", resolved through `app.location_closure` —
 *    the same table the permission model expands grants through, so the two
 *    can never disagree about what "under" means.
 *
 * 4. **Empty scope denies.** A caller who holds the capability nowhere gets
 *    FORBIDDEN, not an empty report. An empty report reads as "no trade
 *    happened", which is a different and much worse statement.
 *
 * 5. **Nothing here reads a role name, a location code or a location type.**
 *    Scope is a set of node ids resolved from grants; `kind` is the closed
 *    PLATFORM enum (does this node sell / hold stock / group others), never a
 *    tenant's vocabulary (CLAUDE.md §2.9).
 */
import { TRPCError } from '@trpc/server';
import type { PermissionCode } from '@erp/db';
import type { VerifiedIdentity } from '../auth.js';
import type { TenantRunner } from '../db.js';
import { DENY, type PermissionState } from '../permissions.js';

/** A location in scope, with what a report needs to label and roll it up. */
export interface ScopedLocation {
  id: string;
  code: string;
  name: string;
  /** Closed platform enum: OUTLET | WAREHOUSE | GROUP | TRANSIT. */
  kind: string;
  parentId: string | null;
}

export interface LocationScope {
  /** The locations this request may report on. Never empty (empty denies). */
  readonly locations: readonly ScopedLocation[];
  readonly locationIds: readonly string[];
  /**
   * True when the caller holds the widening capability over the whole tenant
   * AND did not narrow the request — i.e. the totals really are network
   * totals. False means the totals are the totals of what this caller may
   * see, which is a different sentence and is reported as such.
   */
  readonly network: boolean;
}

export interface ScopeCtx {
  deps: { runner: TenantRunner };
  identity: VerifiedIdentity;
  permissions: PermissionState;
}

export interface ScopeRequest {
  /** The capability that grants sight of one location. */
  code: PermissionCode;
  /**
   * The capability that WIDENS the scope to the whole tenant when held at
   * every root of the location tree. A widener, never an alternative: a grant
   * made at a leaf expands down the closure and so never covers the root,
   * which is what stops leaf-scoped authority reaching a network total.
   */
  widenCode?: PermissionCode;
  /** The request's narrowing list. Grouping nodes expand to their subtree. */
  requested?: readonly string[] | undefined;
  /**
   * Location kinds that can carry the data being asked about. A GROUP node
   * has no till and no shelves, so it never appears as a row of its own.
   */
  kinds: readonly string[];
}

/** Does the caller hold `code` at EVERY root of the tenant's location tree? */
export function holdsTenantWide(state: PermissionState, code: PermissionCode): boolean {
  if (state.rootLocationIds.length === 0) return false;
  return state.rootLocationIds.every((root) => state.holdsAt(code, root));
}

const LOCATIONS_SQL = `
  select id, code, name, kind, parent_id
    from app.location
   where deleted_at is null
   order by code
`;

/**
 * Resolve the location scope for one request.
 *
 * Opens ONE tenant transaction of its own, so it must be called BEFORE any
 * other transaction is open — i.e. at the top of a handler, never inside a
 * `runIdempotent` plan/apply callback (see the transaction-discipline header
 * in ../permissions.ts). Reads run under `SET LOCAL ROLE app_user` with the
 * verified tenant GUC, so RLS is what stops a location id belonging to
 * another tenant from resolving at all — guessing a uuid gets you nothing.
 */
export async function resolveLocationScope(
  ctx: ScopeCtx,
  req: ScopeRequest,
): Promise<LocationScope> {
  const state = ctx.permissions;
  const widened = req.widenCode !== undefined && holdsTenantWide(state, req.widenCode);
  const held = new Set(state.locationsFor(req.code));

  if (!widened && held.size === 0) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${DENY.notHeld}: ${req.code} is not held by this user at any location`,
    });
  }

  return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
    const all = await tx.query<{
      id: string;
      code: string;
      name: string;
      kind: string;
      parent_id: string | null;
    }>(LOCATIONS_SQL);

    const byId = new Map<string, ScopedLocation>();
    for (const r of all.rows) {
      byId.set(r.id, {
        id: r.id,
        code: r.code,
        name: r.name,
        kind: r.kind,
        parentId: r.parent_id,
      });
    }

    /** Visible = held (or everything, when widened). Includes GROUP nodes. */
    const visible = (id: string): boolean => widened || held.has(id);

    let candidateIds: string[];
    if (req.requested === undefined) {
      candidateIds = [...byId.keys()].filter(visible);
    } else {
      // Rule 1: a requested location outside the caller's scope is REFUSED.
      // Unknown and out-of-scope are the same refusal on purpose — telling a
      // caller "that location exists but is not yours" is itself a fact about
      // another tenant's or another region's network.
      for (const id of req.requested) {
        if (!byId.has(id) || !visible(id)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `${DENY.outOfScope}: ${req.code} is not held at location ${id}`,
          });
        }
      }
      // Rule 3: a grouping node means everything under it, expanded through
      // the SAME closure the permission model expands grants through.
      const expanded = await tx.query<{ descendant_id: string }>(
        `select distinct descendant_id
           from app.location_closure
          where ancestor_id = any($1::uuid[])`,
        [[...req.requested]],
      );
      const ids = new Set<string>(req.requested);
      for (const row of expanded.rows) ids.add(row.descendant_id);
      candidateIds = [...ids].filter((id) => byId.has(id) && visible(id));
    }

    const locations = candidateIds
      .map((id) => byId.get(id)!)
      .filter((l) => req.kinds.includes(l.kind))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    if (locations.length === 0) {
      // Rule 4. Denies rather than returning an empty report: "you may see
      // nothing here" and "nothing happened here" must never look alike.
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          `${DENY.outOfScope}: ${req.code} resolves to no reportable location ` +
          `(kinds: ${req.kinds.join(', ')})`,
      });
    }

    return {
      locations,
      locationIds: locations.map((l) => l.id),
      network: widened && req.requested === undefined,
    };
  });
}

/**
 * The grouping nodes above a set of scoped locations, with which of those
 * locations sit under each.
 *
 * "Per region" is tenant #1's word for it; the platform's word is "a GROUP
 * node in the tenant's own tree" (04 §4.3), at whatever depth the tenant
 * chose. Another distributor's tree may be flat, or five deep, and this
 * returns one entry per grouping node either way — no code anywhere asks how
 * deep a region is (CLAUDE.md §2.9).
 *
 * The rows NEST: a location under Bono is also under the root, so it is
 * counted in both. Group subtotals therefore do NOT sum to the network total,
 * and the caller is told so rather than left to discover it by adding them up.
 */
export async function resolveGroupRollup(
  ctx: ScopeCtx,
  scope: LocationScope,
): Promise<{ group: ScopedLocation; memberIds: string[] }[]> {
  if (scope.locationIds.length === 0) return [];
  return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
    const res = await tx.query<{
      ancestor_id: string;
      code: string;
      name: string;
      kind: string;
      parent_id: string | null;
      descendant_id: string;
    }>(
      `select c.ancestor_id, l.code, l.name, l.kind, l.parent_id, c.descendant_id
         from app.location_closure c
         join app.location l on l.tenant_id = c.tenant_id and l.id = c.ancestor_id
        where c.descendant_id = any($1::uuid[])
          and l.kind = 'GROUP'
          and l.deleted_at is null
        order by l.code`,
      [[...scope.locationIds]],
    );
    const groups = new Map<string, { group: ScopedLocation; memberIds: string[] }>();
    for (const r of res.rows) {
      let entry = groups.get(r.ancestor_id);
      if (!entry) {
        entry = {
          group: {
            id: r.ancestor_id,
            code: r.code,
            name: r.name,
            kind: r.kind,
            parentId: r.parent_id,
          },
          memberIds: [],
        };
        groups.set(r.ancestor_id, entry);
      }
      entry.memberIds.push(r.descendant_id);
    }
    return [...groups.values()];
  });
}
