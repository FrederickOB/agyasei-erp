/**
 * DEVICE PRICE-LIST PROVISIONING — the bug that let a sale be recorded at the
 * counter and then refused at upload.
 *
 * `writeActivePriceListId` existed and was never called. The only writer of
 * `local_config.price_list_id` was the DEV SEED, which points it at a
 * placeholder list coded 'DEFAULT'. In sync mode that meant every sale went up
 * carrying `priceListCode: 'DEFAULT'`, a code no tenant has, and the API
 * answered PRECONDITION_FAILED — `no price list DEFAULT in force`. Verified
 * against the running stack: tenant #1's lists are RETAIL and WHOLESALE.
 *
 * The same shape as the device-location bug (see device-location.test.ts), but
 * the answer comes from somewhere else and that difference is the whole design.
 * A location is in the TOKEN, so it is knowable the instant the device boots.
 * A price list is in SYNCED ROWS — `price_list.priority` ("low wins"),
 * `.location_id` ("NULL = whole tenant") and its effective window — so it may
 * not be knowable yet, and "not yet" must be a wait, not a refusal.
 *
 * So these tests assert the whole rule: the default comes from the TENANT'S
 * OWN CONFIGURATION, is never guessed, never invented, never resolves to the
 * dev seed's placeholder once a device has a session, and never survives
 * configuration that stops offering it. CLAUDE.md §2.7 category 2 (the
 * client's write path into sync) and §2.9 (nothing branches on tenant
 * identity — no list code appears in the resolver).
 */
import { createSaleInput } from '@erp/contracts';
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout, SaleContextIncompleteError } from '../src/data/mutations/checkout';
import { getCartLines } from '../src/data/queries/cart';
import { loadActiveProducts } from '../src/data/queries/products';
import {
  CONFIG_KEY_LOCATION_CODE,
  CONFIG_KEY_LOCATION_ID,
  CONFIG_KEY_PRICE_LIST_ID,
  readActivePriceListId,
} from '../src/data/queries/session';
import { seedDevDataIfEmpty } from '../src/data/seed';
import {
  blocksSale,
  blocksSales,
  chooseDevicePriceList,
  PriceListChoiceNotOfferedError,
  readPriceListCandidates,
  reconcileDevicePriceList,
  resolveCartPriceList,
} from '../src/data/session/device-price-list';
import { readPendingOps } from '../src/data/sync/upload';
import { uuidv7 } from '../src/lib/uuidv7';
import { fixedHlc, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The trading day every test runs on, and the day the fixtures are in force. */
const TODAY = '2026-08-21';
const NOW = `${TODAY}T09:00:00.000Z`;

/**
 * A bearer shaped exactly like the API's (apps/api/src/auth.ts). Only its
 * PRESENCE matters to this module — there is no price-list claim, which is
 * precisely why the answer has to come from configuration instead.
 */
function devBearer(locs: readonly string[]): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ tid: uuidv7(), uid: uuidv7(), role: 'a tenant-defined role', locs });
  return `${header}.${payload}.not-a-real-signature`;
}

/** Bind the device to a location, the way enrolment leaves it. */
async function provisionLocation(db: LocalDb, timeZone = 'UTC'): Promise<string> {
  const id = uuidv7();
  await db.execute(
    `INSERT INTO location (id, tenant_id, code, name, kind, location_type_id, parent_id,
                           is_active, timezone, hlc, updated_at)
     VALUES (?, ?, 'C-1', 'A counter', NULL, NULL, NULL, 1, ?, NULL, NULL)`,
    [id, uuidv7(), timeZone],
  );
  for (const [key, value] of [
    [CONFIG_KEY_LOCATION_ID, id],
    [CONFIG_KEY_LOCATION_CODE, 'C-1'],
  ] as const) {
    await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      key,
      value,
    ]);
  }
  return id;
}

interface ListFixture {
  readonly code: string;
  readonly name?: string;
  readonly priority: number;
  /** null = whole tenant, the server's own meaning for the column. */
  readonly locationId?: string | null;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  /** Omit the tenant_id to imitate a row the sync stream did NOT deliver. */
  readonly synced?: boolean;
  /** Shelf prices that already contain tax — the tenant's own choice per list. */
  readonly taxInclusive?: boolean;
}

/** A price list as the sync stream delivers it: WITH a tenant_id. */
async function seedPriceList(db: LocalDb, list: ListFixture): Promise<string> {
  const id = uuidv7();
  await db.execute(
    `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                             priority, location_id, effective_from, effective_to, hlc, updated_at)
     VALUES (?, ?, ?, ?, CAST(? AS INTEGER), 'XTS', CAST(? AS INTEGER), ?, ?, ?, NULL, NULL)`,
    [
      id,
      list.synced === false ? null : uuidv7(),
      list.code,
      list.name ?? `The ${list.code} list`,
      list.taxInclusive === true ? '1' : '0',
      String(list.priority),
      list.locationId ?? null,
      list.effectiveFrom ?? '2026-08-01',
      list.effectiveTo ?? null,
    ],
  );
  return id;
}

async function configValue(db: LocalDb, key: string): Promise<string | null> {
  const rows = await db.getAll('SELECT value FROM local_config WHERE key = ?', [key]);
  const value = rows[0]?.['value'];
  return typeof value === 'string' ? value : null;
}

/** Point the device at a list without going through the policy under test. */
async function storePriceListId(db: LocalDb, id: string): Promise<void> {
  await db.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_PRICE_LIST_ID]);
  await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
    uuidv7(),
    CONFIG_KEY_PRICE_LIST_ID,
    id,
  ]);
}

async function seedSellableProduct(db: LocalDb, priceListId: string): Promise<void> {
  // Through the shared fixture, which writes the shape the sync stream
  // delivers — the only shape the counter's projection reads.
  await seedProduct(db, { code: 'P-1', name: 'A product', unitPriceE4: 620_000_000n, priceListId });
}

/** Ring one line and complete the sale; returns the uploaded payload. */
async function sellOneLine(db: LocalDb): Promise<Record<string, unknown>> {
  const products = await loadActiveProducts(db);
  const product = products[0];
  if (product === undefined) throw new Error('no product to sell');
  const cartId = await createCart(db, { nowIso: NOW });
  await addProductToCart(db, cartId, product);
  await checkout(db, { cartId, tenderedMinor: 100_000_000n, hlc: fixedHlc(), nowIso: NOW });
  const entry = (await readPendingOps(db))[0];
  if (entry === undefined) throw new Error('nothing in the outbox');
  const payload: unknown = JSON.parse(entry.payloadJson);
  // The bytes the API parses — proven against the API's own schema, not a copy.
  expect(createSaleInput.safeParse(payload).success).toBe(true);
  return payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The candidate set — what the tenant's configuration offers at this counter
// ---------------------------------------------------------------------------

describe('the price lists a counter may sell from', () => {
  it('ranks by the tenant’s own priority, lowest first', async () => {
    const db = openTestDb();
    const locationId = await provisionLocation(db);
    await seedPriceList(db, { code: 'WHOLESALE', priority: 20 });
    await seedPriceList(db, { code: 'RETAIL', priority: 10 });

    const candidates = await readPriceListCandidates(db, locationId, TODAY);

    expect(candidates.map((c) => c.code)).toEqual(['RETAIL', 'WHOLESALE']);
  });

  it('offers a tenant-wide list and this location’s own, and no other location’s', async () => {
    const db = openTestDb();
    const locationId = await provisionLocation(db);
    await seedPriceList(db, { code: 'TENANT-WIDE', priority: 30, locationId: null });
    await seedPriceList(db, { code: 'HERE', priority: 20, locationId });
    await seedPriceList(db, { code: 'ELSEWHERE', priority: 10, locationId: uuidv7() });

    const candidates = await readPriceListCandidates(db, locationId, TODAY);

    // ELSEWHERE ranks best of the three and is still not offered: scope
    // decides WHICH lists are candidates, priority only orders them.
    expect(candidates.map((c) => c.code)).toEqual(['HERE', 'TENANT-WIDE']);
  });

  it('excludes a list that is not in force on the trading day', async () => {
    const db = openTestDb();
    const locationId = await provisionLocation(db);
    await seedPriceList(db, { code: 'NOT-YET', priority: 1, effectiveFrom: '2026-09-01' });
    await seedPriceList(db, { code: 'LAPSED', priority: 2, effectiveTo: '2026-08-01' });
    await seedPriceList(db, { code: 'IN-FORCE', priority: 3 });

    expect((await readPriceListCandidates(db, locationId, TODAY)).map((c) => c.code)).toEqual([
      'IN-FORCE',
    ]);
  });

  it('treats effective_to as EXCLUSIVE, exactly as the API does', async () => {
    // apps/api/src/routers/sales.ts: `effective_to is null or effective_to > $date`.
    // A device that disagreed by one day would price against a list the server
    // then refuses — on the one day of the year it matters.
    const db = openTestDb();
    const locationId = await provisionLocation(db);
    await seedPriceList(db, { code: 'ENDS-TODAY', priority: 1, effectiveTo: TODAY });
    await seedPriceList(db, { code: 'ENDS-TOMORROW', priority: 2, effectiveTo: '2026-08-22' });

    expect((await readPriceListCandidates(db, locationId, TODAY)).map((c) => c.code)).toEqual([
      'ENDS-TOMORROW',
    ]);
  });

  it('never offers a list the sync stream did not deliver', async () => {
    const db = openTestDb();
    const locationId = await provisionLocation(db);
    // The dev seed's shape: no tenant_id, so not tenant configuration.
    await seedPriceList(db, { code: 'DEFAULT', priority: 0, synced: false });

    expect(await readPriceListCandidates(db, locationId, TODAY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation — the policy that binds, refuses, or waits
// ---------------------------------------------------------------------------

describe('binding a device to the price list its tenant configured', () => {
  it('provisions the best-ranked list when the device has none', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    const retail = await seedPriceList(db, { code: 'RETAIL', priority: 10 });
    await seedPriceList(db, { code: 'WHOLESALE', priority: 20 });

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('provisioned');
    expect(state.priceListId).toBe(retail);
    expect(await readActivePriceListId(db)).toBe(retail);
    expect(blocksSales(state)).toBe(false);
  });

  it('replaces a stored list the configuration no longer offers, and says so', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    const lapsed = await seedPriceList(db, { code: 'OLD', priority: 5, effectiveTo: '2026-08-10' });
    const current = await seedPriceList(db, { code: 'NEW', priority: 10 });
    await storePriceListId(db, lapsed);

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('reconciled');
    expect(state.priceListId).toBe(current);
    expect(state.replacedPriceListId).toBe(lapsed);
    expect(state.message).toContain('NEW');
    expect(await readActivePriceListId(db)).toBe(current);
  });

  it('leaves a stored list alone when configuration still offers it', async () => {
    // A stored list that is still offered is either the default this policy
    // bound last time or a choice a human made at this counter. Re-pointing it
    // at the best-ranked list every morning would undo the second silently.
    const db = openTestDb();
    await provisionLocation(db);
    await seedPriceList(db, { code: 'RETAIL', priority: 10 });
    const wholesale = await seedPriceList(db, { code: 'WHOLESALE', priority: 20 });
    await storePriceListId(db, wholesale);

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('confirmed');
    expect(state.priceListId).toBe(wholesale);
  });

  it('refuses and names the choice when two lists are ranked the same', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    await seedPriceList(db, { code: 'RETAIL', name: 'Counter retail', priority: 10 });
    await seedPriceList(db, { code: 'WHOLESALE', name: 'Contractor', priority: 10 });
    await seedPriceList(db, { code: 'CLEARANCE', priority: 50 });

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('ambiguous');
    expect(state.priceListId).toBeNull();
    expect(blocksSales(state)).toBe(true);
    // Only the tied lists are the choice. CLEARANCE is not ambiguous with
    // anything — it simply lost.
    expect(state.choices.map((c) => c.code).sort()).toEqual(['RETAIL', 'WHOLESALE']);
    expect(state.message).toContain('Counter retail (RETAIL)');
    expect(state.message).toContain('Contractor (WHOLESALE)');
  });

  it('waits, rather than failing, while the tenant’s lists are still arriving', async () => {
    const db = openTestDb();
    await provisionLocation(db);

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    // Nothing is wrong and nobody needs to do anything — the rows are on their
    // way. This is a different sentence, for a different person, than the one
    // below, and conflating them sends a cashier off to fix nothing.
    expect(state.status).toBe('awaiting-config');
    expect(blocksSales(state)).toBe(true);
    expect(state.message).toContain('still receiving');
  });

  it('fails closed when lists exist but none covers this counter today', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    await seedPriceList(db, { code: 'ELSEWHERE', priority: 10, locationId: uuidv7() });

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('unconfigured');
    expect(blocksSales(state)).toBe(true);
  });

  it('has no answer, and says which question is unanswered, with no location', async () => {
    const db = openTestDb();
    await seedPriceList(db, { code: 'RETAIL', priority: 10 });

    const state = await reconcileDevicePriceList(db, devBearer([]), NOW);

    expect(state.status).toBe('location-unknown');
    expect(blocksSales(state)).toBe(true);
    expect(state.message).toContain('location');
  });

  it('derives the trading day in the LOCATION’s timezone, not the tablet’s', async () => {
    // 2026-08-21T23:30Z is already the 22nd in Kiritimati (UTC+14). A list that
    // lapses at the 22nd must be gone for that counter, on its own clock.
    const db = openTestDb();
    await provisionLocation(db, 'Pacific/Kiritimati');
    await seedPriceList(db, { code: 'ENDS-22ND', priority: 10, effectiveTo: '2026-08-22' });
    await seedPriceList(db, { code: 'OPEN-ENDED', priority: 20 });

    const state = await reconcileDevicePriceList(
      db,
      devBearer([uuidv7()]),
      '2026-08-21T23:30:00.000Z',
    );

    expect(state.status).toBe('provisioned');
    expect(state.choices).toEqual([]);
    const chosen = await db.getAll('SELECT code FROM price_list WHERE id = ?', [state.priceListId]);
    expect(chosen[0]?.['code']).toBe('OPEN-ENDED');
  });
});

// ---------------------------------------------------------------------------
// The dev seed's placeholder is local-only — the core of the reported bug
// ---------------------------------------------------------------------------

describe('the dev seed’s placeholder list', () => {
  it('is what a local-only device sells from, untouched', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    const seeded = await readActivePriceListId(db);

    // No bearer: there is no tenant configuration to reconcile against, and
    // the offline rehearsal must not regress.
    const state = await reconcileDevicePriceList(db, null, NOW);

    expect(state.status).toBe('local-only');
    expect(state.priceListId).toBe(seeded);
    expect(blocksSales(state)).toBe(false);
    expect((await sellOneLine(db))['priceListCode']).toBe('DEFAULT');
  });

  it('can never be what a device WITH a session prices against', async () => {
    // THE REPORTED BUG. The seed runs first (main.tsx step 1) and points the
    // device at 'DEFAULT'; a device with a session must not keep it, whatever
    // its ranking — here it ranks 0, better than anything the tenant has.
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    await provisionLocation(db);
    const retail = await seedPriceList(db, { code: 'RETAIL', priority: 10 });
    expect(await configValue(db, CONFIG_KEY_PRICE_LIST_ID)).not.toBe(retail);

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('reconciled');
    expect(state.priceListId).toBe(retail);
    await seedSellableProduct(db, retail);
    // The code that goes up the wire is the TENANT's, not the placeholder's.
    expect((await sellOneLine(db))['priceListCode']).toBe('RETAIL');
  });

  it('is cleared, not left to be rung against, when nothing can replace it yet', async () => {
    // The seed's list is gone and the tenant's have not arrived. The device
    // must not sell against 'DEFAULT' in the meantime: an empty cart list
    // makes checkout refuse AT THE COUNTER instead of the API refusing hours
    // later, after the customer has walked out with the goods.
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    await provisionLocation(db);

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('awaiting-config');
    expect(await readActivePriceListId(db)).toBeNull();
    // Nothing is even OFFERED: the counter's catalogue is priced from the
    // device's own list, so with no list there is no shelf to ring from.
    expect(await loadActiveProducts(db, NOW)).toEqual([]);
    // And a cart minted AFTER the clear carries no list, so checkout refuses
    // at the counter rather than the API refusing hours later.
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 620_000_000n,
    });
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, product);
    await expect(
      checkout(db, { cartId, tenderedMinor: 100_000_000n, hlc: fixedHlc(), nowIso: NOW }),
    ).rejects.toBeInstanceOf(SaleContextIncompleteError);
  });

  it('also refuses a cart that was already OPEN when the list was cleared', async () => {
    // The case the test above was described as covering and did not: it minted
    // its cart after reconciliation, so what it proved was "a cart created
    // with no list has no list". The dangerous cart is the one that was
    // already open, holding a pin to a row that has since gone — because
    // nothing reconciles a cart, and only a completed sale deletes one.
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    await provisionLocation(db);
    const seeded = await readActivePriceListId(db);
    if (seeded === null) throw new Error('the dev seed provisions a placeholder list');

    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 620_000_000n,
      priceListId: seeded,
    });
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, product);
    // Now the device reconciles onto the tenant's configuration, and the
    // placeholder the cart is pinned to stops being sellable.
    await db.execute('DELETE FROM price_list WHERE id = ?', [seeded]);
    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);
    expect(state.status).toBe('awaiting-config');

    // The cart it left behind is refused, with its lines intact...
    await expect(
      checkout(db, { cartId, tenderedMinor: 100_000_000n, hlc: fixedHlc(), nowIso: NOW }),
    ).rejects.toBeInstanceOf(SaleContextIncompleteError);
    expect(await getCartLines(db, cartId)).toHaveLength(1);
    // ...and the counter can say why, rather than only refusing.
    const verdict = await resolveCartPriceList(db, seeded, NOW);
    expect(blocksSale(verdict)).toBe(true);
  });

  it('does not stop the seed being idempotent', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    await seedDevDataIfEmpty(db);

    expect((await db.getAll('SELECT id FROM price_list')).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The selection path — the only way a tied configuration gets settled
// ---------------------------------------------------------------------------

describe('the selection path for a tied configuration', () => {
  it('binds the chosen list and re-runs the same policy', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    await seedPriceList(db, { code: 'RETAIL', priority: 10 });
    const wholesale = await seedPriceList(db, { code: 'WHOLESALE', priority: 10 });

    const state = await chooseDevicePriceList(db, devBearer([uuidv7()]), wholesale, NOW);

    expect(state.status).toBe('confirmed');
    expect(state.priceListId).toBe(wholesale);
    expect(await readActivePriceListId(db)).toBe(wholesale);
  });

  it('refuses a list this counter is not set up for — the server would too', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    await seedPriceList(db, { code: 'HERE', priority: 10 });
    const elsewhere = await seedPriceList(db, {
      code: 'ELSEWHERE',
      priority: 10,
      locationId: uuidv7(),
    });

    await expect(
      chooseDevicePriceList(db, devBearer([uuidv7()]), elsewhere, NOW),
    ).rejects.toBeInstanceOf(PriceListChoiceNotOfferedError);
    expect(await readActivePriceListId(db)).toBeNull();
  });

  it('refuses the dev seed’s placeholder even when it is asked for by id', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    await provisionLocation(db);
    await seedPriceList(db, { code: 'RETAIL', priority: 10 });
    const placeholder = (await db.getAll("SELECT id FROM price_list WHERE code = 'DEFAULT'"))[0]?.[
      'id'
    ];

    await expect(
      chooseDevicePriceList(db, devBearer([uuidv7()]), String(placeholder), NOW),
    ).rejects.toBeInstanceOf(PriceListChoiceNotOfferedError);
  });
});

// ---------------------------------------------------------------------------
// Convergence — reconciliation is safe to re-run on every synced row
// ---------------------------------------------------------------------------

describe('reconciliation settles', () => {
  it('writes once and then stops writing, however many times it runs', async () => {
    // App re-derives this state on every change notification, and a write
    // notifies. It must reach a fixed point or the till spins forever.
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    await provisionLocation(db);
    const retail = await seedPriceList(db, { code: 'RETAIL', priority: 10 });

    const first = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);
    const second = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);
    const third = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(first.status).toBe('reconciled');
    expect(second.status).toBe('confirmed');
    expect(third).toEqual(second);
    expect(await readActivePriceListId(db)).toBe(retail);
    // And exactly one config row for the key — a rewrite must replace, not stack.
    expect((await db.getAll('SELECT id FROM local_config WHERE key = ?', [
      CONFIG_KEY_PRICE_LIST_ID,
    ])).length).toBe(1);
  });

  it('picks up a list that arrives after the device has given up waiting', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    expect((await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW)).status).toBe(
      'awaiting-config',
    );

    // The sync stream delivers. No reload, no re-enrolment.
    const retail = await seedPriceList(db, { code: 'RETAIL', priority: 10 });
    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('provisioned');
    expect(state.priceListId).toBe(retail);
  });
});

// ---------------------------------------------------------------------------
// A tax-inclusive default — the refusal that WAS here, and why it is gone
// ---------------------------------------------------------------------------

describe('a configured default whose prices already include tax', () => {
  it('binds it, where it used to refuse', async () => {
    // Tenant #1's real configuration, as the shipped template seeds it: the
    // best-ranked list carries tax-inclusive shelf prices. This gate answered
    // `status: 'unsupported'` and cleared the device — correct while nothing
    // could de-gross a shelf price, and a launch blocker the moment extraction
    // existed, because it left the counter unable to trade at all.
    const db = openTestDb();
    await provisionLocation(db);
    const retail = await seedPriceList(db, { code: 'RETAIL', priority: 10, taxInclusive: true });
    await seedPriceList(db, { code: 'WHOLESALE', priority: 20 });

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('provisioned');
    expect(state.priceListId).toBe(retail);
    expect(blocksSales(state)).toBe(false);
    expect(await readActivePriceListId(db)).toBe(retail);
    expect(state.message).toBeNull();
  });

  it('still does NOT fall through to the next list down', async () => {
    // The single most damaging thing this module could do — charge every
    // walk-in customer off a list the tenant did not choose for them — is
    // still not done. The best-ranked list wins because it is best-ranked.
    const db = openTestDb();
    await provisionLocation(db);
    const retail = await seedPriceList(db, { code: 'RETAIL', priority: 10, taxInclusive: true });
    const wholesale = await seedPriceList(db, { code: 'WHOLESALE', priority: 20 });

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.priceListId).toBe(retail);
    expect(state.priceListId).not.toBe(wholesale);
  });

  it('keeps a stored tax-inclusive list it was already pointed at', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    const retail = await seedPriceList(db, { code: 'RETAIL', priority: 10, taxInclusive: true });
    await storePriceListId(db, retail);

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('confirmed');
    expect(state.replacedPriceListId).toBeNull();
    expect(await readActivePriceListId(db)).toBe(retail);
  });

  it('takes one chosen by hand out of a tie', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    const retail = await seedPriceList(db, { code: 'RETAIL', priority: 10, taxInclusive: true });
    await seedPriceList(db, { code: 'TRADE', priority: 10 });

    const state = await chooseDevicePriceList(db, devBearer([uuidv7()]), retail, NOW);

    expect(state.status).toBe('confirmed');
    expect(await readActivePriceListId(db)).toBe(retail);
  });

  it('takes a tax-exclusive list from the same tie without complaint', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    await seedPriceList(db, { code: 'RETAIL', priority: 10, taxInclusive: true });
    const trade = await seedPriceList(db, { code: 'TRADE', priority: 10 });

    const state = await chooseDevicePriceList(db, devBearer([uuidv7()]), trade, NOW);

    expect(state.status).toBe('confirmed');
    expect(state.priceListId).toBe(trade);
  });
});

// ---------------------------------------------------------------------------
// THE REFUSALS THAT ARE STILL REAL. Removing the tax-inclusive one must not
// have loosened any of these: each has a cause that has nothing to do with tax
// and that no amount of arithmetic in @erp/money addresses.
// ---------------------------------------------------------------------------

describe('the refusals that survive', () => {
  it('still refuses a TIE at the best ranking, tax convention notwithstanding', async () => {
    // Two lists the tenant ranked equally are two lists the platform has no
    // basis to choose between. Both inclusive here, so the only thing that
    // could have "resolved" the tie is the removed rule — it must not.
    const db = openTestDb();
    await provisionLocation(db);
    await seedPriceList(db, { code: 'RETAIL', priority: 10, taxInclusive: true });
    await seedPriceList(db, { code: 'COUNTER', priority: 10, taxInclusive: true });

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('ambiguous');
    expect(blocksSales(state)).toBe(true);
    expect(state.choices.map((c) => c.code).sort()).toEqual(['COUNTER', 'RETAIL']);
    expect(await readActivePriceListId(db)).toBeNull();
  });

  it('still refuses when lists exist and none covers this counter today', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    await seedPriceList(db, { code: 'ELSEWHERE', priority: 10, locationId: uuidv7() });
    await seedPriceList(db, { code: 'LAPSED', priority: 20, effectiveTo: TODAY });

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('unconfigured');
    expect(blocksSales(state)).toBe(true);
  });

  it('still WAITS when no tenant list has arrived yet', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    // A local-only placeholder is not tenant configuration; it must not count.
    await seedPriceList(db, { code: 'PLACEHOLDER', priority: 1, synced: false });

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('awaiting-config');
    expect(blocksSales(state)).toBe(true);
  });

  it('still refuses when the device has no location', async () => {
    const db = openTestDb();
    await seedPriceList(db, { code: 'RETAIL', priority: 10, taxInclusive: true });

    const state = await reconcileDevicePriceList(db, devBearer([uuidv7()]), NOW);

    expect(state.status).toBe('location-unknown');
    expect(blocksSales(state)).toBe(true);
  });

  it('still refuses a hand-picked list this counter is not offered', async () => {
    const db = openTestDb();
    const locationId = await provisionLocation(db);
    await seedPriceList(db, { code: 'OURS', priority: 10, taxInclusive: true });
    const elsewhere = await seedPriceList(db, {
      code: 'ELSEWHERE',
      priority: 1,
      locationId: uuidv7(),
      taxInclusive: true,
    });

    await expect(
      chooseDevicePriceList(db, devBearer([locationId]), elsewhere, NOW),
    ).rejects.toBeInstanceOf(PriceListChoiceNotOfferedError);
  });

  it('still refuses a CART pinned to a list that lapsed overnight', async () => {
    const db = openTestDb();
    await provisionLocation(db);
    const lapsed = await seedPriceList(db, {
      code: 'LAPSED',
      priority: 10,
      taxInclusive: true,
      effectiveTo: TODAY,
    });

    const state = await resolveCartPriceList(db, lapsed, NOW);

    expect(state.status).toBe('not-offered');
    expect(blocksSale(state)).toBe(true);
  });

  it('still refuses a CART pinned to a row that is gone', async () => {
    const db = openTestDb();
    await provisionLocation(db);

    const state = await resolveCartPriceList(db, uuidv7(), NOW);

    expect(state.status).toBe('unrecognised');
    expect(blocksSale(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (§2.7 category 3) — another tenant's list is not a candidate
// ---------------------------------------------------------------------------

describe('a second tenant’s price lists', () => {
  it('cannot be resolved, offered or chosen, even ranked best', async () => {
    // A device holds exactly one tenant's rows because the sync rules put them
    // there (`WHERE tenant_id = bucket.tenant_id`). This proves the client does
    // not widen that: a foreign row that somehow landed locally is still not
    // configuration this device can sell from, and the refusal is by scope and
    // effective window — never by comparing tenant ids, which the client has no
    // business asserting (§2.1).
    const db = openTestDb();
    const locationId = await provisionLocation(db);
    const ours = await seedPriceList(db, { code: 'RETAIL', priority: 10 });
    const theirs = await seedPriceList(db, {
      code: 'THEIR-RETAIL',
      priority: 1,
      locationId: uuidv7(), // their outlet, not ours
    });

    const candidates = await readPriceListCandidates(db, locationId, TODAY);
    expect(candidates.map((c) => c.id)).toEqual([ours]);

    const state = await reconcileDevicePriceList(db, devBearer([locationId]), NOW);
    expect(state.priceListId).toBe(ours);
    await expect(
      chooseDevicePriceList(db, devBearer([locationId]), theirs, NOW),
    ).rejects.toBeInstanceOf(PriceListChoiceNotOfferedError);
  });
});
