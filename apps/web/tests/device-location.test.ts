/**
 * DEVICE ENROLMENT — the two bugs that made every checkout fail with
 * "This device has no location assigned."
 *
 * 1. `writeDeviceLocation` existed and was never called. Enrolment was written
 *    and never wired, so no device ever acquired a location.
 * 2. `seedDevDataIfEmpty` guarded the whole config block on ONE sentinel key
 *    (`currency_spec`). The location keys were added later, so a database
 *    created by an earlier build — and a browser's local database outlives any
 *    number of rebuilds — could never acquire them.
 *
 * And the bug behind them: the dev seed's location was a value generated at
 * module load, matching no location the server knows. Fixing only the wiring
 * would have moved the failure from the counter to `assertLocationInScope`
 * (apps/api/src/trpc.ts), which answers FORBIDDEN for a location outside the
 * token's `locs` claim — a sale refused hours later, at a till, with the
 * customer long gone.
 *
 * So these tests assert the whole rule: the location comes from the VERIFIED
 * SESSION, is never guessed, never invented, and never survives a session that
 * no longer covers it. CLAUDE.md §2.7 category 2 (the client's write path into
 * sync) and §2.6 (location scope).
 */
import { createSaleInput } from '@erp/contracts';
import { describe, expect, it } from 'vitest';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout } from '../src/data/mutations/checkout';
import {
  CONFIG_KEY_CURRENCY_SPEC,
} from '../src/data/queries/config';
import { loadActiveProducts } from '../src/data/queries/products';
import {
  CONFIG_KEY_LOCATION_CODE,
  CONFIG_KEY_LOCATION_ID,
  CONFIG_KEY_PRICE_LIST_ID,
  readDeviceLocation,
  readDeviceLocationId,
} from '../src/data/queries/session';
import { readPendingOps } from '../src/data/sync/upload';
import { readBearerScope } from '../src/data/session/bearer-claims';
import {
  blocksSales,
  chooseDeviceLocation,
  LocationChoiceOutOfScopeError,
  reconcileDeviceLocation,
} from '../src/data/session/device-location';
import { DEV_PLACEHOLDER_CURRENCY, seedDevDataIfEmpty } from '../src/data/seed';
import type { LocalDb } from '../src/data/db';
import { uuidv7 } from '../src/lib/uuidv7';
import { fixedHlc, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A bearer shaped exactly like the API's (apps/api/src/auth.ts): HS256 header,
 * `{ tid, uid, role, locs }` claims. NOT signed — the client only ever decodes
 * it, and the point of these tests is that decoding is all it does.
 */
function devBearer(locs: readonly string[], overrides: Record<string, unknown> = {}): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    tid: uuidv7(),
    uid: uuidv7(),
    role: 'a tenant-defined role name',
    locs,
    ...overrides,
  });
  return `${header}.${payload}.not-a-real-signature`;
}

async function seedLocationRow(
  db: LocalDb,
  id: string,
  code: string,
  name = 'A counter',
): Promise<void> {
  await db.execute(
    `INSERT INTO location (id, tenant_id, code, name, kind, location_type_id, parent_id,
                           is_active, timezone, hlc, updated_at)
     VALUES (?, NULL, ?, ?, NULL, NULL, NULL, 1, 'UTC', NULL, NULL)`,
    [id, code, name],
  );
}

async function configValue(db: LocalDb, key: string): Promise<string | null> {
  const rows = await db.getAll('SELECT value FROM local_config WHERE key = ?', [key]);
  const value = rows[0]?.['value'];
  return typeof value === 'string' ? value : null;
}

async function configRowCount(db: LocalDb, key: string): Promise<number> {
  const rows = await db.getAll('SELECT id FROM local_config WHERE key = ?', [key]);
  return rows.length;
}

/** Ring one line and complete the sale; returns the uploaded payload. */
async function sellOneLine(db: LocalDb): Promise<Record<string, unknown>> {
  const products = await loadActiveProducts(db);
  const product = products[0];
  if (product === undefined) throw new Error('no product to sell');
  const cartId = await createCart(db, { nowIso: '2026-08-21T09:00:00.000Z' });
  await addProductToCart(db, cartId, product);
  await checkout(db, {
    cartId,
    tenderedMinor: 100_000_000n,
    hlc: fixedHlc(),
    nowIso: '2026-08-21T09:05:00.000Z',
  });
  const queue = await readPendingOps(db);
  const entry = queue[0];
  if (entry === undefined) throw new Error('nothing in the outbox');
  const payload: unknown = JSON.parse(entry.payloadJson);
  // The bytes the API parses — proven against the API's own schema, not a copy.
  expect(createSaleInput.safeParse(payload).success).toBe(true);
  return payload as Record<string, unknown>;
}

/**
 * A local database as an EARLIER BUILD left it: the currency spec is there
 * (that build knew about it) and the location keys are not (that build had not
 * been written yet). Its catalogue and its price list are real rows with the
 * random ids that build minted. This is the user's browser.
 */
async function oldBuildDatabase(): Promise<LocalDb> {
  const db = openTestDb();
  const oldLocationId = uuidv7();
  const oldPriceListId = uuidv7();
  await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
    uuidv7(),
    CONFIG_KEY_CURRENCY_SPEC,
    JSON.stringify(DEV_PLACEHOLDER_CURRENCY),
  ]);
  await seedLocationRow(db, oldLocationId, 'LOC1', 'Development counter');
  await db.execute(
    `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                             priority, location_id, effective_from, effective_to, hlc, updated_at)
     VALUES (?, NULL, 'DEFAULT', ?, 0, 'XTS', 0, NULL, NULL, NULL, NULL, NULL)`,
    [oldPriceListId, 'Development price list'],
  );
  await seedProduct(db, {
    code: 'OLD-1',
    name: 'A product from an older build',
    unitPriceE4: 620_000_000n,
    priceListId: oldPriceListId,
  });
  return db;
}

// ---------------------------------------------------------------------------
// Reading the device's own bearer — decode only, never verify
// ---------------------------------------------------------------------------

describe('the session scope this device reads off its own bearer', () => {
  it('reports no session at all when there is no bearer', () => {
    expect(readBearerScope(null)).toEqual({ kind: 'absent' });
    expect(readBearerScope(undefined)).toEqual({ kind: 'absent' });
    expect(readBearerScope('   ')).toEqual({ kind: 'absent' });
  });

  it('reads the locs claim without verifying anything', () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(readBearerScope(devBearer([a, b]))).toEqual({ kind: 'scoped', locationIds: [a, b] });
  });

  it('collapses a duplicate in the claim: one location is not two choices', () => {
    const a = uuidv7();
    expect(readBearerScope(devBearer([a, a]))).toEqual({ kind: 'scoped', locationIds: [a] });
  });

  it('never turns an unreadable token into an empty scope', () => {
    // Empty and unreadable are different problems with different fixes.
    for (const bad of [
      'not-a-token',
      'only.two',
      `${Buffer.from('{}').toString('base64url')}.%%%.sig`,
      devBearer([]).replace(/\.[^.]+\./, '.bm90LWpzb24.'),
    ]) {
      expect(readBearerScope(bad).kind).toBe('unreadable');
    }
  });

  it('refuses a token with no locs claim, rather than assuming none', () => {
    const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    const token = `${b64({ alg: 'HS256' })}.${b64({ tid: uuidv7(), uid: uuidv7() })}.sig`;
    expect(readBearerScope(token).kind).toBe('unreadable');
  });

  it('refuses a locs entry it cannot identify as a location', () => {
    expect(readBearerScope(devBearer(['not-a-uuid'])).kind).toBe('unreadable');
    const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    const token = `${b64({ alg: 'HS256' })}.${b64({ locs: 'one-location' })}.sig`;
    expect(readBearerScope(token).kind).toBe('unreadable');
  });
});

// ---------------------------------------------------------------------------
// Provisioning from the session
// ---------------------------------------------------------------------------

describe('a device provisions itself from its session', () => {
  it('binds itself with no manual step when the session names exactly one location', async () => {
    const db = openTestDb();
    const locationId = uuidv7();
    await seedLocationRow(db, locationId, 'C-1');

    const state = await reconcileDeviceLocation(db, devBearer([locationId]));

    expect(state.status).toBe('provisioned');
    expect(state.locationId).toBe(locationId);
    expect(blocksSales(state)).toBe(false);
    expect(await readDeviceLocationId(db)).toBe(locationId);
    // The synced row's code rides along, so the first receipt is not blank.
    expect(await readDeviceLocation(db)).toEqual({ id: locationId, code: 'C-1', timeZone: 'UTC' });
  });

  it('provisions before the location row has synced, and fills the code in later', async () => {
    const db = openTestDb();
    const locationId = uuidv7();

    const state = await reconcileDeviceLocation(db, devBearer([locationId]));
    expect(state.status).toBe('provisioned');
    expect(await readDeviceLocation(db)).toEqual({ id: locationId, code: '', timeZone: null });

    await seedLocationRow(db, locationId, 'C-9');
    expect((await readDeviceLocation(db))?.code).toBe('C-9');
  });

  it('REFUSES and does not guess when the session covers more than one location', async () => {
    const db = openTestDb();
    const first = uuidv7();
    const second = uuidv7();
    await seedLocationRow(db, first, 'C-1', 'First counter');
    await seedLocationRow(db, second, 'C-2', 'Second counter');

    const state = await reconcileDeviceLocation(db, devBearer([first, second]));

    expect(state.status).toBe('ambiguous');
    expect(state.locationId).toBeNull();
    expect(blocksSales(state)).toBe(true);
    // Not the first one. Not any one. Nothing was written.
    expect(await readDeviceLocationId(db)).toBeNull();
    // The choice is NAMED — a counter cannot act on "something is wrong".
    expect(state.choices.map((c) => c.id)).toEqual([first, second]);
    expect(state.message).toContain('First counter');
    expect(state.message).toContain('Second counter');
    expect(state.message).toContain('2 locations');
  });

  it('fails closed, and says specifically that the session covers NO location', async () => {
    const db = openTestDb();

    const state = await reconcileDeviceLocation(db, devBearer([]));

    expect(state.status).toBe('unscoped');
    expect(state.locationId).toBeNull();
    expect(blocksSales(state)).toBe(true);
    expect(await readDeviceLocationId(db)).toBeNull();
    expect(state.message).toContain('no location');
    // Distinguishable from the ambiguous case: the two need different actions.
    expect(state.message).not.toContain('Choose one');
  });

  it('reconciles a stored location that the session no longer covers', async () => {
    const db = openTestDb();
    const stale = uuidv7();
    const current = uuidv7();
    await seedLocationRow(db, stale, 'OLD', 'The previous counter');
    await seedLocationRow(db, current, 'NEW', 'The current counter');
    await reconcileDeviceLocation(db, devBearer([stale]));
    expect(await readDeviceLocationId(db)).toBe(stale);

    const state = await reconcileDeviceLocation(db, devBearer([current]));

    expect(state.status).toBe('reconciled');
    expect(state.replacedLocationId).toBe(stale);
    expect(state.locationId).toBe(current);
    expect(await readDeviceLocationId(db)).toBe(current);
    // It says so — the device is not quietly trading somewhere else.
    expect(state.message).not.toBeNull();
  });

  it('never leaves the previous location’s code on a re-bound device', async () => {
    const db = openTestDb();
    const stale = uuidv7();
    const current = uuidv7();
    await seedLocationRow(db, stale, 'OLD');
    await reconcileDeviceLocation(db, devBearer([stale]));
    expect(await configValue(db, CONFIG_KEY_LOCATION_CODE)).toBe('OLD');

    // The new location's row has not synced yet: no code is knowable. The old
    // one must NOT stand in for it — it would be printed on every receipt.
    await reconcileDeviceLocation(db, devBearer([current]));

    expect(await configValue(db, CONFIG_KEY_LOCATION_CODE)).toBeNull();
    expect(await readDeviceLocation(db)).toEqual({ id: current, code: '', timeZone: null });
  });

  it('discards a stored location the session dropped, even with nothing to replace it', async () => {
    const db = openTestDb();
    const stale = uuidv7();
    await seedLocationRow(db, stale, 'OLD');
    await reconcileDeviceLocation(db, devBearer([stale]));

    const state = await reconcileDeviceLocation(db, devBearer([]));

    expect(state.status).toBe('unscoped');
    expect(state.replacedLocationId).toBe(stale);
    expect(await readDeviceLocationId(db)).toBeNull();
  });

  it('keeps a stored location the session still covers, even among several', async () => {
    const db = openTestDb();
    const first = uuidv7();
    const second = uuidv7();
    await seedLocationRow(db, second, 'C-2');
    await chooseDeviceLocation(db, devBearer([first, second]), second);

    const state = await reconcileDeviceLocation(db, devBearer([first, second]));

    expect(state.status).toBe('confirmed');
    expect(state.locationId).toBe(second);
    expect(blocksSales(state)).toBe(false);
  });

  it('clears a stored location that a multi-location session does not cover', async () => {
    const db = openTestDb();
    const stale = uuidv7();
    const first = uuidv7();
    const second = uuidv7();
    await reconcileDeviceLocation(db, devBearer([stale]));

    const state = await reconcileDeviceLocation(db, devBearer([first, second]));

    expect(state.status).toBe('ambiguous');
    expect(state.replacedLocationId).toBe(stale);
    expect(await readDeviceLocationId(db)).toBeNull();
  });

  it('reconciles on EVERY start, and writes nothing when nothing changed', async () => {
    const db = openTestDb();
    const locationId = uuidv7();
    await seedLocationRow(db, locationId, 'C-1');
    const token = devBearer([locationId]);

    expect((await reconcileDeviceLocation(db, token)).status).toBe('provisioned');
    expect((await reconcileDeviceLocation(db, token)).status).toBe('confirmed');
    expect((await reconcileDeviceLocation(db, token)).status).toBe('confirmed');

    expect(await configRowCount(db, CONFIG_KEY_LOCATION_ID)).toBe(1);
    expect(await configRowCount(db, CONFIG_KEY_LOCATION_CODE)).toBe(1);
  });

  it('reports an unreadable session without closing a till that already works', async () => {
    const db = openTestDb();
    const locationId = uuidv7();
    await seedLocationRow(db, locationId, 'C-1');
    await reconcileDeviceLocation(db, devBearer([locationId]));

    const state = await reconcileDeviceLocation(db, 'not-a-token');

    expect(state.status).toBe('session-unreadable');
    expect(state.locationId).toBe(locationId);
    expect(blocksSales(state)).toBe(false);
    expect(state.message).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The selection path — the only way a multi-location device gets bound
// ---------------------------------------------------------------------------

describe('the selection path for an ambiguous session', () => {
  it('binds the device to the chosen location and re-runs the same policy', async () => {
    const db = openTestDb();
    const first = uuidv7();
    const second = uuidv7();
    await seedLocationRow(db, first, 'C-1');
    await seedLocationRow(db, second, 'C-2');
    const token = devBearer([first, second]);

    const state = await chooseDeviceLocation(db, token, second);

    expect(state.status).toBe('confirmed');
    expect(state.locationId).toBe(second);
    expect(await configValue(db, CONFIG_KEY_LOCATION_CODE)).toBe('C-2');
  });

  it('refuses a location the session does not cover — the server would too', async () => {
    const db = openTestDb();
    const inScope = uuidv7();
    const elsewhere = uuidv7();

    await expect(chooseDeviceLocation(db, devBearer([inScope]), elsewhere)).rejects.toBeInstanceOf(
      LocationChoiceOutOfScopeError,
    );
    expect(await readDeviceLocationId(db)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The dev seed — backfill-safe, and never the authority in sync mode
// ---------------------------------------------------------------------------

describe('the dev seed backfills each config key independently', () => {
  it('heals a database an older build created, which can then sell', async () => {
    const db = await oldBuildDatabase();
    // The exact symptom the user reported: currency present, location absent.
    expect(await configValue(db, CONFIG_KEY_CURRENCY_SPEC)).not.toBeNull();
    expect(await readDeviceLocationId(db)).toBeNull();

    await seedDevDataIfEmpty(db);

    const locationId = await readDeviceLocationId(db);
    expect(locationId).not.toBeNull();
    expect(await configValue(db, CONFIG_KEY_PRICE_LIST_ID)).not.toBeNull();
    // And it can trade: the healed configuration names rows that exist, so the
    // price list resolves to a CODE and the payload satisfies the contract.
    const payload = await sellOneLine(db);
    expect(payload['locationId']).toBe(locationId);
    expect(payload['priceListCode']).toBe('DEFAULT');
  });

  it('adopts the rows an older build left rather than stranding its prices', async () => {
    const db = await oldBuildDatabase();
    const before = await db.getAll('SELECT id FROM price_list');

    await seedDevDataIfEmpty(db);

    // One price list, still the old one — the seeded products' prices hang off
    // it, and a second list beside it would leave the device pointed at rows
    // with no prices at all.
    const after = await db.getAll('SELECT id FROM price_list');
    expect(after.length).toBe(before.length);
    expect(await configValue(db, CONFIG_KEY_PRICE_LIST_ID)).toBe(String(before[0]?.['id']));
  });

  it('seeds a device that has nothing, and is safe to run again', async () => {
    const db = openTestDb();

    await seedDevDataIfEmpty(db);
    await seedDevDataIfEmpty(db);
    await seedDevDataIfEmpty(db);

    for (const key of [
      CONFIG_KEY_CURRENCY_SPEC,
      CONFIG_KEY_LOCATION_ID,
      CONFIG_KEY_LOCATION_CODE,
      CONFIG_KEY_PRICE_LIST_ID,
    ]) {
      expect(await configRowCount(db, key)).toBe(1);
    }
    expect((await db.getAll('SELECT id FROM location')).length).toBe(1);
    expect((await db.getAll('SELECT id FROM price_list')).length).toBe(1);
  });

  it('never overwrites a value the device already holds', async () => {
    const db = openTestDb();
    const chosen = uuidv7();
    await seedLocationRow(db, chosen, 'C-7');
    await chooseDeviceLocation(db, devBearer([chosen]), chosen);

    await seedDevDataIfEmpty(db);

    expect(await readDeviceLocationId(db)).toBe(chosen);
  });
});

// ---------------------------------------------------------------------------
// The ordering that makes the second bug harmless
// ---------------------------------------------------------------------------

describe('seed first, session second — the session wins', () => {
  it('replaces the dev-seeded location with the one the token is scoped to', async () => {
    const db = openTestDb();
    // Startup order, exactly as main.tsx runs it.
    await seedDevDataIfEmpty(db);
    const seeded = await readDeviceLocationId(db);
    expect(seeded).not.toBeNull();

    const sessionLocation = uuidv7();
    await seedLocationRow(db, sessionLocation, 'C-3', 'The real counter');
    const state = await reconcileDeviceLocation(db, devBearer([sessionLocation]));

    expect(state.status).toBe('reconciled');
    expect(state.replacedLocationId).toBe(seeded);
    expect(await readDeviceLocationId(db)).toBe(sessionLocation);

    // The sale is filed against the TOKEN's location. Against the seeded one
    // the API's assertLocationInScope would answer FORBIDDEN, every time.
    const payload = await sellOneLine(db);
    expect(payload['locationId']).toBe(sessionLocation);
    expect(payload['locationId']).not.toBe(seeded);
  });

  it('will not trade on a dev-seeded location when the session is ambiguous', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    const seeded = await readDeviceLocationId(db);

    const state = await reconcileDeviceLocation(db, devBearer([uuidv7(), uuidv7()]));

    expect(state.status).toBe('ambiguous');
    expect(state.replacedLocationId).toBe(seeded);
    expect(await readDeviceLocationId(db)).toBeNull();
    expect(blocksSales(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Local-only mode — the offline rehearsal, and it must not regress
// ---------------------------------------------------------------------------

describe('local-only mode, with no token at all', () => {
  it('seeds, provisions and sells with zero backend', async () => {
    const db = openTestDb();

    await seedDevDataIfEmpty(db);
    const state = await reconcileDeviceLocation(db, null);

    expect(state.status).toBe('local-only');
    expect(state.locationId).toBe(await readDeviceLocationId(db));
    expect(state.message).toBeNull();
    expect(blocksSales(state)).toBe(false);

    const payload = await sellOneLine(db);
    expect(payload['locationId']).toBe(state.locationId);
  });

  it('leaves a locally chosen location alone — there is no session to reconcile to', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    const seeded = await readDeviceLocationId(db);

    const state = await reconcileDeviceLocation(db, null);

    expect(state.locationId).toBe(seeded);
    expect(await readDeviceLocationId(db)).toBe(seeded);
  });
});
