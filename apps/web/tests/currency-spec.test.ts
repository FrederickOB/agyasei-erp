/**
 * WHAT THIS TILL PRICES IN (§2.7 category 1 — it decides how every amount on
 * screen and on a receipt is read).
 *
 * The reconciler existed and was called from nowhere, so the only thing that
 * ever wrote a CurrencySpec was the dev seed's PLACEHOLDER — a test-currency
 * code and a generic sign. A synced, trading till showed that to customers.
 * These tests hold the wiring and the two rules that make it safe to run on
 * every start: it never invents a currency, and it never blocks a counter.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { readCurrencySpec, writeCurrencySpec } from '../src/data/queries/config';
import { seedDevDataIfEmpty } from '../src/data/seed';
import { reconcileCurrencySpec } from '../src/data/session/currency-spec';
import { uuidv7 } from '../src/lib/uuidv7';
import { openTestDb } from './helpers/node-db';

interface PackFixture {
  readonly code?: string;
  readonly currencyCode?: string;
  readonly symbol?: string;
  /**
   * Minor units per major unit — 100 is NEVER assumed (CLAUDE.md §2.3). A
   * COUNT of units in a major unit, not an amount of money: the same thing
   * `CurrencySpec.scale` is derived from, and the one place `number` is the
   * right type. lint-money-ignore
   */
  readonly minorUnits?: number | null; // lint-money-ignore — the divisor (1/100/1000), not minor units
}

/** The `jurisdiction` row the jurisdiction_pack bucket streams. */
async function seedPack(db: LocalDb, pack: PackFixture = {}): Promise<void> {
  await db.execute(
    `INSERT INTO jurisdiction (id, code, name, currency_code, currency_symbol,
                               minor_units_per_major, cash_rounding_unit_minor)
     VALUES (?, ?, 'A jurisdiction', ?, ?, ?, 1)`,
    [
      pack.code ?? 'ZZ',
      pack.code ?? 'ZZ',
      pack.currencyCode ?? 'ZZD',
      pack.symbol ?? 'Z$',
      pack.minorUnits === undefined ? 100 : pack.minorUnits,
    ],
  );
}

describe('the currency a till prices in', () => {
  it('comes from the tenant’s pack, replacing the dev placeholder', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db); // writes the XTS / generic-sign placeholder
    await seedPack(db, { currencyCode: 'ZZD', symbol: 'Z$', minorUnits: 100 });

    const state = await reconcileCurrencySpec(db, true);

    expect(state.status).toBe('reconciled');
    expect(state.spec).toEqual({ code: 'ZZD', symbol: 'Z$', scale: 2 });
    expect(await readCurrencySpec(db)).toEqual(state.spec);
  });

  it('reads the pack’s scale rather than assuming 100 to the major unit', async () => {
    const db = openTestDb();
    await seedPack(db, { currencyCode: 'AAD', symbol: 'A$', minorUnits: 1000 });

    expect((await reconcileCurrencySpec(db, true)).spec).toEqual({
      code: 'AAD',
      symbol: 'A$',
      scale: 3,
    });
  });

  it('provisions a device that had no spec at all', async () => {
    const db = openTestDb();
    await seedPack(db);

    const state = await reconcileCurrencySpec(db, true);

    expect(state.status).toBe('provisioned');
    expect(state.spec).not.toBeNull();
  });

  it('settles: a second pass writes nothing new', async () => {
    const db = openTestDb();
    await seedPack(db);
    const first = await reconcileCurrencySpec(db, true);

    const second = await reconcileCurrencySpec(db, true);

    expect(second.status).toBe('confirmed');
    expect(second.spec).toEqual(first.spec);
  });

  it('leaves a local-only device’s placeholder exactly as it is', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    const seeded = await readCurrencySpec(db);

    // No session: there is no tenant configuration to reconcile against, and
    // the offline rehearsal must not regress.
    const state = await reconcileCurrencySpec(db, false);

    expect(state.status).toBe('local-only');
    expect(state.spec).toEqual(seeded);
  });

  it('never blocks a counter over a pack that has not arrived', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);

    const state = await reconcileCurrencySpec(db, true);

    // A wrong SYMBOL does not get a sale refused by the server — the wire
    // carries minor units and a decimal string, never a glyph. Taking a till
    // down over a presentation gap would cost more than it saves.
    expect(state.status).toBe('pack-absent');
    expect(state.spec).not.toBeNull();
    expect(state.message).toBeNull();
  });

  it('refuses a pack it cannot read, and says so, rather than guessing', async () => {
    const db = openTestDb();
    await seedDevDataIfEmpty(db);
    // 30 minor units to the major unit is not a power of ten, so there is no
    // digit count for it. Inventing one misplaces a decimal point on every
    // receipt (ADR-0004).
    await seedPack(db, { minorUnits: 30 });

    const state = await reconcileCurrencySpec(db, true);

    expect(state.status).toBe('pack-unreadable');
    expect(state.message).not.toBeNull();
    expect((await readCurrencySpec(db))?.code).toBe('XTS'); // untouched
  });

  it('refuses to choose when a device somehow holds two packs', async () => {
    const db = openTestDb();
    await writeCurrencySpec(db, { code: 'ZZD', symbol: 'Z$', scale: 2 });
    await seedPack(db, { code: 'ZZ' });
    await seedPack(db, { code: 'YY', currencyCode: 'YYD', symbol: 'Y$' });

    // One tenant, one jurisdiction (§2.5). Two rows means the device holds
    // something nobody designed for; refusing beats picking.
    const state = await reconcileCurrencySpec(db, true);

    expect(state.status).toBe('pack-unreadable');
    expect((await readCurrencySpec(db))?.code).toBe('ZZD');
  });

  it('recovers a device whose stored spec is not a spec at all', async () => {
    const db = openTestDb();
    await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      'currency_spec',
      'not json',
    ]);
    await seedPack(db, { currencyCode: 'ZZD', symbol: 'Z$' });

    const state = await reconcileCurrencySpec(db, true);

    expect(state.spec).toEqual({ code: 'ZZD', symbol: 'Z$', scale: 2 });
    expect(await readCurrencySpec(db)).toEqual(state.spec);
  });
});
