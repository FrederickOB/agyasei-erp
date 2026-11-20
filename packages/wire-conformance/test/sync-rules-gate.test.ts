/**
 * THE SYNC RULES' GATE — every bucket, structurally (02 §2.3 Contract 1;
 * CLAUDE.md §2.6: sync rules ARE the authorization boundary).
 *
 * Since migration 0024 every parameter query must:
 *   1. read one of the two device-keyed projections — never a bare claim
 *      (`SELECT request.jwt() ->> 'tid' AS tenant_id` was a static bucket any
 *      token with a tid could open, enrolled device or not), and never a
 *      projection that does not know about the device;
 *   2. filter on ALL THREE claims — did, sub and tid — so a revoked device,
 *      a disabled user or a forged tenant matches no row;
 *   3. never read request.parameters() — client-supplied, unauthenticated.
 *
 * The rules were also run through PowerSync's own parser
 * (@powersync/service-sync-rules 0.28.0 and the then-latest) during this
 * change: zero errors, every lookup keyed (bucket, did, sub, tid), no static
 * buckets. That parser is not a dependency of this repo; this test is the
 * standing structural guard, and the live service is the final word.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RULES = readFileSync(path.join(REPO_ROOT, 'infra/powersync/sync_rules.yaml'), 'utf8');

interface Bucket {
  name: string;
  parameters: string;
}

/** Bucket name → its parameter query, comments stripped, whitespace collapsed. */
export function bucketsOf(yaml: string): Bucket[] {
  const lines = yaml.split('\n').filter((l) => !/^\s*#/.test(l));
  const out: Bucket[] = [];
  let current: Bucket | null = null;
  let inParams = false;
  for (const line of lines) {
    const bucket = /^ {2}([a-z_]+):\s*$/.exec(line);
    if (bucket) {
      if (current) out.push(current);
      current = { name: bucket[1]!, parameters: '' };
      inParams = false;
      continue;
    }
    if (!current) continue;
    const params = /^ {4}parameters:\s*(\|)?\s*(.*)$/.exec(line);
    if (params) {
      inParams = true;
      current.parameters += ` ${params[2] ?? ''}`;
      continue;
    }
    if (/^ {4}[a-z_]+:/.test(line)) {
      inParams = false;
      continue;
    }
    if (inParams) current.parameters += ` ${line.trim()}`;
  }
  if (current) out.push(current);
  return out.map((b) => ({ ...b, parameters: b.parameters.replace(/\s+/g, ' ').trim() }));
}

const PROJECTIONS = ['"app"."device_sync_grant"', '"app"."device_sync_location_scope"'];
const DID = /device_id\s*=\s*\(request\.jwt\(\) ->> 'did'\)/;
const SUB = /user_id\s*=\s*request\.user_id\(\)/;
const TID = /tenant_id\s*=\s*\(request\.jwt\(\) ->> 'tid'\)/;

export function gateViolations(yaml: string): string[] {
  const problems: string[] = [];
  const buckets = bucketsOf(yaml);
  if (buckets.length === 0) problems.push('no buckets parsed');
  for (const b of buckets) {
    if (b.parameters === '') {
      problems.push(`${b.name}: no parameter query`);
      continue;
    }
    if (!PROJECTIONS.some((p) => b.parameters.includes(`FROM ${p}`))) {
      problems.push(`${b.name}: parameter query does not read a device-keyed projection`);
    }
    if (!DID.test(b.parameters)) problems.push(`${b.name}: not keyed on the token's did`);
    if (!SUB.test(b.parameters)) problems.push(`${b.name}: not keyed on the token's sub`);
    if (!TID.test(b.parameters)) problems.push(`${b.name}: not keyed on the token's tid`);
  }
  const live = yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  if (live.includes('request.parameters()')) problems.push('request.parameters() appears — client-supplied, never a gate');
  return problems;
}

describe('sync rules: every bucket is gated by the device-keyed projections (0024)', () => {
  it('parses all seven buckets', () => {
    expect(bucketsOf(RULES).map((b) => b.name).sort()).toEqual([
      'jurisdiction_pack',
      'location_credit_allowance',
      'location_ops',
      'tenant_credit',
      'tenant_customers',
      'tenant_reference',
      'tenant_sale_lines_interim',
    ]);
  });

  it('every parameter query reads a projection and keys on did, sub and tid; none reads request.parameters()', () => {
    expect(gateViolations(RULES)).toEqual([]);
  });

  it('the credit buckets carry their slice filter, so a till never opens the book', () => {
    const byName = new Map(bucketsOf(RULES).map((b) => [b.name, b.parameters] as const));
    expect(byName.get('tenant_credit')).toMatch(/credit_book = 'book'/);
    expect(byName.get('location_credit_allowance')).toMatch(/credit_allowance = 'allowance'/);
  });

  it('negative controls: the guard catches each defect it exists for', () => {
    const claimOnly = RULES.replace(
      /  tenant_reference:\n    parameters: \|\n(?:      .*\n)+?(?=    data:)/,
      "  tenant_reference:\n    parameters: SELECT request.jwt() ->> 'tid' AS tenant_id\n",
    );
    expect(gateViolations(claimOnly)).toContain('tenant_reference: parameter query does not read a device-keyed projection');
    const noDid = RULES.replace("WHERE device_id = (request.jwt() ->> 'did')\n         AND user_id   = request.user_id()\n         AND tenant_id = (request.jwt() ->> 'tid')", "WHERE user_id = request.user_id()\n         AND tenant_id = (request.jwt() ->> 'tid')");
    expect(gateViolations(noDid).some((v) => v.endsWith("not keyed on the token's did"))).toBe(true);
    expect(gateViolations(`${RULES}\n  sneaky:\n    parameters: SELECT request.parameters() ->> 'tid' AS tenant_id\n`)).toContain(
      'request.parameters() appears — client-supplied, never a gate',
    );
  });
});
