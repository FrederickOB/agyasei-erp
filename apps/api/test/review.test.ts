/**
 * THE HUMAN REVIEW QUEUE, WORKED — CLAUDE.md §2.2's second half.
 *
 * Migration 0006 built the queue and three writers filled it. Nothing could
 * take a row out: no router, no client, no screen, no resolver. The Phase 2
 * gate found six rows on the live database, every one `open`, none ever
 * claimed or resolved — a queue nobody works, which migration 0006's own
 * header calls "silent overwriting with extra steps".
 *
 * These tests do not insert review rows. Every review here is opened by the
 * REAL writer — a device that loses its local database and re-reports, which
 * is conflict class #14 — so what is under test is the whole loop: a genuine
 * conflict is detected, reaches a queue, is seen by exactly the people who may
 * see it, is claimed, and leaves the queue with a reason attached.
 *
 * Same standards as `sales-rbac.test.ts`: real Postgres with the real
 * migrations as `app_user` so RLS applies, the real router for every
 * assertion, and a positive control beside every refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import type { VerifiedIdentity } from '../src/auth.js';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantA: string;
let tenantB: string;
let outletA: string;
let rootA: string;
/**
 * Opens the reviews. Deliberately NOT one of the template principals: issuing
 * a receipt block is guarded by `sale.record`, and the person who trips a
 * conflict is nothing to do with the person who may work the queue. Using a
 * reviewer here would couple the fixture to a grant this file is not testing.
 */
let openerA: Caller;

type Caller = ReturnType<ApiHarness['callerFor']>;
const principals = new Map<string, { identity: VerifiedIdentity; caller: Caller }>();

function p(ref: string) {
  const found = principals.get(ref);
  if (!found) throw new Error(`no principal ${ref}`);
  return found;
}

/**
 * Open one REAL review: allocate a receipt block, report consumption, then
 * report as a device whose local database was wiped. The server still shows
 * the block live, and that mismatch is the detection (03 §3.7.5, class #14).
 */
async function openRealReview(caller: Caller, locationId: string): Promise<string> {
  const first = await caller.sequence.syncBlock({
    idempotencyKey: uuidv7(),
    locationId,
    sequenceKey: 'RECEIPT',
    report: null,
    wantBlock: true,
  });
  const block = first.block;
  if (!block) throw new Error('no block issued');

  await caller.sequence.syncBlock({
    idempotencyKey: uuidv7(),
    locationId,
    sequenceKey: 'RECEIPT',
    report: {
      blockStart: block.blockStart,
      consumedUpto: (BigInt(block.blockStart) + 5n).toString(10),
    },
    wantBlock: false,
  });

  // The wipe: the device holds nothing and says so, while the server's block
  // is live and consumed up to +5. Numbers were printed that this device can
  // no longer account for.
  const regressed = await caller.sequence.syncBlock({
    idempotencyKey: uuidv7(),
    locationId,
    sequenceKey: 'RECEIPT',
    report: { blockStart: block.blockStart, consumedUpto: null },
    wantBlock: true,
  });
  const review = regressed.review;
  if (!review) throw new Error('the writer opened no review — the fixture is not exercising #14');
  return review.id;
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('review-a');
  await h.applyTemplate(tenantA, true);
  rootA = await h.locationByCode(tenantA, 'ROOT');
  outletA = (await h.outlets(tenantA, 1))[0]!.id;

  tenantB = await h.provisionTenant('review-b');
  await h.applyTemplate(tenantB, true);

  openerA = h.callerFor(await h.identityFor(tenantA, { locs: [rootA, outletA] }));

  for (const ref of ['counter_staff', 'outlet_manager', 'regional_manager', 'accounts'] as const) {
    const identity = await h.principal(tenantA, {
      roleRef: ref,
      // Root scope: this file is about who may WORK the queue, and a scope
      // that excluded the outlet would refuse for the wrong reason.
      scopeLocationId: rootA,
    });
    principals.set(ref, { identity, caller: h.callerFor(identity) });
  }
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('the template routes this queue by capability, not by job title', () => {
  it('regional manager and accounts hold sync.conflict.review; the counter does not', async () => {
    const rows = await h.db.withTenant(tenantA, async (tx) => {
      const r = await tx.query<{ origin_ref: string }>(
        `select r.origin_ref
           from app.role_permission rp
           join app.role r on r.id = rp.role_id
          where rp.permission_code = 'sync.conflict.review'
            and rp.deleted_at is null and r.deleted_at is null and not r.is_owner`,
        [],
      );
      return r.rows.map((x) => x.origin_ref);
    });
    expect(rows).toContain('role:regional_manager');
    expect(rows).toContain('role:accounts');
    expect(rows).not.toContain('role:counter_staff');
    expect(rows).not.toContain('role:outlet_manager');
  });
});

describe('a real conflict reaches the queue and can be seen', () => {
  let reviewId: string;

  beforeAll(async () => {
    reviewId = await openRealReview(openerA, outletA);
  }, 60_000);

  it('the writer opened a SEVERITY-1 review, and the queue can now read it', async () => {
    const list = await p('regional_manager').caller.review.list({});
    expect(list.reviewCount).toBeGreaterThan(0);
    const found = list.reviews.find((r) => r.reviewId === reviewId);
    expect(found).toBeDefined();
    expect(found!.severity).toBe(1);
    expect(found!.status).toBe('open');
    expect(found!.requiredPermission).toBe('sync.conflict.review');
    expect(found!.locationIds).toContain(outletA);
  });

  it('every timestamp crosses as a STRING — never a Date (§0 row 16)', async () => {
    const one = await p('regional_manager').caller.review.get({ reviewId });
    expect(typeof one.openedAt).toBe('string');
    expect(typeof one.escalateAt).toBe('string');
    expect(one.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(one.claimedAt).toBeNull();
  });

  it('a counter clerk cannot open the queue at all', async () => {
    await expect(p('counter_staff').caller.review.list({})).rejects.toThrow(
      /FORBIDDEN|PERMISSION_DENIED|sync\.conflict\.review/,
    );
  });

  it('…nor read one by id, even knowing the id — the positive control is above', async () => {
    await expect(p('counter_staff').caller.review.get({ reviewId })).rejects.toThrow(
      /FORBIDDEN|PERMISSION_DENIED/,
    );
  });

  it('the proposals name both parties, and money inside them is a STRING', async () => {
    const one = await p('accounts').caller.review.get({ reviewId });
    const proposals = one.proposals as { party: string; consumedUpto: string | null }[];
    expect(Array.isArray(proposals)).toBe(true);
    expect(proposals.length).toBeGreaterThanOrEqual(2);
    for (const proposal of proposals) {
      if (proposal.consumedUpto !== null && proposal.consumedUpto !== undefined) {
        expect(typeof proposal.consumedUpto).toBe('string');
      }
    }
  });
});

describe('claiming: two reviewers do not both work the same row', () => {
  let reviewId: string;

  beforeAll(async () => {
    reviewId = await openRealReview(openerA, outletA);
  }, 60_000);

  it('a reviewer claims it, and the row says who holds it', async () => {
    const res = await p('regional_manager').caller.review.claim({
      idempotencyKey: uuidv7(),
      reviewId,
    });
    expect(res.status).toBe('claimed');
    expect(res.claimedBy).toBe(p('regional_manager').identity.userId);

    const one = await p('accounts').caller.review.get({ reviewId });
    expect(one.status).toBe('claimed');
    expect(typeof one.claimedAt).toBe('string');
  });

  it('a SECOND reviewer is refused — the claim is what stops duplicated work', async () => {
    await expect(
      p('accounts').caller.review.claim({ idempotencyKey: uuidv7(), reviewId }),
    ).rejects.toThrow(/already claimed/);
  });

  it('…and cannot resolve it out from under them either', async () => {
    await expect(
      p('accounts').caller.review.resolve({
        idempotencyKey: uuidv7(),
        reviewId,
        choice: 'no_action',
        note: 'trying to resolve a row somebody else is holding',
      }),
    ).rejects.toThrow(/claimed by another reviewer/);
  });

  it('only the holder may release it, and then anyone eligible may take it', async () => {
    await expect(
      p('accounts').caller.review.claim({ idempotencyKey: uuidv7(), reviewId, release: true }),
    ).rejects.toThrow(/only they can release/);

    const released = await p('regional_manager').caller.review.claim({
      idempotencyKey: uuidv7(),
      reviewId,
      release: true,
    });
    expect(released.status).toBe('open');
    expect(released.claimedBy).toBeNull();

    const retaken = await p('accounts').caller.review.claim({
      idempotencyKey: uuidv7(),
      reviewId,
    });
    expect(retaken.claimedBy).toBe(p('accounts').identity.userId);
  });
});

describe('resolving: the row leaves the queue, with a reason attached', () => {
  let reviewId: string;

  beforeAll(async () => {
    reviewId = await openRealReview(openerA, outletA);
  }, 60_000);

  it('a resolution needs a reason — the contract refuses an empty one', async () => {
    await expect(
      p('accounts').caller.review.resolve({
        idempotencyKey: uuidv7(),
        reviewId,
        choice: 'no_action',
        note: '',
      }),
    ).rejects.toThrow();
  });

  it('accept_proposal must name a proposal the row actually carries', async () => {
    await expect(
      p('accounts').caller.review.resolve({
        idempotencyKey: uuidv7(),
        reviewId,
        choice: 'accept_proposal',
        proposalKey: 'a-party-that-never-proposed-anything',
        note: 'this key is not on the row',
      }),
    ).rejects.toThrow(/is not one of this review's proposals/);
  });

  it('resolves, records who and why, and says it did NOT rewrite the entity', async () => {
    const res = await p('accounts').caller.review.resolve({
      idempotencyKey: uuidv7(),
      reviewId,
      choice: 'keep_pending',
      note: 'block burned and reissued; the printed numbers stand and the gap is documented',
    });
    expect(res.status).toBe('resolved');
    expect(res.resolvedBy).toBe(p('accounts').identity.userId);
    expect(res.entityRewritten).toBe(false);

    const one = await p('accounts').caller.review.get({ reviewId });
    expect(one.status).toBe('resolved');
    expect(typeof one.resolvedAt).toBe('string');
    expect((one.resolution as { note: string }).note).toMatch(/block burned and reissued/);
  });

  it('and it is GONE from the queue that still wants a human', async () => {
    const list = await p('accounts').caller.review.list({});
    expect(list.reviews.map((r) => r.reviewId)).not.toContain(reviewId);

    // …but is still readable when asked for by state. A resolution is a
    // record, not a deletion: `conflict_review_deleted_never` is a CHECK.
    const resolved = await p('accounts').caller.review.list({ statuses: ['resolved'] });
    expect(resolved.reviews.map((r) => r.reviewId)).toContain(reviewId);
  });

  it('a SECOND, different decision on a decided row is refused, not silently applied', async () => {
    await expect(
      p('accounts').caller.review.resolve({
        idempotencyKey: uuidv7(),
        reviewId,
        choice: 'no_action',
        note: 'changing my mind after the fact',
      }),
    ).rejects.toThrow(/already resolved/);
  });

  it('a true retry — the same key and the same body — replays instead', async () => {
    const key = uuidv7();
    const other = await openRealReview(openerA, outletA);
    const body = {
      idempotencyKey: key,
      reviewId: other,
      choice: 'no_action' as const,
      note: 'opened in error during the migration rehearsal',
    };
    const first = await p('accounts').caller.review.resolve(body);
    const replay = await p('accounts').caller.review.resolve(body);
    expect(replay).toEqual(first);
  });
});

describe('tenant isolation — the third mandatory category (§2.7)', () => {
  it('tenant B sees none of tenant A’s reviews, and cannot fetch one by id', async () => {
    const reviewId = await openRealReview(openerA, outletA);

    const rootB = await h.locationByCode(tenantB, 'ROOT');
    const bIdentity = await h.principal(tenantB, { roleRef: 'accounts', scopeLocationId: rootB });
    const bCaller = h.callerFor(bIdentity);

    // Positive control FIRST: tenant B's own queue answers, so an empty
    // result below is isolation and not a broken caller.
    const ownQueue = await bCaller.review.list({ statuses: ['open', 'claimed', 'resolved'] });
    expect(ownQueue.reviewCount).toBe(0);

    const outletB = (await h.outlets(tenantB, 1))[0]!.id;
    const openerB = h.callerFor(await h.identityFor(tenantB, { locs: [rootB, outletB] }));
    const ownReview = await openRealReview(openerB, outletB);
    const nowOwn = await bCaller.review.list({});
    expect(nowOwn.reviews.map((r) => r.reviewId)).toContain(ownReview);
    expect(nowOwn.reviews.map((r) => r.reviewId)).not.toContain(reviewId);

    // Naming tenant A's review by its real uuid finds nothing at all — RLS
    // scopes the read, so this is NOT_FOUND rather than FORBIDDEN.
    await expect(bCaller.review.get({ reviewId })).rejects.toThrow(/no such review/);
    await expect(
      bCaller.review.claim({ idempotencyKey: uuidv7(), reviewId }),
    ).rejects.toThrow(/no such review/);
  }, 60_000);
});
