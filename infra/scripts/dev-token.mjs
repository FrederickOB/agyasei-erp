#!/usr/bin/env node
/**
 * Mint a development API bearer token for the local docker stack.
 *
 *   pnpm dev:token                      # tenant A, Techiman Flagship, outlet_manager
 *   pnpm dev:token --tenant B           # the second tenant (isolation testing)
 *   pnpm dev:token --location OUT-03    # a different outlet
 *   pnpm dev:token --role outlet_staff  # a lower-privilege role
 *   pnpm dev:token --env                # print a ready-to-paste apps/web/.env.local
 *
 * DEV ONLY. Signed with DEV_JWT_SECRET (default "dev-secret-change-me"), the
 * same HS256 secret the PowerSync service validates against. The API exchanges
 * this at GET /sync/token for a short-lived PowerSync client token; tenant
 * identity (tid) always comes from this verified token, never from the client.
 * Never commit a minted token, and never use this against anything real.
 */
import { SignJWT } from 'jose';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INFRA = join(HERE, '..');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const DEV_JWT_SECRET = process.env.DEV_JWT_SECRET ?? 'dev-secret-change-me';
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const POWERSYNC_URL = process.env.POWERSYNC_URL ?? 'http://localhost:8080';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const wantEnv = process.argv.includes('--env');
const which = arg('tenant', 'A').toUpperCase();
const locationCode = arg('location', null);
const role = arg('role', 'outlet_manager');
const ttl = arg('ttl', '12h');

const tenants = JSON.parse(readFileSync(join(INFRA, 'dev-tenants.json'), 'utf8'));
const tenant = which === 'B' ? tenants.tenantB : tenants.tenantA;
if (!tenant) {
  console.error(`Unknown tenant "${which}". Use --tenant A or --tenant B.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
try {
  await client.connect();
} catch (err) {
  console.error(`Cannot reach Postgres at ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);
  console.error(`Is the stack up?  pnpm stack:up`);
  console.error(String(err.message ?? err));
  process.exit(1);
}

const { rows } = await client.query(
  `select id, code, name from app.location
    where tenant_id = $1 ${locationCode ? 'and code = $2' : ''}
    order by code limit 1`,
  locationCode ? [tenant.id, locationCode] : [tenant.id],
);
await client.end();

if (rows.length === 0) {
  console.error(
    locationCode
      ? `No location "${locationCode}" for tenant ${which}. Run: pnpm stack:reset`
      : `Tenant ${which} has no locations. Run: pnpm stack:reset`,
  );
  process.exit(1);
}
const location = rows[0];

// No `dev` claim: it must be a uuid, and when absent the API derives a stable
// device id from uid — the documented behaviour for a browser session without
// a registered device (apps/api/src/auth.ts).
const token = await new SignJWT({
  tid: tenant.id,
  uid: `01900000-0000-7000-8000-0000000000${which === 'B' ? '02' : '01'}`,
  role,
  locs: [location.id],
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime(ttl)
  .sign(new TextEncoder().encode(DEV_JWT_SECRET));

if (wantEnv) {
  console.log(`# apps/web/.env.local — dev only, do not commit.`);
  console.log(`# tenant ${which} (${tenant.legalName}) @ ${location.code} ${location.name}, role ${role}`);
  console.log(`VITE_API_URL=${API_URL}`);
  console.log(`VITE_POWERSYNC_URL=${POWERSYNC_URL}`);
  console.log(`VITE_API_TOKEN=${token}`);
} else {
  console.error(`tenant ${which}: ${tenant.legalName} (${tenant.id})`);
  console.error(`location:  ${location.code} ${location.name}`);
  console.error(`role:      ${role}   expires: ${ttl}`);
  console.error(`--- token (stdout) ---`);
  console.log(token);
}
