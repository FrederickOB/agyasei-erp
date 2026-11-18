/**
 * `reconcileTenders` and the capability maps — pure, so tested exhaustively
 * (CLAUDE.md §2.7 category 1). The rule puts a device's split onto the
 * server's total; these properties are what make it safe to run unattended:
 *
 *   1. the stored amounts ALWAYS sum to the server's total (the 0022 identity);
 *   2. no stored amount is ever negative;
 *   3. nothing moves when the claims already agree (no review is raised);
 *   4. a BALANCE line absorbs the remainder without moving a stated claim;
 *   5. on account absorbs first, then drawer cash, then the rest.
 *
 * Randomised with the repo's own seeded PRNG (`makeRng`, as
 * money-property.test.ts does), so a failure reproduces from its seed.
 */
import { describe, expect, it } from 'vitest';
import type { SettlementRole } from '@erp/db';
import {
  reconcileTenders,
  ROLE_SETTLEMENT,
  salePermission,
  SETTLEMENT_PERMISSION,
  type TenderClaim,
} from '../src/tender.js';
import { makeRng } from './util.js';

const ROLES: readonly SettlementRole[] = ['TILL_CASH', 'MOMO_WALLET', 'BANK', 'AR_TRADE'];
const claim = (seq: number, role: SettlementRole, claimedMinor: bigint | null): TenderClaim => ({
  seq, methodId: `m${String(seq)}`, role, claimedMinor,
});

/** A bigint in [0, max], from the seeded PRNG — never through a float product of the magnitude. */
function bigBelow(rng: () => number, max: bigint): bigint {
  // Two 26-bit draws composed in bigint: uniform enough, and exact.
  const hi = BigInt(Math.floor(rng() * 2 ** 26));
  const lo = BigInt(Math.floor(rng() * 2 ** 26));
  return ((hi << 26n) | lo) % (max + 1n);
}

function randomClaims(rng: () => number): TenderClaim[] {
  const n = 1 + Math.floor(rng() * 5);
  const balanceAt = rng() < 0.5 ? Math.floor(rng() * n) : -1;
  return Array.from({ length: n }, (_, i) =>
    claim(i + 1, ROLES[Math.floor(rng() * ROLES.length)]!, i === balanceAt ? null : bigBelow(rng, 5_000_000n)),
  );
}

describe('reconcileTenders — the properties', () => {
  it('stored amounts sum to the SERVER total, exactly, and none is negative — for every split and every total', () => {
    const rng = makeRng(20_027_001);
    for (let run = 0; run < 3_000; run += 1) {
      const claims = randomClaims(rng);
      const total = bigBelow(rng, 30_000_000n);
      const r = reconcileTenders(claims, total);
      const sum = r.lines.reduce((a, l) => a + l.amountMinor, 0n);
      expect(sum, `run ${run}`).toBe(total);
      expect(r.lines.every((l) => l.amountMinor >= 0n), `run ${run}`).toBe(true);
      expect(r.lines.map((l) => l.seq)).toEqual(claims.map((c) => c.seq));
    }
  });

  it('when the stated claims already sum to the total, nothing moves and the delta is zero', () => {
    const rng = makeRng(20_027_002);
    for (let run = 0; run < 1_000; run += 1) {
      const claims = randomClaims(rng).map((c) => ({ ...c, claimedMinor: c.claimedMinor ?? 0n }));
      const total = claims.reduce((a, c) => a + (c.claimedMinor ?? 0n), 0n);
      const r = reconcileTenders(claims, total);
      expect(r.deltaMinor).toBe(0n);
      expect(r.lines.every((l) => l.amountMinor === l.claimedMinor)).toBe(true);
    }
  });

  it('a BALANCE line takes the remainder and no stated claim moves, whenever the stated lines fit', () => {
    const rng = makeRng(20_027_003);
    for (let run = 0; run < 1_000; run += 1) {
      const stated = Array.from({ length: Math.floor(rng() * 4) }, () => bigBelow(rng, 2_000_000n));
      const headroom = bigBelow(rng, 2_000_000n);
      const claims = [
        ...stated.map((a, i) => claim(i + 1, 'MOMO_WALLET', a)),
        claim(stated.length + 1, ROLES[Math.floor(rng() * ROLES.length)]!, null),
      ];
      const total = stated.reduce((a, b) => a + b, 0n) + headroom;
      const r = reconcileTenders(claims, total);
      expect(r.deltaMinor).toBe(0n);
      expect(r.lines.slice(0, -1).every((l) => l.amountMinor === l.claimedMinor)).toBe(true);
      expect(r.lines.at(-1)!.amountMinor).toBe(headroom);
    }
  });
});

describe('reconcileTenders — the order a difference is absorbed in', () => {
  it('a server total HIGHER than the claims goes on account first', () => {
    const r = reconcileTenders([claim(1, 'TILL_CASH', 3_000n), claim(2, 'AR_TRADE', 1_000n)], 4_500n);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([3_000n, 1_500n]);
    expect(r.deltaMinor).toBe(500n);
  });

  it('with nothing on account, drawer cash absorbs before a momo line — a momo transaction is for an exact amount', () => {
    const r = reconcileTenders([claim(1, 'MOMO_WALLET', 5_000n), claim(2, 'TILL_CASH', 1_000n)], 5_800n);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([5_000n, 800n]);
  });

  it('a LOWER total is taken from lines in that order, each down to zero and never below', () => {
    const r = reconcileTenders(
      [claim(1, 'BANK', 4_000n), claim(2, 'TILL_CASH', 500n), claim(3, 'AR_TRADE', 300n)],
      3_900n,
    );
    // 900 to take: 300 from account (to 0), 500 from cash (to 0), 100 from the bank line.
    expect(r.lines.map((l) => l.amountMinor)).toEqual([3_900n, 0n, 0n]);
  });

  it('among the other instruments, the LARGER absorbs first, ties by line order', () => {
    const r = reconcileTenders([claim(1, 'BANK', 1_000n), claim(2, 'MOMO_WALLET', 2_000n)], 3_100n);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([1_000n, 2_100n]);
    const tie = reconcileTenders([claim(1, 'BANK', 1_000n), claim(2, 'MOMO_WALLET', 1_000n)], 2_100n);
    expect(tie.lines.map((l) => l.amountMinor)).toEqual([1_100n, 1_000n]);
  });

  it('refuses what it cannot represent rather than guessing', () => {
    expect(() => reconcileTenders([claim(1, 'TILL_CASH', 1n)], -1n)).toThrow(/negative/);
    expect(() => reconcileTenders([], 0n)).toThrow(/at least one tender/);
    expect(() => reconcileTenders([claim(1, 'TILL_CASH', null), claim(2, 'BANK', null)], 10n)).toThrow(/at most one/);
    expect(() => reconcileTenders([claim(1, 'TILL_CASH', -5n)], 10n)).toThrow(/negative/);
  });
});

describe('the capability maps are total and agree with each other', () => {
  it('every settlement role maps to a settlement, and every settlement to a catalogued capability', () => {
    for (const role of ROLES) expect(SETTLEMENT_PERMISSION[ROLE_SETTLEMENT[role]]).toMatch(/^sale\.record/);
    expect(ROLE_SETTLEMENT.AR_TRADE).toBe('ON_ACCOUNT');
    expect(ROLES.filter((r) => ROLE_SETTLEMENT[r] === 'ON_ACCOUNT')).toEqual(['AR_TRADE']);
  });

  it('salePermission reads the declared settlements and fails closed on anything else', () => {
    expect(salePermission({ tenders: [{ settlement: 'IMMEDIATE' }, { settlement: 'ON_ACCOUNT' }] })).toBe('sale.record');
    expect(salePermission({ tenders: [{ settlement: 'ON_ACCOUNT' }] })).toBe('sale.record.credit');
    expect(salePermission({ tenders: [{ settlement: 'IMMEDIATE' }, { settlement: 'LAYAWAY' }] })).toBeUndefined();
    expect(salePermission({ tenders: [] })).toBeUndefined();
  });
});
