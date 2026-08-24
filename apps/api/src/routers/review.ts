/**
 * THE HUMAN REVIEW QUEUE — reading it, claiming a row, and resolving it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * Migration 0006 opens with the sentence this router is the answer to:
 * "A review queue nobody works is silent overwriting with extra steps."
 * It then built the queue, and three writers fill it —
 *
 *   * `sequence.ts`  — a receipt-number block regressed (conflict class #14)
 *   * `sales.ts`     — a receipt number collided on the sale path
 *   * `receiving.ts` — a counted quantity fell outside the unit's tolerance
 *
 * — and NOTHING could ever take a row out. No router, no client, no screen,
 * no resolver, no scheduler. The Phase 2 gate found six rows on the live
 * database, every one `open`, none ever claimed or resolved
 * (`docs/phase2-gate-evidence.md`). CLAUDE.md §2.2 requires that every
 * conflict which cannot be resolved automatically reaches a human; they
 * reached a table, which is not the same thing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHO SEES WHAT — TWO CONDITIONS, BOTH REQUIRED
 * ─────────────────────────────────────────────────────────────────────────
 * 1. The caller holds `sync.conflict.review` — that is what gets you into the
 *    queue at all, and it is the procedure guard.
 * 2. The caller holds THE ROW'S OWN `required_permission` AT ONE OF THE ROW'S
 *    OWN LOCATIONS. Migration 0006 routes the queue by permission and never by
 *    named individual, "because naming a person is how a queue rots the first
 *    time someone takes leave", and §3.6.2's own correction normalised scope
 *    into `conflict_review_location` so a severity-1 item does not broadcast
 *    to every eligible holder at all 25 outlets.
 *
 * `required_permission` is plain text with no FK, so an unrecognised code
 * must DENY rather than wave through: `holdsAt` returns false for any code
 * outside the catalogue, and a row nobody can be shown is reported in the
 * response's `hiddenCount` rather than silently dropped — an invisible review
 * is the defect this file exists to fix, and it must not be reintroduced by
 * a filter that hides its own misses.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO OFFLINE PATH, DELIBERATELY
 * ─────────────────────────────────────────────────────────────────────────
 * Resolving a conflict is a decision about which of two divergent facts is
 * true — and the row exists precisely because a partitioned device could not
 * make that call. A device working a stale queue would resolve rows another
 * device has already resolved, against a `pending_value` that has since moved.
 * So reviews are read and written online, like a supplier's payment terms and
 * unlike a sale (`docs/phase2-status.md` §5). No sync bucket, and the client
 * refuses out loud rather than queueing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A RESOLUTION DOES AND DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────
 * It records a HUMAN DECISION against the row. It does NOT write the decided
 * value back onto the conflicted entity, and that restraint is deliberate:
 * the three classes live today have no safe generic write-back (a printed
 * receipt number cannot be un-printed; a received quantity has already moved
 * stock), and a generic "apply this jsonb to that table" path would be an
 * arbitrary-write primitive reachable over HTTP. Per-class write-back arrives
 * with the classes that need it — the credit-limit case in CLAUDE.md §2.2
 * first — and the shape here is built so that adding it is a new branch, not
 * a rewrite. Until then the queue's job is: surface it, decide it, record who
 * decided and why, and stop it being silently forgotten.
 */
import { TRPCError } from '@trpc/server';
import {
  claimReviewInput,
  getReviewInput,
  listReviewsInput,
  resolveReviewInput,
  type ReviewStatus,
} from '@erp/contracts';
import { runIdempotent } from '../pipeline.js';
import { permissionProcedure, router } from '../trpc.js';

/** The states that still want a human. The default `list` filter. */
const NEEDS_A_HUMAN: readonly ReviewStatus[] = ['open', 'claimed'];
/** Terminal states: a resolution is a fact, not a draft. */
const TERMINAL: readonly string[] = ['resolved', 'auto_resolved', 'expired'];

interface ReviewRow {
  id: string;
  conflict_class: string;
  severity: number;
  entity_table: string;
  entity_id: string;
  field_path: string | null;
  ancestor_value: unknown;
  proposals: unknown;
  pending_state: string;
  pending_value: unknown;
  required_permission: string;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: unknown;
  opened_at: string;
  escalate_at: string;
  escalation_level: number;
  location_ids: string[];
}

/**
 * Timestamps cross as ISO-8601 STRINGS, formatted in SQL.
 *
 * §0 row 16 of `docs/phase1-status.md`: `receiving.get` returned a JS `Date`,
 * superjson annotated it, and the PWA — which validates against the contract —
 * refused to decode a reply the server thought was a 200. Every suite was
 * green. Nothing in this file returns a `Date`.
 */
const SELECT = `
  select cr.id, cr.conflict_class, cr.severity, cr.entity_table, cr.entity_id,
         cr.field_path, cr.ancestor_value, cr.proposals, cr.pending_state,
         cr.pending_value, cr.required_permission, cr.status,
         cr.claimed_by,
         to_char(cr.claimed_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as claimed_at,
         cr.resolved_by,
         to_char(cr.resolved_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as resolved_at,
         cr.resolution,
         to_char(cr.opened_at    at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as opened_at,
         to_char(cr.escalate_at  at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as escalate_at,
         cr.escalation_level,
         coalesce(array(select crl.location_id
                          from app.conflict_review_location crl
                         where crl.review_id = cr.id and crl.deleted_at is null
                         order by crl.location_id), '{}') as location_ids
    from app.conflict_review cr
`;

function toReview(r: ReviewRow) {
  return {
    reviewId: r.id,
    conflictClass: r.conflict_class,
    severity: r.severity,
    entityTable: r.entity_table,
    entityId: r.entity_id,
    fieldPath: r.field_path,
    ancestorValue: r.ancestor_value ?? null,
    proposals: r.proposals,
    pendingState: r.pending_state,
    pendingValue: r.pending_value,
    requiredPermission: r.required_permission,
    status: r.status,
    claimedBy: r.claimed_by,
    claimedAt: r.claimed_at,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    resolution: r.resolution ?? null,
    openedAt: r.opened_at,
    escalateAt: r.escalate_at,
    escalationLevel: r.escalation_level,
    locationIds: r.location_ids,
  };
}

/**
 * Condition 2 above, as a function. Returns false — never throws — so `list`
 * can count what it hid instead of failing the whole page over one row.
 *
 * An unknown `required_permission` denies: `holdsAt` is false for any code
 * outside `platform.permission`, and a text column with no FK is exactly the
 * place a typo turns into an unguarded row.
 */
function mayAct(
  permissions: { holdsAt(code: string, locationId: string): boolean },
  row: Pick<ReviewRow, 'required_permission' | 'location_ids'>,
): boolean {
  return row.location_ids.some((locationId) =>
    permissions.holdsAt(row.required_permission, locationId),
  );
}

export const reviewRouter = router({
  /**
   * The queue, narrowed to what this caller may actually act on.
   *
   * `hiddenCount` reports rows that matched the filters and were withheld by
   * condition 2. It exists so that "my queue is empty" and "there are items
   * nobody at my level may touch" are different sentences — the second is an
   * administration problem and reads as the first without this number.
   */
  list: permissionProcedure({ code: 'sync.conflict.review', at: 'any' })
    .input(listReviewsInput)
    .query(async ({ ctx, input }) => {
      const statuses = input.statuses ?? NEEDS_A_HUMAN;
      const gate = ctx.permissions.locationsFor('sync.conflict.review');
      if (gate.length === 0) {
        // The procedure guard proved the capability is held somewhere; this
        // is belt and braces against a grant that resolves to no location.
        return { reviewCount: 0, hiddenCount: 0, reviews: [] };
      }

      const rows = await ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<ReviewRow>(
          `${SELECT}
            where cr.deleted_at is null
              and cr.status = any($1::text[])
              and ($2::int is null or cr.severity <= $2::int)
              and ($3::text is null or cr.conflict_class = $3::text)
              and exists (
                select 1 from app.conflict_review_location crl
                 where crl.review_id = cr.id and crl.deleted_at is null
                   and crl.location_id = any($4::uuid[])
                   and ($5::uuid[] is null or crl.location_id = any($5::uuid[]))
              )
            order by cr.severity, cr.opened_at
            limit $6`,
          [
            [...statuses],
            input.maxSeverity ?? null,
            input.conflictClass ?? null,
            [...gate],
            input.locationIds ? [...input.locationIds] : null,
            input.limit ?? 200,
          ],
        );
        return res.rows;
      });

      const visible = rows.filter((r) => mayAct(ctx.permissions, r));
      return {
        reviewCount: visible.length,
        hiddenCount: rows.length - visible.length,
        reviews: visible.map(toReview),
      };
    }),

  get: permissionProcedure({ code: 'sync.conflict.review', at: 'any' })
    .input(getReviewInput)
    .query(async ({ ctx, input }) => {
      const row = await ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const res = await tx.query<ReviewRow>(
          `${SELECT} where cr.id = $1 and cr.deleted_at is null`,
          [input.reviewId],
        );
        return res.rows[0];
      });
      // A review belonging to another tenant does not resolve at all: RLS
      // scopes the read, so guessing a uuid gets NOT_FOUND, never a row.
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such review' });
      if (!mayAct(ctx.permissions, row)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            `PERMISSION_DENIED: this review is routed to ${row.required_permission} at the ` +
            `location it concerns, and this user does not hold it there`,
        });
      }
      return toReview(row);
    }),

  /**
   * Claim a row, or hand it back with `release: true`.
   *
   * Advisory and reversible. It is NOT a lock and it grants nothing:
   * `resolve` re-checks authority for itself, because a claim that conferred
   * the right to resolve would be a permission the client awarded itself.
   */
  claim: permissionProcedure({ code: 'sync.conflict.review', at: 'any' })
    .input(claimReviewInput)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.permissions.userId;
      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'review.claim',
          idempotencyKey: input.idempotencyKey,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
        },
        input,
        async (tx) => {
          const found = await tx.query<ReviewRow>(
            `${SELECT} where cr.id = $1 and cr.deleted_at is null for update of cr`,
            [input.reviewId],
          );
          const row = found.rows[0];
          if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such review' });
          if (!mayAct(ctx.permissions, row)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: `PERMISSION_DENIED: ${row.required_permission} is not held at this review's location`,
            });
          }
          if (TERMINAL.includes(row.status)) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `this review is already ${row.status} and cannot be claimed`,
            });
          }
          const release = input.release === true;
          if (release && row.claimed_by !== null && row.claimed_by !== userId) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'this review is claimed by another reviewer; only they can release it',
            });
          }
          if (!release && row.claimed_by !== null && row.claimed_by !== userId) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'this review is already claimed by another reviewer',
            });
          }

          const response = {
            reviewId: row.id,
            status: release ? 'open' : 'claimed',
            claimedBy: release ? null : userId,
          };
          return {
            response,
            apply: async (atx) => {
              await atx.query(
                `update app.conflict_review
                    set status = $2, claimed_by = $3,
                        claimed_at = case when $3::uuid is null then null
                                          else transaction_timestamp() end,
                        updated_at = transaction_timestamp()
                  where id = $1`,
                [row.id, release ? 'open' : 'claimed', release ? null : userId],
              );
            },
          };
        },
      );
      return result.response;
    }),

  /**
   * Record the human decision. This is the row leaving the queue.
   *
   * `note` is required by the contract and never defaulted: a resolution with
   * no reason is a rubber stamp, and this is the record a Phase 3 accountant
   * reads when a receipt number is missing from a sequence.
   */
  resolve: permissionProcedure({ code: 'sync.conflict.review', at: 'any' })
    .input(resolveReviewInput)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.permissions.userId;
      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'review.resolve',
          idempotencyKey: input.idempotencyKey,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
        },
        input,
        async (tx) => {
          const found = await tx.query<ReviewRow>(
            `${SELECT} where cr.id = $1 and cr.deleted_at is null for update of cr`,
            [input.reviewId],
          );
          const row = found.rows[0];
          if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such review' });
          if (!mayAct(ctx.permissions, row)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: `PERMISSION_DENIED: ${row.required_permission} is not held at this review's location`,
            });
          }
          if (TERMINAL.includes(row.status)) {
            // Not an idempotent success: a second, DIFFERENT decision on a
            // decided row must not look like it was accepted. A true retry of
            // the same request replays out of the write log above and never
            // reaches here.
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `this review is already ${row.status}; it cannot be resolved twice`,
            });
          }
          if (row.claimed_by !== null && row.claimed_by !== userId) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'this review is claimed by another reviewer; ask them to release it first',
            });
          }
          if (input.choice === 'accept_proposal') {
            // The key must name a proposal that is actually on the row.
            // Recording a choice nobody made is worse than refusing.
            const proposals = row.proposals;
            const keys = Array.isArray(proposals)
              ? proposals.map((p, i) =>
                  typeof p === 'object' && p !== null && 'party' in p
                    ? String((p as { party: unknown }).party)
                    : String(i),
                )
              : typeof proposals === 'object' && proposals !== null
                ? Object.keys(proposals)
                : [];
            if (!keys.includes(input.proposalKey!)) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `proposal "${input.proposalKey}" is not one of this review's proposals (${keys.join(', ')})`,
              });
            }
          }

          const resolution = {
            choice: input.choice,
            ...(input.proposalKey === undefined ? {} : { proposalKey: input.proposalKey }),
            ...(input.value === undefined ? {} : { value: input.value }),
            note: input.note,
          };
          const response = {
            reviewId: row.id,
            status: 'resolved' as const,
            resolvedBy: userId,
            choice: input.choice,
            /**
             * Stated on every resolution so no caller can mistake this for a
             * write-back. See the file header: the decision is recorded, the
             * conflicted entity is not rewritten.
             */
            entityRewritten: false,
          };
          return {
            response,
            apply: async (atx) => {
              await atx.query(
                `update app.conflict_review
                    set status = 'resolved', resolved_by = $2,
                        resolved_at = transaction_timestamp(),
                        resolution = $3::jsonb,
                        updated_at = transaction_timestamp()
                  where id = $1`,
                [row.id, userId, JSON.stringify(resolution)],
              );
            },
          };
        },
      );
      return result.response;
    }),
});
