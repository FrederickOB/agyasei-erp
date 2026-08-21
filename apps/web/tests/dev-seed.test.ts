/**
 * THE FREEZE, AND THE RULE THAT ENDS IT.
 *
 * The dev seed ran on every start, in every mode, and wrote rows into tables
 * that belong to the sync stream (`product`, `price`, `stock_snapshot`,
 * `location`, `price_list` — all `localOnly: false`). On a device with a sync
 * stack attached, each of those writes lands in PowerSync's own queue, and
 * PowerSync will not APPLY a downloaded checkpoint while that queue has a
 * head. The tenant's catalogue, price lists and jurisdiction pack streamed to
 * the device and none of it was ever applied, so the counter sat on the
 * price-list gate — "still receiving its price lists … leave it connected" —
 * with the rows it was waiting for already delivered and undelivered.
 *
 * These tests hold both halves of the rule: in sync mode the seed writes no
 * synced table at all, and in local-only mode the offline rehearsal is exactly
 * what it was.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { readCurrencySpec } from '../src/data/queries/config';
import {
  CONFIG_KEY_LOCATION_ID,
  CONFIG_KEY_PRICE_LIST_ID,
  readActivePriceListId,
} from '../src/data/queries/session';
import { seedDevDataIfEmpty } from '../src/data/seed';
import { reconcileDevicePriceList } from '../src/data/session/device-price-list';
import { uuidv7 } from '../src/lib/uuidv7';
import { openTestDb } from './helpers/node-db';

/** Every table the seed touches that the sync stream owns. */
const SYNCED_TABLES = [
  'product',
  'product_uom',
  'unit_of_measure',
  'product_category',
  'price_list_item',
  'stock_snapshot',
  'location',
  'price_list',
] as const;

const NOW = '2026-08-21T09:00:00.000Z';

async function countRows(db: LocalDb, table: string): Promise<number> {
  const rows = await db.getAll(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.['n'] ?? 0);
}

async function configValue(db: LocalDb, key: string): Promise<string | null> {
  const rows = await db.getAll('SELECT value FROM local_config WHERE key = ? LIMIT 1', [key]);
  const value = rows[0]?.['value'];
  return typeof value === 'string' ? value : null;
}

/** A bearer shaped like the API's. Only its presence is read here. */
function devBearer(): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ tid: uuidv7(), uid: uuidv7(), locs: [uuidv7()] })}.sig`;
}

describe('the dev seed on a device that syncs', () => {
  it('writes NOTHING into a table the sync stream owns', async () => {
    const db = openTestDb();

    await seedDevDataIfEmpty(db, { syncConfigured: true });

    // One row in any of these is a permanent download freeze — see the header.
    for (const table of SYNCED_TABLES) {
      expect({ table, rows: await countRows(db, table) }).toEqual({ table, rows: 0 });
    }
  });

  it('points the device at no location and no price list, leaving both to be provisioned', async () => {
    const db = openTestDb();

    await seedDevDataIfEmpty(db, { syncConfigured: true });

    // Placeholder ids naming rows that no longer exist would be worse than
    // nothing: the reconcilers answer both questions from the verified session
    // and the tenant's own configuration.
    expect(await configValue(db, CONFIG_KEY_LOCATION_ID)).toBeNull();
    expect(await configValue(db, CONFIG_KEY_PRICE_LIST_ID)).toBeNull();
  });

  it('still writes the placeholder CurrencySpec, which is local-only and blocks nothing', async () => {
    const db = openTestDb();

    await seedDevDataIfEmpty(db, { syncConfigured: true });

    // `local_config` is localOnly: PowerSync never sees it, so this write
    // cannot freeze a download. It is the floor under a till whose
    // jurisdiction pack has not arrived, and it names no real currency.
    const spec = await readCurrencySpec(db);
    expect(spec).not.toBeNull();
    expect(spec?.code).toBe('XTS');
  });

  it('lets the tenant’s own price list provision the moment its rows arrive', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db, { syncConfigured: true });

    // The device binds to its location from the session (device-location.ts),
    // then the tenant's rows land — which is what used to be impossible.
    const locationId = uuidv7();
    await db.execute(
      `INSERT INTO location (id, tenant_id, code, name, kind, location_type_id, parent_id,
                             is_active, timezone, hlc, updated_at)
       VALUES (?, ?, 'C-1', 'A counter', NULL, NULL, NULL, 1, 'UTC', NULL, NULL)`,
      [locationId, uuidv7()],
    );
    await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      CONFIG_KEY_LOCATION_ID,
      locationId,
    ]);
    const listId = uuidv7();
    await db.execute(
      `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                               priority, location_id, effective_from, effective_to, hlc, updated_at)
       VALUES (?, ?, 'THE-COUNTER-LIST', 'Counter list', 0, 'XTS', 10, NULL, '2026-08-01', NULL, NULL, NULL)`,
      [listId, uuidv7()],
    );

    const state = await reconcileDevicePriceList(db, devBearer(), NOW);

    expect(state.status).toBe('provisioned');
    expect(state.priceListId).toBe(listId);
    expect(await readActivePriceListId(db)).toBe(listId);
  });
});

describe('the dev seed in local-only mode', () => {
  it('is unchanged: the offline rehearsal still has a full floor under it', async () => {
    const db = openTestDb();

    await seedDevDataIfEmpty(db);

    for (const table of SYNCED_TABLES) {
      expect({ table, seeded: (await countRows(db, table)) > 0 }).toEqual({ table, seeded: true });
    }
    expect(await readActivePriceListId(db)).not.toBeNull();
    expect(await configValue(db, CONFIG_KEY_LOCATION_ID)).not.toBeNull();
    expect((await readCurrencySpec(db))?.code).toBe('XTS');
  });

  it('is idempotent — a second run adds nothing', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    const before = await Promise.all(SYNCED_TABLES.map((t) => countRows(db, t)));

    await seedDevDataIfEmpty(db);

    expect(await Promise.all(SYNCED_TABLES.map((t) => countRows(db, t)))).toEqual(before);
  });
});
