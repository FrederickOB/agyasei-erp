/**
 * A TRIPWIRE, not a unit test: **nothing in `apps/web` may reduce credit entry
 * amounts to a total.**
 *
 * `docs/credit-offline-plan.md` R2 rules the balance and the ageing SYNCED AND
 * AUTHORITATIVE, and the reason is arithmetic rather than taste. The
 * `credit_entry` rows on a device are WINDOWED, so
 *
 *     Σ(local credit_entry rows)  ≠  balance
 *
 * by construction, and the gap grows with the age of the account. A device
 * that summed its own log would produce a confidently wrong number at exactly
 * the moment nobody can check it — the failure `CLAUDE.md` §2.2 and
 * `phase1-status` §0a both name.
 *
 * R2 also says why this file exists rather than a note in a review checklist:
 * *"a second implementation of a money function that nothing forbids will be
 * written."* The same reasoning produced
 * `packages/wire-conformance/test/outbox-surface.test.ts`, and this is that
 * shape applied to the credit read path.
 *
 * WHAT IS ALLOWED, so the rule is not mistaken for something broader:
 *  · summing the SYNCED AGEING BUCKETS — that is `checkAgreement`, the shared
 *    identity check the online path runs too, and its inputs are the server's
 *    own figures, not the device's log;
 *  · listing entries and rendering each amount on its own line.
 *
 * The scan looks for the two shapes a violation actually takes: SQL that
 * aggregates over `credit_entry`, and TypeScript in the credit read path that
 * folds `amountMinor` values together.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

/** SQL aggregates, in any casing, anywhere near the credit log. */
const AGGREGATES = ['sum(', 'total(', 'avg('];

describe('no device-side credit total', () => {
  it('has no SQL that aggregates over credit_entry', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const source = readFileSync(file, 'utf8');
      // Look statement by statement so an unrelated SUM() elsewhere in a file
      // that also mentions credit_entry does not produce a false finding.
      for (const statement of source.split(/;|`/)) {
        if (!/credit_entry/i.test(statement)) continue;
        const lowered = statement.toLowerCase();
        for (const aggregate of AGGREGATES) {
          if (lowered.includes(aggregate)) {
            offenders.push(`${path.relative(srcRoot, file)}: ${aggregate} over credit_entry`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('folds no credit entry amount into a running total in the read path', () => {
    // The credit read path is where such a helper would be written, and it is
    // small enough that a whole-file scan is exact rather than approximate.
    const file = path.join(srcRoot, 'data', 'queries', 'credit-position.ts');
    const source = readFileSync(file, 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    // `.reduce(`, `+=` and a bare `a + b` over amounts are the three ways a
    // total gets written by accident.
    expect(/\.reduce\s*\(/.test(code)).toBe(false);
    expect(/amountMinor\s*[+-]?=/.test(code)).toBe(false);
    expect(/\+\s*(?:m|e|entry|movement|line)\.amountMinor/.test(code)).toBe(false);
  });

  it('imports the SHARED identity check rather than re-deriving it', () => {
    // The one permitted arithmetic on this path is `checkAgreement`, and it is
    // permitted precisely because it is the ONLINE path's function. A local
    // copy of the identity would be the drift this rule exists to prevent.
    const source = readFileSync(
      path.join(srcRoot, 'data', 'queries', 'credit-position.ts'),
      'utf8',
    );
    expect(source.includes('checkAgreement')).toBe(true);
    expect(source.includes("from '../api/credit'")).toBe(true);
  });
});
