#!/usr/bin/env node
/**
 * Mint a development API bearer token for the local docker stack.
 *
 *   pnpm dev:token                       # tenant A, Techiman Flagship, outlet_manager
 *   pnpm dev:token --tenant B            # the second tenant (isolation testing)
 *   pnpm dev:token --location OUT-03     # a different outlet
 *   pnpm dev:token --role counter_staff  # a lower-privilege principal
 *   pnpm dev:token --env                 # print a ready-to-paste apps/web/.env.local
 *
 * A TOKEN IS NOT AUTHORITY. The API resolves permissions per request from
 * `app.effective_permission`, keyed on this token's `uid` — so a bearer for a
 * uid that holds no role assignment is refused at the first guarded route with
 * `FORBIDDEN: PERMISSION_DENIED`. `--role` therefore names a PROVISIONED
 * PRINCIPAL (`app.user_account.username = 'dev-<ref>'`, seeded by
 * infra/scripts/bootstrap.ts), not a free-text label: this script looks the
 * user up and mints for it. If the lookup fails, run `pnpm stack:up` — the
 * bootstrap is what creates them.
 *
 * The `role` CLAIM in the minted token stays an opaque string that the
 * platform never branches on (CLAUDE.md §2.9). It is carried for logging and
 * for nothing else; the authority comes entirely from the uid's grants.
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
const roleRef = arg('role', 'outlet_manager');
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
    where tenant_id = $1 and kind <> 'TRANSIT' ${locationCode ? 'and code = $2' : "and kind = 'OUTLET'"}
    order by code limit 1`,
  locationCode ? [tenant.id, locationCode] : [tenant.id],
);

// The principal this token speaks for. Provisioned by the bootstrap; without
// it the token is a valid signature belonging to nobody, and every guarded
// route refuses it.
const { rows: principals } = await client.query(
  `select id, display_name from app.user_account
    where tenant_id = $1 and username = $2 and deleted_at is null and status = 'ACTIVE'`,
  [tenant.id, `dev-${roleRef}`],
);

// What the grant actually reaches, straight from the closure-backed view the
// authorization model uses. Never a guess, and never wider than the grant.
const { rows: scope } = principals[0]
  ? await client.query(
      `select location_id from app.user_location_scope where tenant_id = $1 and user_id = $2`,
      [tenant.id, principals[0].id],
    )
  : { rows: [] };
await client.end();

if (principals.length === 0) {
  console.error(`No dev principal "dev-${roleRef}" on tenant ${which}.`);
  console.error(`Known refs: counter_staff, outlet_manager, regional_manager, accounts, head_of_operations.`);
  console.error(`If the ref is right, the bootstrap has not run against this database: pnpm stack:up`);
  process.exit(1);
}
const principal = principals[0];
const scopeIds = new Set(scope.map((r) => r.location_id));

if (rows.length === 0) {
  console.error(
    locationCode
      ? `No location "${locationCode}" for tenant ${which}. Run: pnpm stack:reset`
      : `Tenant ${which} has no locations. Run: pnpm stack:reset`,
  );
  process.exit(1);
}
const location = rows[0];

if (!scopeIds.has(location.id)) {
  console.error(
    `Principal dev-${roleRef} has no authority at ${location.code}: its grant covers ` +
      `${scopeIds.size} location(s). Pick a location inside the grant, or choose another --role.`,
  );
  process.exit(1);
}

// No `dev` claim: it must be a uuid, and when absent the API derives a stable
// device id from uid — the documented behaviour for a browser session without
// a registered device (apps/api/src/auth.ts).
//
// `locs` stays ONE location: it is a DEVICE scope — which counter this tablet
// is standing at — and is deliberately narrower than the principal's grant
// (02 §2.5, the right to see something is not the right to have it on your
// device). The API enforces both, independently.
const token = await new SignJWT({
  tid: tenant.id,
  uid: principal.id,
  role: roleRef,
  locs: [location.id],
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime(ttl)
  .sign(new TextEncoder().encode(DEV_JWT_SECRET));

if (wantEnv) {
  console.log(`# apps/web/.env.local — dev only, do not commit.`);
  console.log(`# tenant ${which} (${tenant.legalName}) @ ${location.code} ${location.name}, principal dev-${roleRef}`);
  console.log(`VITE_API_URL=${API_URL}`);
  console.log(`VITE_POWERSYNC_URL=${POWERSYNC_URL}`);
  console.log(`VITE_API_TOKEN=${token}`);
} else {
  console.error(`tenant ${which}: ${tenant.legalName} (${tenant.id})`);
  console.error(`location:  ${location.code} ${location.name}`);
  console.error(`principal: dev-${roleRef} (${principal.display_name}, uid ${principal.id})`);
  console.error(`grant reaches ${scopeIds.size} location(s); token locs = [${location.code}]   expires: ${ttl}`);
  console.error(`--- token (stdout) ---`);
  console.log(token);
}
