/**
 * THE HUMAN REVIEW QUEUE — the contract for working it.
 *
 * CLAUDE.md §2.2: "Every conflict that cannot be resolved automatically goes
 * to a human review queue. Never silently overwritten." Migration 0006 built
 * the queue and three writers fill it — a receipt-number regression
 * (`sequence.ts`), a goods-received quantity outside the unit's tolerance
 * (`receiving.ts`), and a receipt collision on the sale path (`sales.ts`).
 *
 * Nothing could ever take a row OUT. The Phase 2 gate found six rows on the
 * live database, every one of them `open`, none ever claimed or resolved:
 * "a review queue nobody works is silent overwriting with extra steps", which
 * is the sentence migration 0006 opens with. This contract is the other half.
 *
 * WHY THERE IS NO OFFLINE PATH HERE. Resolving a conflict is a decision about
 * which of two divergent facts is true, and the whole reason the row exists is
 * that a partitioned device could not make that call. A device holding a
 * stale queue could resolve a review another device already resolved, or
 * resolve it against a `pending_value` that has since moved. Reviews are
 * therefore read and written online, like a supplier's terms and unlike a
 * sale — the same rule Phase 2 applied to commitments (`docs/phase2-status.md`
 * §5). The refusal is loud rather than silent.
 */
import { z } from 'zod';
import { mutationEnvelope, zUuid } from './wire.js';

/**
 * Queue states. Platform vocabulary matching migration 0006's CHECK — not a
 * tenant's word for anything, so a closed enum is correct here (§2.9).
 */
export const REVIEW_STATUSES = [
  'open',
  'claimed',
  'resolved',
  'auto_resolved',
  'expired',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** What a reviewer decided. `note` is required on every one of them. */
export const REVIEW_CHOICES = [
  /** The pending value stands; the competing proposal is rejected. */
  'keep_pending',
  /** A named proposal wins and is recorded as the agreed value. */
  'accept_proposal',
  /** Neither: the reviewer states the value themselves. */
  'enter_value',
  /** Nothing to decide — opened in error, or already handled elsewhere. */
  'no_action',
] as const;
export type ReviewChoice = (typeof REVIEW_CHOICES)[number];

export const listReviewsInput = z
  .object({
    /** Defaults to the states that still need a human: open and claimed. */
    statuses: z.array(z.enum(REVIEW_STATUSES)).min(1).optional(),
    /** Narrow to one or more locations inside the caller's own scope. */
    locationIds: z.array(zUuid).min(1).optional(),
    /** 1 blocking .. 4 informational. Omitted means every severity. */
    maxSeverity: z.number().int().min(1).max(4).optional(),
    conflictClass: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type ListReviewsInput = z.infer<typeof listReviewsInput>;

export const getReviewInput = z.object({ reviewId: zUuid }).strict();
export type GetReviewInput = z.infer<typeof getReviewInput>;

/**
 * Claiming is how two people at two outlets do not both work the same row.
 * It is advisory and reversible — `release: true` hands it back — and it is
 * NOT a lock: `resolveReview` re-checks authority for itself, because a claim
 * that granted authority would be a permission a client could award itself.
 */
export const claimReviewInput = z
  .object({
    ...mutationEnvelope,
    reviewId: zUuid,
    release: z.boolean().optional(),
  })
  .strict();
export type ClaimReviewInput = z.infer<typeof claimReviewInput>;
export type ClaimReviewParsed = z.output<typeof claimReviewInput>;

export const resolveReviewInput = z
  .object({
    ...mutationEnvelope,
    reviewId: zUuid,
    choice: z.enum(REVIEW_CHOICES),
    /**
     * Which party's proposal won, when `choice` is `accept_proposal`. A key
     * into the row's own `proposals` object — the server checks it is there
     * and refuses if it is not, rather than recording a choice nobody made.
     */
    proposalKey: z.string().min(1).max(128).optional(),
    /**
     * The value the reviewer states, when `choice` is `enter_value`. Money and
     * quantity inside it are decimal STRINGS, never JSON numbers (ADR-0004) —
     * this is a path where a human reads a figure and re-enters it.
     */
    value: z.record(z.string(), z.unknown()).optional(),
    /**
     * Why. Required, and never defaulted: a resolution with no reason is how a
     * queue becomes a rubber stamp, and this is the audit record a Phase 3
     * accountant reads when a receipt number is missing from a sequence.
     */
    note: z.string().min(3).max(2000),
  })
  .strict()
  .refine((v) => v.choice !== 'accept_proposal' || v.proposalKey !== undefined, {
    message: 'accept_proposal requires proposalKey',
    path: ['proposalKey'],
  })
  .refine((v) => v.choice !== 'enter_value' || v.value !== undefined, {
    message: 'enter_value requires value',
    path: ['value'],
  });
export type ResolveReviewInput = z.input<typeof resolveReviewInput>;
export type ResolveReviewParsed = z.output<typeof resolveReviewInput>;
