/**
 * THE SYNC RULES CARRY THE TENANT BOUNDARY — checked structurally, on every
 * commit, with no stack.
 *
 * CLAUDE.md §2.1: "Sync rules carry the boundary. A device syncs
 * tenant_id = token.tenant_id … This is where data actually leaves the
 * server." RLS does not apply on this path at all — the replication role is
 * BYPASSRLS and logical replication never evaluates policies
 * (01-tenancy "What none of this covers") — so the rule text IS the control.
 *
 * The Phase 2 gate (docs/phase2-gate-evidence.md §4.4.5) found the live drills
 * excellent (D5's byte-grep of the device's SQLite, D8's forged-tid token) and
 * this exact gap: "there is no test asserting every `data:` query in
 * sync_rules.yaml carries WHERE tenant_id = bucket.tenant_id, and none
 * asserting no parameter query uses request.parameters()". A new bucket with a
 * forgotten predicate was caught only by D5, and only when somebody ran it.
 *
 * WHAT IS CHECKED, per bucket:
 *  1. No query — parameter or data — reads `request.parameters()`: that is
 *     client-supplied input, and a tenant chosen by the client is an attack.
 *  2. The parameter query derives the tenant from the SIGNED token:
 *     `request.jwt() ->> 'tid'`.
 *  3. Every data query over an `app.*` table carries
 *     `tenant_id = bucket.tenant_id`, and the bucket exposes a `tenant_id`
 *     parameter for it to bind to.
 *  4. Data queries over `platform.*` read ONLY global reference data
 *     (jurisdiction, tax_code, tax_rate) — never the tenant registry, never
 *     placement — and only in a bucket whose key is derived from the token.
 *
 * What this cannot check is that the predicate is the RIGHT predicate for a
 * role or a location; that is D5 and D8, against the running stack.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RULES = readFileSync(path.join(REPO_ROOT, 'infra/powersync/sync_rules.yaml'), 'utf8');

/** Platform tables a device may receive: jurisdiction packs, nothing else. */
const DELIVERABLE_PLATFORM_TABLES = ['jurisdiction', 'tax_code', 'tax_rate'];

interface Bucket {
  name: string;
  parameters: string;
  data: string[];
}

/** A line-based reader for exactly the shape `sync_rules.yaml` uses. */
export function parseBuckets(yaml: string): Bucket[] {
  const lines = yaml.split('\n').filter((l) => !/^\s*#/.test(l));
  const buckets: Bucket[] = [];
  let bucket: Bucket | null = null;
  let section: 'parameters' | 'data' | null = null;
  let item: string[] | null = null;
  const flushItem = () => {
    if (bucket && item) bucket.data.push(item.join(' ').replace(/\s+/g, ' ').trim());
    item = null;
  };
  for (const line of lines) {
    const name = /^ {2}([a-z_]+):\s*$/.exec(line);
    if (name) {
      flushItem();
      bucket = { name: name[1]!, parameters: '', data: [] };
      buckets.push(bucket);
      section = null;
      continue;
    }
    if (!bucket) continue;
    const params = /^ {4}parameters:\s*(.*)$/.exec(line);
    if (params) {
      flushItem();
      section = 'parameters';
      bucket.parameters = params[1] === '|' ? '' : params[1]!;
      continue;
    }
    if (/^ {4}data:\s*$/.test(line)) {
      flushItem();
      section = 'data';
      continue;
    }
    if (section === 'parameters') {
      bucket.parameters = `${bucket.parameters} ${line.trim()}`.trim();
      continue;
    }
    if (section === 'data') {
      const start = /^\s*-\s+(.*)$/.exec(line);
      if (start) {
        flushItem();
        item = [start[1]!];
      } else if (item && line.trim() !== '') {
        item.push(line.trim());
      }
    }
  }
  flushItem();
  return buckets;
}

export function boundaryViolations(buckets: readonly Bucket[]): string[] {
  const out: string[] = [];
  for (const b of buckets) {
    const params = b.parameters.replace(/\s+/g, ' ');
    if (/request\.parameters\(\)/.test(params)) out.push(`${b.name}: parameter query reads request.parameters()`);
    if (!/request\.jwt\(\)\s*->>\s*'tid'/.test(params))
      out.push(`${b.name}: parameter query does not derive the tenant from the token's tid`);
    const exposesTenant = /\bAS tenant_id\b/i.test(params) || /^SELECT\s+tenant_id\b/i.test(params);
    for (const q of b.data) {
      if (/request\.parameters\(\)/.test(q)) out.push(`${b.name}: data query reads request.parameters()`);
      const from = /FROM "(app|platform)"\."([a-z_]+)"/.exec(q);
      if (!from) {
        out.push(`${b.name}: data query reads no app/platform table: ${q.slice(0, 60)}`);
        continue;
      }
      const [, schema, table] = from;
      if (schema === 'app') {
        if (!/\bWHERE\b[\s\S]*\btenant_id = bucket\.tenant_id\b/.test(q))
          out.push(`${b.name}: app.${table} is delivered without tenant_id = bucket.tenant_id`);
        if (!exposesTenant) out.push(`${b.name}: app.${table} is delivered but the bucket has no tenant_id parameter`);
      } else if (!DELIVERABLE_PLATFORM_TABLES.includes(table!)) {
        out.push(`${b.name}: platform.${table} is not deliverable reference data`);
      }
    }
  }
  return out;
}

describe('sync rules carry the tenant boundary (structural, every commit)', () => {
  const buckets = parseBuckets(RULES);

  it('reads every bucket and every data query (non-vacuity)', () => {
    expect(buckets.map((b) => b.name)).toEqual(
      expect.arrayContaining(['tenant_reference', 'jurisdiction_pack', 'location_ops', 'tenant_credit']),
    );
    expect(buckets.every((b) => b.data.length > 0)).toBe(true);
    const appQueries = buckets.flatMap((b) => b.data).filter((q) => q.includes('FROM "app"'));
    expect(appQueries.length).toBeGreaterThanOrEqual(20);
  });

  it('no bucket reads request.parameters(); every tenant comes from the token; every app row is tenant-predicated', () => {
    expect(boundaryViolations(buckets)).toEqual([]);
  });

  it('negative control: a forgotten predicate, a client-chosen tenant and a registry leak are each caught', () => {
    const hostile = [
      'bucket_definitions:',
      '  forgot_predicate:',
      "    parameters: SELECT request.jwt() ->> 'tid' AS tenant_id",
      '    data:',
      '      - SELECT * FROM "app"."customer" WHERE deleted_at IS NULL',
      '  client_tenant:',
      "    parameters: SELECT request.parameters() ->> 'tenant' AS tenant_id",
      '    data:',
      '      - SELECT * FROM "app"."sale"',
      '         WHERE tenant_id = bucket.tenant_id',
      '  registry:',
      "    parameters: SELECT request.jwt() ->> 'tid' AS tenant_id",
      '    data:',
      '      - SELECT id, legal_name FROM "platform"."tenant" WHERE id = bucket.tenant_id',
    ].join('\n');
    expect(boundaryViolations(parseBuckets(hostile))).toEqual([
      'forgot_predicate: app.customer is delivered without tenant_id = bucket.tenant_id',
      'client_tenant: parameter query reads request.parameters()',
      "client_tenant: parameter query does not derive the tenant from the token's tid",
      'registry: platform.tenant is not deliverable reference data',
    ]);
  });
});
