/**
 * THE ROUTE SWEEP — add a read path without a two-tenant test and this file
 * turns the suite red.
 *
 * The Phase 2 gate's complaint (docs/phase2-gate-evidence.md §4.4.1, §6
 * criterion 5): "Add a query today and nothing turns red." Isolation tests
 * written by hand, per endpoint, drift as endpoints are added; this file does
 * not depend on anybody remembering. It enumerates EVERY query procedure
 * mounted on `appRouter` at runtime (so a new router, or a new query on an old
 * one, is in scope the moment it is mounted) and requires each one to have a
 * registered two-tenant isolation test.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * HOW TO REGISTER A READ PATH — for whoever adds the next query procedure
 * ═════════════════════════════════════════════════════════════════════════
 * Start the title of the test that proves it with the tag
 *
 *     [isolation:<router>.<procedure>]       e.g.  [isolation:sales.get]
 *
 * in any `*.test.ts` file under apps/api/test. One test may carry one tag; a
 * procedure may have several. That is the whole mechanism — no list to edit
 * here, so two branches adding read paths in parallel do not conflict in this
 * file.
 *
 * The tagged test must make the three claims every probe in
 * `isolation-read-paths.test.ts` makes:
 *   1. tenant B really holds rows this procedure reads (a privileged read
 *      with an explicit tenant predicate — not RLS producing the count), and
 *      tenant A's own answer is non-empty;
 *   2. nothing of B's appears in A's answer, and A's aggregates are exactly
 *      A's figures;
 *   3. naming one of B's ids answers EXACTLY as a nonexistent id does.
 * The cheapest way to do all three: add a probe to `isolation-read-paths`
 * (its two-tenant world already holds one of everything; extend
 * `buildTenantWorld` if your table is new), use `assertSameAsNonexistent` and
 * `clean.assertClean` from `isolation-world.ts`, and add the probe's entry to
 * `DECISIVE_MUTATION` — the suite checks that every probe goes red under its
 * declared mutation.
 *
 * What this file CANNOT check is whether a tagged test is any good. It makes
 * absence red; review makes presence honest.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appRouter } from '../src/routers/index.js';

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

interface ProcedureDef {
  _def: { type: string };
}

/** Every QUERY procedure on a router, by its dotted path. */
export function queryProcedures(router: { _def: { procedures: Record<string, unknown> } }): string[] {
  return Object.entries(router._def.procedures)
    .filter(([, p]) => (p as ProcedureDef)._def.type === 'query')
    .map(([path]) => path)
    .sort();
}

export interface IsolationTag {
  file: string;
  procedure: string;
  /** `skip`, `todo`, `only`, `fails`, … — any modifier at all is refused. */
  modifier: string | null;
}

/**
 * Comments are removed first, so a tag written in a doc comment (like the
 * example above) registers nothing — only a real test title counts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const TAG_RE = /\b(?:it|test)(?:\.(\w+))?\(\s*['"`]\[isolation:([A-Za-z0-9_.]+)\]/g;

export function tagsIn(file: string, source: string): IsolationTag[] {
  return [...stripComments(source).matchAll(TAG_RE)].map((m) => ({
    file,
    procedure: m[2]!,
    modifier: m[1] ?? null,
  }));
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? testFiles(join(dir, e.name))
      : e.name.endsWith('.test.ts')
        ? [join(dir, e.name)]
        : [],
  );
}

export function sweep(queries: readonly string[], tags: readonly IsolationTag[]) {
  const live = tags.filter((t) => t.modifier === null);
  const registered = new Set(live.map((t) => t.procedure));
  return {
    /** Query procedures with no live two-tenant test. */
    missing: queries.filter((q) => !registered.has(q)).sort(),
    /** Tags naming a procedure that is not a mounted query (renamed? removed? typo?). */
    stale: tags.filter((t) => !queries.includes(t.procedure)).map((t) => `${t.procedure} (${t.file})`),
    /** Tagged tests that are skipped, todo, focused or expected to fail. */
    disabled: tags.filter((t) => t.modifier !== null).map((t) => `${t.procedure}.${t.modifier} (${t.file})`),
  };
}

function repoTags(): IsolationTag[] {
  return testFiles(TEST_DIR).flatMap((f) => tagsIn(f.slice(TEST_DIR.length), readFileSync(f, 'utf8')));
}

describe('route sweep: every query procedure has a registered two-tenant isolation test', () => {
  it('enumerates the real router (non-vacuity: the sweep is looking at something)', () => {
    const queries = queryProcedures(appRouter);
    expect(queries).toContain('catalogue.detail');
    expect(queries).toContain('reports.cashPosition');
    expect(queries).toContain('session.permissions');
    expect(queries.length).toBeGreaterThanOrEqual(37);
    expect(repoTags().length).toBeGreaterThanOrEqual(queries.length);
  });

  it('no query procedure is missing one; no tag is stale; none is skipped', () => {
    const result = sweep(queryProcedures(appRouter), repoTags());
    expect(result).toEqual({ missing: [], stale: [], disabled: [] });
  });

  it('negative control: a new, untested query turns the sweep red', () => {
    const result = sweep([...queryProcedures(appRouter), 'cash.sessionTotals'], repoTags());
    expect(result.missing).toEqual(['cash.sessionTotals']);
  });

  it('negative control: a skipped, focused or misspelled registration does not count', () => {
    // Built with a placeholder so THIS file's source registers nothing when
    // the sweep scans it — the synthetic tags exist only at runtime.
    const source = [
      "it.skip('@TAGsales.get] skipped', () => {});",
      "it.only('@TAGsales.get] focused', () => {});",
      "it('@TAGsales.gett] typo', () => {});",
      "/** it('@TAGreview.get] in a comment') */",
      "// it('@TAGreview.list] commented out', () => {});",
    ]
      .join('\n')
      .split('@TAG')
      .join('[isolation:');
    const tags = tagsIn('synthetic.test.ts', source);
    const result = sweep(['sales.get', 'review.get', 'review.list'], tags);
    expect(result.missing).toEqual(['review.get', 'review.list', 'sales.get']);
    expect(result.stale).toEqual(['sales.gett (synthetic.test.ts)']);
    expect(result.disabled).toEqual([
      'sales.get.skip (synthetic.test.ts)',
      'sales.get.only (synthetic.test.ts)',
    ]);
  });
});
