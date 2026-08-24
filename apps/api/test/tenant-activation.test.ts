/**
 * G-1: THE TAX CONFIRMATION GATE, ENFORCED AT ACTIVATION.
 *
 * `platform.tax_rate.confirmed_by` / `confirmed_at` have been in the schema
 * since migration 0001, paired by a CHECK, commented as "the §2.8 gate, in the
 * schema" — and read by nothing, while `createTenant` wrote `status = 'active'`
 * immediately. So the facility fee, which is unmodelled upside, refused to
 * post without a human; and sales tax, which is on every sale and is
 * statutory, was applied against rates nobody had attested to.
 *
 * That asymmetry was exactly backwards, and this closes the activation half of
 * it. The trading half is pinned at the foot of this file rather than claimed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;

async function operatorCaller() {
  return h.callerFor(await h.identityFor(uuidv7(), { operator: true, role: 'operator' }));
}

async function confirmGhanaRates(by: string): Promise<void> {
  await h.db.asAdmin((tx) =>
    tx.query(
      `update platform.tax_rate
          set confirmed_by = $1, confirmed_at = transaction_timestamp()
        where jurisdiction_code = 'GH' and upper_inf(effective)`,
      [by],
    ),
  );
}

async function clearConfirmations(): Promise<void> {
  await h.db.asAdmin((tx) =>
    tx.query(`update platform.tax_rate set confirmed_by = null, confirmed_at = null`),
  );
}

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('a tenant is born provisioning, not active', () => {
  it('createTenant leaves it in provisioning with no activation timestamp', async () => {
    const caller = await operatorCaller();
    const { tenantId } = await caller.provisioning.createTenant({
      slug: `g1-${uuidv7().slice(0, 8)}`, legalName: 'G1 Ltd', jurisdictionCode: 'GH',
    });
    const row = await h.db.asAdmin(async (tx) => {
      const r = await tx.query<{ status: string; activated_at: string | null }>(
        `select status, activated_at from platform.tenant where id = $1`, [tenantId]);
      return r.rows[0]!;
    });
    expect(row.status).toBe('provisioning');
    expect(row.activated_at).toBeNull();
  });
});

describe('activation refuses while a rate in force is unconfirmed', () => {
  let tenantId: string;

  beforeAll(async () => {
    await clearConfirmations();
    const caller = await operatorCaller();
    ({ tenantId } = await caller.provisioning.createTenant({
      slug: `g1a-${uuidv7().slice(0, 8)}`, legalName: 'G1A Ltd', jurisdictionCode: 'GH',
    }));
  }, 60_000);

  it('readiness says what is missing, without making you read it off an error', async () => {
    const caller = await operatorCaller();
    const readiness = await caller.provisioning.activationReadiness({ tenantId });
    expect(readiness.canActivate).toBe(false);
    expect(readiness.ratesInForce).toBeGreaterThan(0);
    expect(readiness.unconfirmedTaxCodes).toContain('GH.VAT.STD');
  });

  it('activation is REFUSED, and the refusal names the codes and the rule', async () => {
    const caller = await operatorCaller();
    await expect(caller.provisioning.activateTenant({ tenantId })).rejects.toThrow(
      /TAX_RATES_UNCONFIRMED.*GH\.VAT\.STD/s,
    );
    await expect(caller.provisioning.activateTenant({ tenantId })).rejects.toThrow(/§2\.8/);
  });

  it('…and the tenant is still provisioning afterwards — nothing partial happened', async () => {
    const status = await h.db.asAdmin(async (tx) => {
      const r = await tx.query<{ status: string }>(
        `select status from platform.tenant where id = $1`, [tenantId]);
      return r.rows[0]!.status;
    });
    expect(status).toBe('provisioning');
  });

  it('once a practitioner has confirmed them, the SAME call succeeds', async () => {
    // The positive control. Without it the refusals above would pass just as
    // well against a route that always threw.
    await confirmGhanaRates('A. Practitioner, ICAG 12345');
    const caller = await operatorCaller();
    const result = await caller.provisioning.activateTenant({ tenantId });
    expect(result.status).toBe('active');
    expect(result.alreadyActive).toBe(false);

    const row = await h.db.asAdmin(async (tx) => {
      const r = await tx.query<{ status: string; activated_at: string | null }>(
        `select status, activated_at from platform.tenant where id = $1`, [tenantId]);
      return r.rows[0]!;
    });
    expect(row.status).toBe('active');
    expect(row.activated_at).not.toBeNull();
  });

  it('activating twice is idempotent, not an error', async () => {
    const caller = await operatorCaller();
    const again = await caller.provisioning.activateTenant({ tenantId });
    expect(again.alreadyActive).toBe(true);
  });
});

describe('what "in force" means, and why a lapsed rate does not block', () => {
  it('a rate whose window has ENDED is not required to be confirmed', async () => {
    // A tenant must not be blocked forever by a 2019 row nobody can now
    // attest to. A historical transaction reprices against the row in force
    // on its own date, which is a separate and separately-tested guarantee.
    await clearConfirmations();
    await h.db.asAdmin((tx) =>
      tx.query(
        `update platform.tax_rate set confirmed_by = 'A. Practitioner', confirmed_at = transaction_timestamp()
          where jurisdiction_code = 'GH' and upper_inf(effective)`,
      ),
    );
    const lapsed = await h.db.asAdmin(async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text n from platform.tax_rate
          where jurisdiction_code = 'GH' and not upper_inf(effective) and confirmed_by is null`);
      return Number(r.rows[0]!.n);
    });
    // The fixture must actually contain a lapsed unconfirmed row, or this
    // test proves nothing.
    expect(lapsed).toBeGreaterThan(0);

    const caller = await operatorCaller();
    const { tenantId } = await caller.provisioning.createTenant({
      slug: `g1b-${uuidv7().slice(0, 8)}`, legalName: 'G1B Ltd', jurisdictionCode: 'GH',
    });
    const result = await caller.provisioning.activateTenant({ tenantId });
    expect(result.status).toBe('active');
  });
});

describe('THE HALF THIS DOES NOT CLOSE — pinned, not claimed', () => {
  it('nothing outside provisioning reads tenant.status, so a provisioning tenant can still trade', async () => {
    // This test EXISTS TO FAIL when somebody wires it up, and to stop the
    // activation gate quietly becoming the same kind of unread control it was
    // built to replace. Grep-based rather than behavioural on purpose: the
    // claim is about the absence of a reader, which behaviour cannot show.
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../src/', import.meta.url));

    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith('.ts') && !p.endsWith('provisioning.ts')) {
          const src = readFileSync(p, 'utf8');
          if (/platform\.tenant\b[\s\S]{0,120}\bstatus\b/.test(src)) readers.push(p);
        }
      }
    };
    walk(root);

    // When this fails, the gate has grown a consumer. Read the diff, decide
    // whether trading should now require activation, and update this test
    // deliberately — do not delete it.
    expect(readers).toEqual([]);
  });
});
