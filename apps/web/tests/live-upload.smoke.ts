/**
 * SUPERSEDED by drill D6 — `pnpm --filter @erp/wire-conformance drill:live`, run
 * as part of `pnpm --filter @erp/sync-drills drill` and reported in
 * docs/sync-drill-report.md. D6 does everything this script does and then asserts
 * the sale, its lines, its tax lines and its stock movements actually landed, that
 * the server's total is an exact bigint identity, and that a byte-identical
 * re-POST is `duplicate` with no second effect — and it exits non-zero when any of
 * that fails, which this script only partly does. Kept for now because it needs no
 * package beyond `apps/web`; prefer D6, and delete this once nobody reaches for it.
 *
 * NOT part of `pnpm test`. It is not a `*.test.ts` (vitest only collects
 * those) and it needs the docker stack plus an API dev server running the
 * CURRENT source.
 *
 *   pnpm stack:up
 *   pnpm dev:api                       # or: API_PORT=3002 pnpm --filter @erp/api dev:stack
 *   pnpm --filter @erp/web exec tsx tests/live-upload.smoke.ts
 *
 * Demonstrated, not asserted (CLAUDE.md Phase 1 acceptance). This builds a
 * sale payload with the CLIENT'S OWN `buildSalePayload` and ships it through
 * the CLIENT'S OWN transport to the real `POST /sync/upload`, against real
 * seeded tenant data. That round trip is the one that used to answer
 * BAD_REQUEST for every sale the PWA ever uploaded, and the unit tests can
 * only prove the shape parses — they cannot prove the server takes it.
 *
 * It deliberately imports NOTHING outside `apps/web`'s own dependencies: the
 * token comes from the repo's existing dev-token script and the ids from psql
 * in the stack's own container, so this file cannot quietly acquire a `pg` or
 * `jose` dependency the PWA does not have.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSalePayload } from '../src/data/mutations/checkout';
import { httpUploadTransport } from '../src/data/sync/transport';
import type { CartLineRow } from '../src/data/queries/cart';
import { uuidv7 } from '../src/lib/uuidv7';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';
const PG_CONTAINER = process.env['PG_CONTAINER'] ?? 'erp-dev-stack-postgres-1';

function psql(sql: string): string[][] {
  const out = execFileSync(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-U', 'erp', '-d', 'erp', '-t', '-A', '-F', '|', '-c', sql],
    { encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('|'));
}

function devToken(): string {
  return execFileSync('node', [path.join(repoRoot, 'infra/scripts/dev-token.mjs')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

async function main(): Promise<void> {
  const [tenantRow] = psql(`select id from platform.tenant order by created_at limit 1`);
  const tenantId = tenantRow?.[0];
  if (tenantId === undefined) throw new Error('no tenant — run pnpm stack:reset');

  const [locationRow] = psql(
    `select id, code from app.location where tenant_id = '${tenantId}' order by code limit 1`,
  );
  const [priceListRow] = psql(
    `select id, code from app.price_list where tenant_id = '${tenantId}' order by priority desc limit 1`,
  );
  const [productRow] = psql(
    `select p.id from app.product p
       join app.price_list_item i on i.tenant_id = p.tenant_id and i.product_id = p.id
      where p.tenant_id = '${tenantId}' and i.price_list_id = '${priceListRow?.[0] ?? ''}'
        and p.is_sellable
      order by p.sku_code limit 1`,
  );
  // The tenant's own drawer-cash method — found by its PLATFORM property,
  // never by a code or a name (CLAUDE.md §2.9).
  const [cashRow] = psql(
    `select id from app.tender_method
      where tenant_id = '${tenantId}' and is_cash and is_active and deleted_at is null
      order by sort_order limit 1`,
  );
  const locationId = locationRow?.[0];
  const priceListCode = priceListRow?.[1];
  const productId = productRow?.[0];
  const cashMethodId = cashRow?.[0];
  if (locationId === undefined || priceListCode === undefined || productId === undefined
      || cashMethodId === undefined) {
    throw new Error('incomplete seed data — run pnpm stack:reset');
  }

  const saleId = uuidv7();
  const tillId = uuidv7();
  const claimedHlc = `${String(Date.now()).padStart(13, '0')}-00000-${'ab'.repeat(16)}`;
  const nowIso = new Date().toISOString();
  const lines: CartLineRow[] = [
    {
      id: uuidv7(),
      cartId: saleId,
      seq: 1,
      productId,
      name: 'smoke line',
      uomLabel: 'each',
      qtyScale: 0,
      qtyScaled: 2n,
      unitPriceE4: 1_000_000n,
    },
  ];

  const built = buildSalePayload({
    saleId,
    locationId,
    priceListCode,
    receiptNo: `SMOKE-${saleId.slice(-6).toUpperCase()}`,
    // A SHARED till opened for today by the op queued just ahead of the sale.
    cashSessionId: tillId,
    tenders: [{
      method: { id: cashMethodId, name: 'cash', isCash: true, isOnAccount: false,
                requiresReference: false, settlement: 'IMMEDIATE' },
      amountMinor: null,
      tenderedMinor: 1_000_000n,
    }],
    claimedHlc,
    createdAt: nowIso,
    lines,
  });
  const openPayload = JSON.stringify({
    locationId,
    businessDate: nowIso.slice(0, 10),
    openingFloatMinor: '0',
    openedAt: nowIso,
    openedOffline: false,
    drawer: 'SHARED',
  });

  const transport = httpUploadTransport({ apiUrl: API_URL, apiToken: devToken() });
  const result = await transport.send([
    {
      id: tillId,
      idempotencyKey: tillId,
      claimedHlc,
      kind: 'cash_session_open',
      payloadJson: openPayload,
      createdAt: nowIso,
    },
    {
      id: saleId,
      idempotencyKey: saleId,
      claimedHlc,
      kind: 'sale',
      payloadJson: built.payloadJson,
      createdAt: nowIso,
    },
  ]);

  console.log('payload:', built.payloadJson);
  console.log('result :', JSON.stringify(result, null, 2));
  if (!result.ok || result.acks.some((a) => a.status !== 'applied')) {
    throw new Error(`sale was NOT applied: ${JSON.stringify(result)}`);
  }

  // The server PRICED it. The client's `clientTotalMinor` was a claim from a
  // deliberately wrong local unit price; what landed is the server's figure.
  const [sale] = psql(
    `select receipt_no, business_date, total_minor, subtotal_net_minor, tax_total_minor
       from app.sale where tenant_id = '${tenantId}' and receipt_no = '${built.payload.receiptNo}'`,
  );
  console.log('\nserver wrote:', sale?.join(' | '));
  console.log('client claimed clientTotalMinor:', built.totalMinor.toString());
  console.log('\nOK — the client payload was applied and the SERVER priced it.');
}

await main();
