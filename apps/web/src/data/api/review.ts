/**
 * The human review queue, from the client side.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONLINE ONLY, AND REFUSED OUT LOUD RATHER THAN QUEUED
 * ═══════════════════════════════════════════════════════════════════════════
 * None of this is in `DEVICE_OP_KINDS` and none of it may be put there.
 * Resolving a conflict is a decision about which of two divergent facts is
 * true, and the row exists precisely BECAUSE a partitioned device could not
 * make that call. A device working a stale queue would decide rows another
 * device has already decided, against a `pending_value` that has since moved.
 *
 * That makes this the same class as `logistics.planDelivery` and a supplier's
 * terms — a commitment measured against state only the server holds — and the
 * opposite of a sale or a stock adjustment, which ride the ordered outbox.
 * Nothing is queued when a call here fails, so a screen showing the refusal is
 * showing the whole truth.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A RESOLUTION IS
 * ═══════════════════════════════════════════════════════════════════════════
 * A recorded human decision — who, what and why. It does NOT write the decided
 * value back onto the conflicted row, and the server says so on every reply
 * (`entityRewritten: false`). Any screen that implies otherwise is lying to
 * the person clicking it.
 *
 * `proposals`, `pendingValue` and `ancestorValue` cross as OPAQUE JSON and are
 * kept opaque here. Every monetary or quantity value inside them is a decimal
 * STRING (03 §3.6.2, ADR-0004) and must be rendered as given: parsing one into
 * a JS number would make it a float64 on a path where a human reads a figure
 * and re-enters it, which is the one place ADR-0004 says never to do it.
 */
import {
  claimReviewInput,
  getReviewInput,
  listReviewsInput,
  resolveReviewInput,
  REVIEW_CHOICES,
  REVIEW_STATUSES,
  type ClaimReviewInput,
  type ListReviewsInput,
  type ResolveReviewInput,
  type ReviewChoice,
  type ReviewStatus,
} from '@erp/contracts';
import {
  apiMutate,
  apiQuery,
  asArray,
  asBoolean,
  asCount,
  asOptionalString,
  asRecord,
  asString,
  type ApiCallOptions,
  type ApiResult,
} from './client';
import { guard } from './guard';

export interface Review {
  readonly reviewId: string;
  /** Tenant/platform conflict class, e.g. RECEIPT_NUMBER_COLLISION. */
  readonly conflictClass: string;
  /** 1 blocking .. 4 informational. */
  readonly severity: number;
  readonly entityTable: string;
  readonly entityId: string;
  readonly fieldPath: string | null;
  /** Opaque JSON — money inside is a decimal STRING. Never parsed here. */
  readonly ancestorValue: unknown;
  readonly proposals: unknown;
  readonly pendingState: string;
  readonly pendingValue: unknown;
  readonly requiredPermission: string;
  readonly status: string;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolution: unknown;
  readonly openedAt: string;
  readonly escalateAt: string;
  readonly escalationLevel: number;
  readonly locationIds: readonly string[];
}

export interface ReviewList {
  readonly reviewCount: number;
  /**
   * Rows that matched the filter and were withheld because this user does not
   * hold the row's own `required_permission` at the location it concerns.
   *
   * Rendered, never swallowed. "My queue is empty" and "there are items nobody
   * at my level may touch" are different sentences, and the second reads as
   * the first without this number — which is how a queue silently stops being
   * worked.
   */
  readonly hiddenCount: number;
  readonly reviews: readonly Review[];
}

export interface ClaimResult {
  readonly reviewId: string;
  readonly status: string;
  readonly claimedBy: string | null;
}

export interface ResolveResult {
  readonly reviewId: string;
  readonly status: string;
  readonly resolvedBy: string;
  readonly choice: string;
  /** Always false today. See the header — a decision is not a write-back. */
  readonly entityRewritten: boolean;
}

function mapReview(entry: unknown, what: string): Review {
  const row = asRecord(entry, what);
  return {
    reviewId: asString(row['reviewId'], `${what}.reviewId`),
    conflictClass: asString(row['conflictClass'], `${what}.conflictClass`),
    severity: asCount(row['severity'], `${what}.severity`),
    entityTable: asString(row['entityTable'], `${what}.entityTable`),
    entityId: asString(row['entityId'], `${what}.entityId`),
    fieldPath: asOptionalString(row['fieldPath'], `${what}.fieldPath`),
    ancestorValue: row['ancestorValue'] ?? null,
    proposals: row['proposals'] ?? null,
    pendingState: asString(row['pendingState'], `${what}.pendingState`),
    pendingValue: row['pendingValue'] ?? null,
    requiredPermission: asString(row['requiredPermission'], `${what}.requiredPermission`),
    status: asString(row['status'], `${what}.status`),
    claimedBy: asOptionalString(row['claimedBy'], `${what}.claimedBy`),
    // Timestamps are STRINGS on this wire. §0 row 16: `receiving.get` returned
    // a JS Date, superjson annotated it, and the client refused a reply the
    // server thought was a 200. `asOptionalString` is what catches a
    // regression here rather than rendering "[object Object]".
    claimedAt: asOptionalString(row['claimedAt'], `${what}.claimedAt`),
    resolvedBy: asOptionalString(row['resolvedBy'], `${what}.resolvedBy`),
    resolvedAt: asOptionalString(row['resolvedAt'], `${what}.resolvedAt`),
    resolution: row['resolution'] ?? null,
    openedAt: asString(row['openedAt'], `${what}.openedAt`),
    escalateAt: asString(row['escalateAt'], `${what}.escalateAt`),
    escalationLevel: asCount(row['escalationLevel'], `${what}.escalationLevel`),
    locationIds: asArray(row['locationIds'], `${what}.locationIds`).map((l, i) =>
      asString(l, `${what}.locationIds[${i}]`),
    ),
  };
}

function mapReviewList(json: unknown): ReviewList {
  const root = asRecord(json, 'review.list');
  return {
    reviewCount: asCount(root['reviewCount'], 'reviewCount'),
    hiddenCount: asCount(root['hiddenCount'], 'hiddenCount'),
    reviews: asArray(root['reviews'], 'reviews').map((r, i) =>
      mapReview(r, `review.list.reviews[${i}]`),
    ),
  };
}

export function fetchReviews(
  input: ListReviewsInput = {},
  options: ApiCallOptions = {},
): Promise<ApiResult<ReviewList>> {
  const bad = guard(listReviewsInput, 'review.list', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('review.list', input, mapReviewList, options);
}

export function fetchReview(
  reviewId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<Review>> {
  const input = { reviewId };
  const bad = guard(getReviewInput, 'review.get', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('review.get', input, (json) => mapReview(json, 'review.get'), options);
}

/**
 * Take a row, or hand it back with `release: true`.
 *
 * Advisory: it stops two people working the same conflict, and it confers no
 * authority whatsoever. The server re-checks the capability on `resolveReview`
 * for itself — a claim that granted the right to resolve would be a permission
 * the client had awarded itself.
 */
export function claimReview(
  input: ClaimReviewInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<ClaimResult>> {
  const bad = guard(claimReviewInput, 'review.claim', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate(
    'review.claim',
    input,
    (json) => {
      const row = asRecord(json, 'review.claim');
      return {
        reviewId: asString(row['reviewId'], 'review.claim.reviewId'),
        status: asString(row['status'], 'review.claim.status'),
        claimedBy: asOptionalString(row['claimedBy'], 'review.claim.claimedBy'),
      };
    },
    options,
  );
}

export function resolveReview(
  input: ResolveReviewInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<ResolveResult>> {
  const bad = guard(resolveReviewInput, 'review.resolve', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate(
    'review.resolve',
    input,
    (json) => {
      const row = asRecord(json, 'review.resolve');
      return {
        reviewId: asString(row['reviewId'], 'review.resolve.reviewId'),
        status: asString(row['status'], 'review.resolve.status'),
        resolvedBy: asString(row['resolvedBy'], 'review.resolve.resolvedBy'),
        choice: asString(row['choice'], 'review.resolve.choice'),
        entityRewritten: asBoolean(row['entityRewritten'], 'review.resolve.entityRewritten'),
      };
    },
    options,
  );
}

export { REVIEW_CHOICES, REVIEW_STATUSES };
export type { ReviewChoice, ReviewStatus };
