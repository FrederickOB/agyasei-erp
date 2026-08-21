/**
 * The backstop for the freeze in dev-seed.test.ts: whatever put a write into
 * PowerSync's queue, the queue gets emptied and the writes get REPORTED, so a
 * device downloads again instead of waiting on a gate that can never clear.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import {
  discardStrayCrud,
  holdsUnsyncedSeedRows,
  type StrayCrudEntry,
  type StrayCrudSource,
} from '../src/data/sync/crud-guard';
import { seedDevDataIfEmpty } from '../src/data/seed';
import { uuidv7 } from '../src/lib/uuidv7';
import { openTestDb } from './helpers/node-db';

/** A queue that behaves like PowerSync's: FIFO, and `complete()` removes. */
function fakeQueue(entries: readonly StrayCrudEntry[]): StrayCrudSource & { remaining: () => number } {
  let queue = [...entries];
  return {
    remaining: () => queue.length,
    async getCrudBatch(limit = 100) {
      if (queue.length === 0) return null;
      const batch = queue.slice(0, limit);
      return {
        crud: batch,
        async complete() {
          queue = queue.slice(batch.length);
        },
      };
    },
  };
}

function entry(table: string, op = 'PUT'): StrayCrudEntry {
  return { op, table, id: uuidv7() };
}

describe('draining a stray PowerSync write queue', () => {
  it('empties it and reports every entry it drops', async () => {
    const queue = fakeQueue([entry('price_list'), entry('product'), entry('location', 'DELETE')]);
    const reported: StrayCrudEntry[] = [];

    const discarded = await discardStrayCrud(queue, (e) => reported.push(e));

    expect(discarded).toBe(3);
    expect(queue.remaining()).toBe(0);
    // Nothing vanishes quietly: a discarded write is a bug upstream, and the
    // report is the only trace of what it was.
    expect(reported.map((e) => `${e.op} ${e.table}`)).toEqual([
      'PUT price_list',
      'PUT product',
      'DELETE location',
    ]);
  });

  it('drains a queue longer than one batch', async () => {
    const queue = fakeQueue(Array.from({ length: 250 }, () => entry('product')));

    expect(await discardStrayCrud(queue, () => undefined)).toBe(250);
    expect(queue.remaining()).toBe(0);
  });

  it('does nothing, loudly or otherwise, on a healthy device', async () => {
    const reported: StrayCrudEntry[] = [];

    // The normal case, every second, forever: the queue is empty because the
    // sale path writes the outbox and nothing writes a synced table.
    expect(await discardStrayCrud(fakeQueue([]), (e) => reported.push(e))).toBe(0);
    expect(reported).toEqual([]);
  });

  it('gives up rather than spinning when the queue refuses to drain', async () => {
    // A `complete()` that silently did nothing would otherwise loop forever on
    // the startup path — a hung till is worse than a reported one.
    const stuck: StrayCrudSource = {
      async getCrudBatch() {
        return { crud: [entry('product')], complete: async () => undefined };
      },
    };

    const discarded = await discardStrayCrud(stuck, () => undefined);

    expect(discarded).toBe(100);
  });
});

describe('spotting a device frozen by an earlier build', () => {
  it('recognises the dev seed’s rows in the synced tables', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);

    // Exactly the database an older build left behind, and exactly the one
    // that has to have its synced half thrown away and re-downloaded.
    expect(await holdsUnsyncedSeedRows(db)).toBe(true);
  });

  it('leaves a device whose rows all came from the stream alone', async () => {
    const db = openTestDb();
    await seedSyncedRows(db);

    expect(await holdsUnsyncedSeedRows(db)).toBe(false);
  });

  it('leaves a device with nothing on it alone', async () => {
    expect(await holdsUnsyncedSeedRows(openTestDb())).toBe(false);
  });

  it('is not fooled by a device holding both', async () => {
    const db = openTestDb();
    await seedSyncedRows(db);
    await seedDevDataIfEmpty(db);

    expect(await holdsUnsyncedSeedRows(db)).toBe(true);
  });
});

/** Rows as the sync stream delivers them: every one carries a tenant_id. */
async function seedSyncedRows(db: LocalDb): Promise<void> {
  const tenantId = uuidv7();
  await db.execute(
    `INSERT INTO location (id, tenant_id, code, name, kind, location_type_id, parent_id,
                           is_active, timezone, hlc, updated_at)
     VALUES (?, ?, 'C-1', 'A counter', NULL, NULL, NULL, 1, 'UTC', NULL, NULL)`,
    [uuidv7(), tenantId],
  );
  await db.execute(
    `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                             priority, location_id, effective_from, effective_to, hlc, updated_at)
     VALUES (?, ?, 'A-LIST', 'A list', 0, 'XTS', 10, NULL, '2026-08-01', NULL, NULL, NULL)`,
    [uuidv7(), tenantId],
  );
  await db.execute(
    `INSERT INTO product (id, tenant_id, sku_code, name, aliases, category_id, stocking_uom_id,
                          tax_code, stock_tracking, is_sellable, is_purchasable, hlc, updated_at)
     VALUES (?, ?, 'P-1', 'A product', NULL, NULL, NULL, NULL, NULL, 1, 1, NULL, NULL)`,
    [uuidv7(), tenantId],
  );
}
