/**
 * POC setup — a DEMO company on the free-tier POC environment, and the code
 * that brings its first device online. `pnpm poc:setup` (docs/poc-runbook.md).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DEMO DATA ONLY. This seeds made-up prices, demo locations and the UNREVIEWED
 * draft chart of accounts — dev fixtures, never tenant configuration. It
 * REFUSES a database holding any ACTIVE tenant: a POC tenant is never
 * activated (the §2.8 tax gate stays shut), so an active tenant means this is
 * not a POC database.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Idempotent: safe to re-run. Against a database the API has ALREADY migrated
 * (its container migrates on start), connected as the migrator:
 *
 *   1. the Ghana jurisdiction pack (idempotent; tax rates stay UNCONFIRMED);
 *   2. the demo company, born 'provisioning' exactly as createTenant makes it;
 *   3. the template, three demo outlets (each with its TRANSIT node), receipt
 *      counters, demo prices, buyable purchase units, the draft ledger — every
 *      tenant statement as app_user under RLS, like the dev bootstrap;
 *   4. its first administrator, linked to YOUR sign-in (Zitadel), and a
 *      15-minute, single-use code for the first device
 *      (apps/api/src/identity/first-admin.ts). Re-run before any device has
 *      enrolled and the same founder gets a fresh code; after that, codes come
 *      from the app's Devices screen.
 *
 * Optional: POC_SECOND_ADMIN_SUBJECT adds a SECOND demo company with its own
 * founder, to show that two companies cannot see each other (Phase 1
 * acceptance criterion 5).
 *
 * Environment (values never printed):
 *   MIGRATE_DATABASE_URL     the migrator (`postgres`), Supabase SESSION pooler :5432
 *   DATABASE_CA_CERT_FILE    path to Supabase's CA certificate (or DATABASE_CA_CERT)
 *   DATABASE_SSL_MODE        default verify-full
 *   OIDC_ISSUER              exactly as the API has it (your Zitadel issuer URL)
 *   POC_ADMIN_SUBJECT        your Zitadel user ID (the id_token `sub`)
 *   POC_ADMIN_NAME           default "Founder";  POC_ADMIN_USERNAME default "founder"
 *   POC_COMPANY_NAME         default "Demo Building Supplies Ltd"
 *   POC_FIRST_DEVICE         laptop | tablet | phone (default laptop)
 *   POC_FIRST_DEVICE_AT      store (Main Store, syncs its data) | head-office
 *                            (empty scope: syncs nothing, works online). Default store.
 *   POWERSYNC_URL            optional — recorded as the tenant's sync service
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createHlcClock, deterministicUuid, hlcNodeFromName, seedDevLedger, sha256Hex, type SqlClient } from '@erp/db';
import { applySequenceCounters, applyTemplate, seedGhanaJurisdiction } from '@erp/db/seed';
import { FirstAdminRefused, bootstrapFirstAdmin, type FirstAdminResult } from '../../apps/api/src/identity/first-admin.js';
import { applyDevPrices } from './dev-prices.js';
import { applyDevPurchaseUnits } from './dev-purchase-units.js';

const NS = 'poc-setup';
const clock = createHlcClock(hlcNodeFromName(NS));

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required (docs/poc-runbook.md)`);
  return v;
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

/** Demo locations: one ROOT group, three outlets, each with its TRANSIT node
 *  (04 §4.7.3) — the shape the template's pilot network has, minus the regions. */
const DEMO_OUTLETS = [
  { code: 'OUT-01', name: 'Main Store', type: 'FLAGSHIP' },
  { code: 'OUT-02', name: 'Depot', type: 'RDC' },
  { code: 'OUT-03', name: 'Roadside Shop', type: 'MICRO' },
] as const;

interface Company {
  name: string;
  slug: string;
  subject: string;
  adminName: string;
  adminUsername: string;
}

async function main(): Promise<void> {
  const url = need('MIGRATE_DATABASE_URL');
  const ssl = tlsFromEnv();
  const issuer = need('OIDC_ISSUER');
  const formFactor = (process.env['POC_FIRST_DEVICE'] ?? 'laptop') as 'laptop' | 'tablet' | 'phone';
  if (!['laptop', 'tablet', 'phone'].includes(formFactor)) throw new Error('POC_FIRST_DEVICE must be laptop, tablet or phone');
  const at = process.env['POC_FIRST_DEVICE_AT'] ?? 'store';
  if (at !== 'store' && at !== 'head-office') throw new Error('POC_FIRST_DEVICE_AT must be store or head-office');

  const companyName = process.env['POC_COMPANY_NAME'] ?? 'Demo Building Supplies Ltd';
  const companies: Company[] = [
    {
      name: companyName,
      slug: slugOf(companyName),
      subject: need('POC_ADMIN_SUBJECT'),
      adminName: process.env['POC_ADMIN_NAME'] ?? 'Founder',
      adminUsername: process.env['POC_ADMIN_USERNAME'] ?? 'founder',
    },
  ];
  const second = process.env['POC_SECOND_ADMIN_SUBJECT']?.trim();
  if (second) {
    companies.push({ name: 'Second Demo Traders Ltd', slug: 'second-demo-traders', subject: second, adminName: 'Second founder', adminUsername: 'founder' });
  }

  // TLS decided here, not by URL parameters — the same rule as @erp/ops'
  // pgPoolConfig (whose package index this CommonJS script cannot load).
  const u = new URL(url);
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl', 'uselibpqcompat']) u.searchParams.delete(k);
  const client = new pg.Client({
    connectionString: u.toString(),
    ssl: ssl.mode === 'disable' ? false : { rejectUnauthorized: true, ...(ssl.ca ? { ca: ssl.ca } : {}) },
    application_name: 'erp-poc-setup',
    connectionTimeoutMillis: 10_000,
  });
  client.on('error', () => undefined);
  await client.connect();
  u.password = u.password ? '***' : '';
  console.log(`[poc-setup] connected to ${u.toString()} (ssl ${ssl.mode})`);
  const db: SqlClient = {
    exec: (sql) => client.query(sql),
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params as never)).rows as T[] }),
  };

  async function withTenant<T>(tenantId: string, fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    await db.exec('begin');
    try {
      await db.query('set local role app_user');
      await db.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(db);
      await db.exec('commit');
      return out;
    } catch (err) {
      await db.exec('rollback');
      throw err;
    }
  }

  try {
    // ── Preconditions ────────────────────────────────────────────────────
    const migrated = await db.query<{ ok: boolean }>(`select to_regclass('app.device_enrolment_code') is not null as ok`);
    if (!migrated.rows[0]?.ok) {
      throw new Error('the database is not migrated — deploy the API first (its container migrates on start)');
    }
    const active = await db.query<{ n: string }>(`select count(*)::text as n from platform.tenant where status = 'active'`);
    if (Number(active.rows[0]!.n) > 0) {
      throw new Error('REFUSED: this database holds an ACTIVE tenant, so it is not a POC database. poc-setup seeds demo data and never runs against a real one.');
    }

    await seedGhanaJurisdiction(db);

    const results: { company: Company; tenantId: string; admin: FirstAdminResult | null; note?: string }[] = [];
    for (const company of companies) {
      // ── The company ───────────────────────────────────────────────────
      const found = await db.query<{ id: string }>(`select id::text from platform.tenant where slug = $1`, [company.slug]);
      const tenantId = found.rows[0]?.id ?? deterministicUuid(NS, 'tenant', company.slug);
      await db.query(
        `insert into platform.tenant (id, slug, legal_name, status, jurisdiction_code)
         values ($1, $2, $3, 'provisioning', 'GH') on conflict (id) do nothing`,
        [tenantId, company.slug, company.name],
      );
      await db.query(
        `insert into platform.tenant_database (tenant_id, dsn_ref, sync_service_ref)
         values ($1, 'secret://poc/supabase/dsn', $2) on conflict (tenant_id) do nothing`,
        [tenantId, process.env['POWERSYNC_URL'] ?? 'https://sync.invalid/poc'],
      );

      // ── Template, locations, counters, demo prices, units, draft ledger ─
      await withTenant(tenantId, (tx) => applyTemplate(tx, tenantId));
      await withTenant(tenantId, (tx) => seedDemoLocations(tx, tenantId));
      await withTenant(tenantId, (tx) => applySequenceCounters(tx, tenantId));
      const priced = await withTenant(tenantId, (tx) => applyDevPrices(tx, tenantId));
      await withTenant(tenantId, (tx) => applyDevPurchaseUnits(tx, tenantId));
      const ledger = await withTenant(tenantId, (tx) => seedDevLedger(tx, tenantId));
      console.log(
        `[poc-setup] ${company.name}: template applied, ${DEMO_OUTLETS.length} demo outlets, ` +
          `${priced.items} demo prices, DRAFT ledger (${ledger.accounts} accounts — unreviewed, §2.8)`,
      );

      // ── First administrator and first device ─────────────────────────
      const storeId = deterministicUuid(tenantId, NS, 'loc', 'OUT-01');
      try {
        const admin = await withTenant(tenantId, (tx) =>
          bootstrapFirstAdmin(tx, clock, {
            tenantId,
            subjectIssuer: issuer,
            subjectRef: company.subject,
            username: company.adminUsername,
            displayName: company.adminName,
            device: {
              label: at === 'store' ? `First ${formFactor} — Main Store` : `First ${formFactor} — head office`,
              formFactor,
              locationId: at === 'store' ? storeId : null,
            },
          }),
        );
        results.push({ company, tenantId, admin });
      } catch (err) {
        if (err instanceof FirstAdminRefused && err.reason === 'FIRST_ADMIN_EXISTS') {
          results.push({ company, tenantId, admin: null, note: 'already onboarded — issue codes from the app (Admin → Devices)' });
        } else {
          throw err;
        }
      }
    }

    const unconfirmed = await db.query<{ tax_code: string }>(
      `select tax_code from platform.tax_rate
        where jurisdiction_code = 'GH' and upper_inf(effective) and confirmed_by is null order by tax_code`,
    );

    // ── Report ───────────────────────────────────────────────────────────
    const line = '─'.repeat(72);
    console.log(`\n${line}`);
    for (const r of results) {
      console.log(` ${r.company.name}   (tenant ${r.tenantId}, status: provisioning)`);
      if (r.admin) {
        console.log(`   First-device enrolment code:   ${r.admin.code}${r.admin.reissued ? '   (a fresh code; the earlier one is cancelled)' : ''}`);
        console.log(`   Valid until ${r.admin.expiresAt} — 15 minutes, single use.`);
        console.log(`   On the device: open the app, type it under "Enrolment code", then sign in`);
        console.log(`   with the Zitadel account whose user ID is ${r.company.subject}.`);
      } else {
        console.log(`   ${r.note}`);
      }
      console.log('');
    }
    if (unconfirmed.rows.length > 0) {
      console.log(
        ` Tax: ${unconfirmed.rows.length} Ghana rate(s) in force are UNCONFIRMED (${unconfirmed.rows.map((t) => t.tax_code).join(', ')}).`,
      );
      console.log(' Demo receipts use them as-is; confirming them is a practitioner’s act (CLAUDE.md §2.8, Q8), not this script’s.');
    }
    console.log(line);
  } finally {
    await client.end();
  }
}

/** verify-full by default; `disable` only for a local throwaway database. */
function tlsFromEnv(): { mode: 'verify-full' | 'disable'; ca: string | undefined } {
  const mode = process.env['DATABASE_SSL_MODE'] ?? 'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') throw new Error('DATABASE_SSL_MODE must be verify-full (or disable, for a local database only)');
  const file = process.env['DATABASE_CA_CERT_FILE'];
  const ca = (file ? readFileSync(file, 'utf8') : process.env['DATABASE_CA_CERT'])?.replace(/\\n/g, '\n');
  if (mode === 'verify-full' && !ca?.trim()) throw new Error('DATABASE_CA_CERT_FILE is required: download Supabase\'s CA certificate (docs/poc-runbook.md)');
  return { mode, ca };
}

async function seedDemoLocations(tx: SqlClient, tenantId: string): Promise<void> {
  const id = (...parts: string[]) => deterministicUuid(tenantId, NS, 'loc', ...parts);
  const writeId = deterministicUuid(tenantId, NS, 'write', 'locations');
  await tx.query(
    `insert into app.write_log
       (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
        op, schema_version, request_hash, response_body)
     values ($1, $2, 'SERVER', $3, null, null, null, null, 'poc-setup.apply:locations', 1, decode($4, 'hex'), null)
     on conflict (tenant_id, id) do nothing`,
    [tenantId, writeId, clock.next(), sha256Hex(`${NS}:locations:${tenantId}`)],
  );
  const types = await tx.query<{ id: string; code: string }>(`select id, code from app.location_type where deleted_at is null`);
  const typeId = (code: string) => types.rows.find((t) => t.code === code)?.id ?? null;
  const insert = (rowId: string, code: string, name: string, kind: string, type: string | null, parent: string | null) =>
    tx.query(
      `insert into app.location
         (tenant_id, id, write_id, hlc, code, name, kind, location_type_id,
          parent_id, is_active, timezone, origin_template_id, origin_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, 'Africa/Accra', null, null)
       on conflict (tenant_id, id) do nothing`,
      [tenantId, rowId, writeId, clock.next(), code, name, kind, type, parent],
    );
  await insert(id('ROOT'), 'ROOT', 'All locations', 'GROUP', null, null);
  for (const o of DEMO_OUTLETS) {
    await insert(id(o.code), o.code, o.name, 'OUTLET', typeId(o.type), id('ROOT'));
    await insert(id(`TRA-${o.code}`), `TRA-${o.code.slice(4)}`, `${o.name} — in transit`, 'TRANSIT', null, id(o.code));
  }
}

main().catch((err) => {
  console.error(`[poc-setup] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
