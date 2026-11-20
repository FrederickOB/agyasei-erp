/**
 * The print queue and the service around it, against real SQLite over the
 * device's own schema.
 *
 * THE INVARIANT: a print is a request made of a completed sale, never part of
 * it. These tests prove it from both sides:
 *   - the guard — nothing is queued or printed for a sale that is not already
 *     committed in the outbox on this device;
 *   - the blast radius — failure, timeout, a misbehaving transport, a broken
 *     queue table, retries, reprints and expiry never change an outbox row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout, type TenderDraft } from '../src/data/mutations/checkout';
import { priceCart, UNTAXED_BASIS } from '../src/data/pricing/cart-pricing';
import { getCartLines } from '../src/data/queries/cart';
import { fromBase64, toHex } from '../src/printing/escpos';
import { enqueueReceipt, getQueueEntry, listPending, PRINT_QUEUE_TTL_MS, purgeExpired } from '../src/printing/queue';
import { PrintService } from '../src/printing/service';
import { documentForCommittedSale, documentFromSyncedSale, readCommittedSale } from '../src/printing/sources';
import type { PrintAttempt, PrintJob, ReceiptTransport, TransportId } from '../src/printing/transports/types';
import { fixedHlc, provisionDevice, seedProduct, seedTenderMethods } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';
import { TEST_CURRENCY } from './helpers/receipt-fixtures';

const NOW = Date.parse('2026-12-01T10:00:00.000Z');

type Behaviour = 'sent' | 'timeout' | 'failed' | 'throw' | 'hang';

interface FakeTransport extends ReceiptTransport {
  calls: PrintJob[];
  behaviour: Behaviour;
  release: () => void;
  emitLink: (up: boolean) => void;
}

function fake(id: TransportId, raw = true): FakeTransport {
  const links = new Set<(up: boolean) => void>();
  let releaseFn: () => void = () => undefined;
  const t: FakeTransport = {
    id,
    label: id,
    raw,
    calls: [],
    behaviour: 'sent',
    release: () => releaseFn(),
    emitLink: (up) => links.forEach((l) => l(up)),
    probe: () => Promise.resolve({ state: 'ready', detail: '' }),
    onLinkChange: (l) => {
      links.add(l);
      return () => links.delete(l);
    },
    print(job: PrintJob): Promise<PrintAttempt> {
      t.calls.push(job);
      const base = { transport: id, durationMs: 1, byteCount: job.bytes.length };
      switch (t.behaviour) {
        case 'sent':
          return Promise.resolve({ ...base, outcome: 'sent', evidence: 'bytes-accepted', detail: null });
        case 'timeout':
          return Promise.resolve({ ...base, outcome: 'timeout', evidence: 'none', detail: 'timed out' });
        case 'failed':
          return Promise.resolve({ ...base, outcome: 'failed', evidence: 'none', detail: 'printer off' });
        case 'throw':
          return Promise.reject(new Error('transport broke its contract'));
        case 'hang':
          return new Promise((resolve) => {
            releaseFn = () => resolve({ ...base, outcome: 'sent', evidence: 'bytes-accepted', detail: null });
          });
      }
    },
  };
  return t;
}

function services(db: LocalDb, ble: FakeTransport, now = { t: NOW }): PrintService {
  const none = fake('none', false);
  const transports = {
    'ble-escpos': ble,
    'webusb-escpos': fake('webusb-escpos'),
    'web-serial': fake('web-serial'),
    'android-print-bridge': fake('android-print-bridge'),
    'system-print': fake('system-print', false),
    none,
  } as Record<TransportId, ReceiptTransport>;
  return new PrintService(db, { transports, now: () => now.t, retry: { baseMs: 1000, maxMs: 4000 } });
}

interface Rung {
  readonly saleId: string;
  readonly cart: Parameters<PrintService['afterSale']>[1];
}

async function ringSale(db: LocalDb, hlcMs = NOW): Promise<Rung> {
  // A sale is filed under its till's business date (08 §8.2a): open the till
  // for the day the sale is rung, not for whatever day the suite runs on.
  const device = await provisionDevice(db, { till: new Date(hlcMs).toISOString().slice(0, 10) });
  const bags = await seedProduct(db, {
    code: 'BAG-1',
    name: 'Cement 50kg',
    uomLabel: 'bag',
    qtyScale: 0,
    unitPriceE4: 620_000_000n,
    priceListId: device.priceListId,
  });
  const cartId = await createCart(db, { nowIso: new Date(hlcMs).toISOString() });
  for (let i = 0; i < 20; i++) await addProductToCart(db, cartId, bags);
  const lines = await getCartLines(db, cartId);
  const pricing = priceCart(lines, UNTAXED_BASIS);
  const result = await checkout(db, {
    cartId,
    tenderedMinor: 1_500_000n,
    hlc: fixedHlc(hlcMs),
    nowIso: new Date(hlcMs).toISOString(),
  });
  expect(result.totalMinor).toBe(pricing.grossMinor);
  return { saleId: result.saleId, cart: { lines, pricing, basis: UNTAXED_BASIS } };
}

async function outboxSnapshot(db: LocalDb): Promise<string> {
  const rows = await db.getAll('SELECT * FROM outbox ORDER BY id');
  return JSON.stringify(rows);
}

async function usable(db: LocalDb, svc: PrintService): Promise<void> {
  await svc.loadSettings();
  await svc.saveSettings({ transport: 'ble-escpos', autoPrint: false });
  void db;
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

/**
 * A sale paid by something other than cash prints as what it WAS paid by.
 * Before tender lines reached the printer, every receipt fell back to "Cash"
 * — a mobile-money or on-account customer's copy said they had paid cash.
 */
async function ringWithTenders(
  db: LocalDb,
  tenders: (m: Awaited<ReturnType<typeof seedTenderMethods>>) => readonly TenderDraft[],
  customerId?: string,
): Promise<Rung> {
  const device = await provisionDevice(db, { till: new Date(NOW).toISOString().slice(0, 10) });
  const methods = await seedTenderMethods(db);
  const bags = await seedProduct(db, {
    code: 'BAG-1',
    name: 'Cement 50kg',
    uomLabel: 'bag',
    qtyScale: 0,
    unitPriceE4: 620_000_000n,
    priceListId: device.priceListId,
  });
  const cartId = await createCart(db, { nowIso: new Date(NOW).toISOString() });
  for (let i = 0; i < 3; i++) await addProductToCart(db, cartId, bags);
  const lines = await getCartLines(db, cartId);
  const pricing = priceCart(lines, UNTAXED_BASIS); // 3 × 62,000 = 186,000
  const result = await checkout(db, {
    cartId,
    tenders: tenders(methods),
    ...(customerId === undefined ? {} : { customerId }),
    hlc: fixedHlc(NOW),
    nowIso: new Date(NOW).toISOString(),
  });
  return { saleId: result.saleId, cart: { lines, pricing, basis: UNTAXED_BASIS } };
}

describe('the receipt says how the sale was actually paid', () => {
  it('a split prints each method by its own name, with the wallet reference, and change on its own line', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringWithTenders(db, (m) => [
      { method: m.wallet, amountMinor: 120_000n, reference: 'MP2611181234' },
      { method: m.cash, amountMinor: null, tenderedMinor: 100_000n },
    ]);
    const svc = services(db, fake('ble-escpos'));
    await usable(db, svc);
    expect((await svc.afterSale(saleId, cart, TEST_CURRENCY)).status).toBe('queued');
    const doc = (await getQueueEntry(db, saleId))?.doc;
    expect(doc?.tenders).toEqual([
      { method: 'Phone wallet', amountMinor: 120_000n, reference: 'MP2611181234' },
      { method: 'Notes and coins', amountMinor: 66_000n, reference: null },
    ]);
    expect(doc?.changeMinor).toBe(34_000n);
    // The paid-by lines are the settlement: they sum to the total.
    expect(doc!.tenders.reduce((a, t) => a + t.amountMinor, 0n)).toBe(doc!.totalMinor);
  });

  it('an on-account sale never prints as cash', async () => {
    const db = openTestDb();
    const customerId = '019b0000-0000-7000-8000-00000000c0de';
    await db.execute(`INSERT INTO customer (id, name) VALUES (?, ?)`, [customerId, 'Site 4 contractor']);
    const { saleId, cart } = await ringWithTenders(db, (m) => [{ method: m.account, amountMinor: null }], customerId);
    const svc = services(db, fake('ble-escpos'));
    await usable(db, svc);
    expect((await svc.afterSale(saleId, cart, TEST_CURRENCY)).status).toBe('queued');
    const doc = (await getQueueEntry(db, saleId))?.doc;
    expect(doc?.tenders).toEqual([{ method: 'Tab', amountMinor: 186_000n, reference: null }]);
    expect(doc?.changeMinor).toBe(0n);
  });
});

describe('the sale comes first', () => {
  it('refuses to queue or print anything for a sale that is not committed on this device', async () => {
    const db = openTestDb();
    const { cart } = await ringSale(db);
    const ble = fake('ble-escpos');
    const svc = services(db, ble);
    await svc.saveSettings({ transport: 'ble-escpos', autoPrint: true });

    const result = await svc.afterSale('019b0000-0000-7000-8000-000000000000', cart, TEST_CURRENCY);
    expect(result.status).toBe('no-such-sale');
    expect(await listPending(db)).toEqual([]);
    expect(ble.calls).toHaveLength(0);
  });

  it('queues the snapshot only after the outbox row exists, from the committed total (not the screen)', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const ble = fake('ble-escpos');
    const svc = services(db, ble);
    await usable(db, svc);
    expect((await svc.afterSale(saleId, cart, TEST_CURRENCY)).status).toBe('queued');
    const entry = await getQueueEntry(db, saleId);
    expect(entry?.doc?.totalMinor).toBe(1_240_000n);
    expect(entry?.doc?.lines[0]?.qtyText).toBe('20');
    // The tenant's own name for the method, never a word in code; the amount
    // the method SETTLED (tenders sum to the total), and the change on its own.
    expect(entry?.doc?.tenders).toHaveLength(1);
    expect(entry?.doc?.tenders[0]).toMatchObject({ method: 'Notes and coins', amountMinor: 1_240_000n });
    expect(entry?.doc?.changeMinor).toBe(260_000n);
  });

  it('drops the lines and tax split rather than print ones that disagree with the committed total', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const svc = services(db, fake('ble-escpos'));
    await usable(db, svc);
    const stale = {
      ...cart,
      pricing: {
        ...cart.pricing,
        grossMinor: cart.pricing.grossMinor + 1n,
        breakdown: { netMinor: 1n, taxes: [{ code: 'T', baseMinor: 1n, computedMinor: 1n, residualMinor: 0n, taxMinor: 1n }], taxTotalMinor: 1n, grossMinor: 2n },
      },
    };
    await svc.afterSale(saleId, stale, TEST_CURRENCY);
    const doc = (await getQueueEntry(db, saleId))?.doc;
    expect(doc?.taxLines).toEqual([]);
    expect(doc?.lines).toEqual([]); // not provably this sale's cart, so not printed under its total
    expect(doc?.netMinor).toBeNull();
    expect(doc?.totalMinor).toBe(1_240_000n);
  });
});

describe('a print can never alter a sale', () => {
  it.each(['timeout', 'failed', 'throw'] as const)('a %s leaves the outbox byte-for-byte unchanged and the print pending', async (behaviour) => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const before = await outboxSnapshot(db);
    const ble = fake('ble-escpos');
    ble.behaviour = behaviour;
    const svc = services(db, ble);
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    const attempt = await svc.print(saleId);
    expect(attempt?.outcome).not.toBe('sent');
    const entry = await getQueueEntry(db, saleId);
    expect(entry?.state).toBe('pending');
    expect(entry?.attempts).toBe(1);
    expect(entry?.bytesB64).not.toBeNull(); // rendered bytes kept for the retry
    expect(await outboxSnapshot(db)).toBe(before);
  });

  it('a broken queue table does not stop the sale, the counter, or the receipt-less outbox', async () => {
    const db = openTestDb({ failOn: (sql) => sql.includes('local_print_queue') });
    const { saleId, cart } = await ringSale(db);
    const before = await outboxSnapshot(db);
    const svc = services(db, fake('ble-escpos'));
    const result = await svc.afterSale(saleId, cart, TEST_CURRENCY); // must not throw
    expect(result.status).toBe('error');
    expect(await svc.print(saleId)).toBeNull();
    expect(await outboxSnapshot(db)).toBe(before);
    expect(JSON.parse(before)).toHaveLength(1);
  });

  it('does not make the next customer wait: afterSale resolves while the printer is still busy', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const ble = fake('ble-escpos');
    ble.behaviour = 'hang';
    const svc = services(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos', autoPrint: true });
    const result = await svc.afterSale(saleId, cart, TEST_CURRENCY);
    expect(result.status).toBe('queued');
    await vi.waitFor(() => expect(ble.calls).toHaveLength(1));
    expect(svc.isBusy).toBe(true);
    ble.release();
    await vi.waitFor(async () => expect((await getQueueEntry(db, saleId))?.state).toBe('sent'));
  });

  it('one entry per sale: a repeated afterSale does not duplicate the queue row or the print', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const svc = services(db, fake('ble-escpos'));
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    const rows = await db.getAll('SELECT COUNT(*) AS n FROM local_print_queue');
    expect(Number(rows[0]?.['n'])).toBe(1);
  });
});

describe('retry and reprint', () => {
  it('retries the same bytes, then drops them once sent', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const ble = fake('ble-escpos');
    ble.behaviour = 'failed';
    const svc = services(db, ble);
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    await svc.print(saleId);
    ble.behaviour = 'sent';
    const second = await svc.print(saleId);
    expect(second?.outcome).toBe('sent');
    expect(toHex(ble.calls[1]!.bytes)).toBe(toHex(ble.calls[0]!.bytes));
    const entry = await getQueueEntry(db, saleId);
    expect(entry).toMatchObject({ state: 'sent', attempts: 2, bytesB64: null, lastOutcome: 'sent', lastEvidence: 'bytes-accepted' });
    expect(entry?.doc).not.toBeNull(); // kept for a reprint until expiry
  });

  it('a reprint is a copy that reproduces the sale\'s own tax lines and never pops the drawer', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const ble = fake('ble-escpos');
    const svc = services(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos', autoPrint: false, kickDrawer: true });
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    await svc.print(saleId);
    expect(toHex(ble.calls[0]!.bytes).includes('1b700019fa')).toBe(true); // original: drawer kicked
    const outbox = await outboxSnapshot(db);
    const again = await svc.reprint(saleId);
    expect(typeof again === 'object' && again.outcome).toBe('sent');
    expect(ble.calls[1]!.isCopy).toBe(true);
    expect(toHex(ble.calls[1]!.bytes).includes('1b70')).toBe(false); // reprint: never
    expect(Buffer.from(ble.calls[1]!.bytes).toString('latin1')).toContain('COPY - REPRINT');
    expect(await outboxSnapshot(db)).toBe(outbox);
  });

  it('a double tap on Reprint joins the print in flight instead of printing twice', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const ble = fake('ble-escpos');
    const svc = services(db, ble);
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    await svc.print(saleId);
    ble.behaviour = 'hang';
    const a = svc.reprint(saleId);
    await vi.waitFor(() => expect(ble.calls).toHaveLength(2));
    const b = svc.reprint(saleId);
    ble.release();
    await Promise.all([a, b]);
    expect(ble.calls).toHaveLength(2);
  });

  it('re-renders cached bytes for a changed paper width instead of sending the wrong width', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const ble = fake('ble-escpos');
    ble.behaviour = 'failed';
    const svc = services(db, ble);
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    await svc.print(saleId);
    await svc.saveSettings({ paperWidthMm: 80 });
    ble.behaviour = 'sent';
    await svc.print(saleId);
    expect(ble.calls[1]!.bytes.length).toBeGreaterThan(ble.calls[0]!.bytes.length);
    expect(fromBase64('').length).toBe(0);
  });
});

describe('expiry', () => {
  it('keeps a row for 7 days and then discards it, and only that table', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const svc = services(db, fake('ble-escpos'));
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    const outbox = await outboxSnapshot(db);
    const justBefore = new Date(NOW + PRINT_QUEUE_TTL_MS - 1000).toISOString();
    const justAfter = new Date(NOW + PRINT_QUEUE_TTL_MS + 1000).toISOString();
    expect(await purgeExpired(db, justBefore)).toBe(0);
    expect(await getQueueEntry(db, saleId)).not.toBeNull();
    expect(await purgeExpired(db, justAfter)).toBe(1);
    expect(await getQueueEntry(db, saleId)).toBeNull();
    expect(await outboxSnapshot(db)).toBe(outbox);
  });

  it('enqueue is idempotent per sale', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const svc = services(db, fake('ble-escpos'));
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    const doc = (await getQueueEntry(db, saleId))!.doc!;
    await enqueueReceipt(db, doc, new Date(NOW + 5000).toISOString());
    const rows = await db.getAll('SELECT COUNT(*) AS n FROM local_print_queue');
    expect(Number(rows[0]?.['n'])).toBe(1);
  });
});

describe('auto retry', () => {
  it('catches up, oldest first, when the printer link comes back — with no human step', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const ble = fake('ble-escpos');
    ble.behaviour = 'failed';
    const svc = services(db, ble);
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    await svc.print(saleId); // fails: printer was off
    svc.startAutoRetry();
    await vi.advanceTimersByTimeAsync(10); // first tick: still failing
    expect((await getQueueEntry(db, saleId))?.state).toBe('pending');
    ble.behaviour = 'sent';
    ble.emitLink(true); // printer power-cycled and reconnected
    await vi.advanceTimersByTimeAsync(10);
    expect((await getQueueEntry(db, saleId))?.state).toBe('sent');
    svc.stopAutoRetry();
  });

  it('backs off while the printer stays down and does not hammer it', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const ble = fake('ble-escpos');
    ble.behaviour = 'failed';
    const svc = services(db, ble);
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    svc.startAutoRetry();
    await vi.advanceTimersByTimeAsync(20_000);
    // 20 s at 1,2,4,4,4... s backoff: far fewer than 20 attempts.
    expect(ble.calls.length).toBeGreaterThan(2);
    expect(ble.calls.length).toBeLessThan(10);
    svc.stopAutoRetry();
  });

  it('does not auto-retry a request older than the window (a stale reprint must not surprise anyone)', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const clock = { t: NOW };
    const ble = fake('ble-escpos');
    ble.behaviour = 'failed';
    const svc = services(db, ble, clock);
    await usable(db, svc);
    await svc.afterSale(saleId, cart, TEST_CURRENCY);
    clock.t = NOW + 7 * 60 * 60 * 1000;
    expect(await svc.drain()).toEqual({ attempted: 0, sent: 0 });
    expect(ble.calls).toHaveLength(0);
  });
});

describe('reprinting from the synced rows, with the sale\'s own snapshot', () => {
  it('uses the sale\'s money scale and tax rate — not the live pack\'s — and says nothing is available before sync', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    const svc = services(db, fake('ble-escpos'));
    await usable(db, svc);
    // Queue row expired and nothing synced yet: an honest "no document", not a guess.
    expect(await svc.reprint(saleId)).toBe('no-document');
    expect(await documentFromSyncedSale(db, saleId)).toBeNull();

    // The server's rows arrive. The sale was priced at scale 3 and taxed at 12.5%;
    // the LIVE pack row now says scale 2 and the live rate differs.
    const receiptNo = String((await db.getAll('SELECT receipt_no FROM outbox'))[0]!['receipt_no']);
    await db.execute(
      `INSERT INTO jurisdiction (id, code, name, currency_code, currency_symbol, minor_units_per_major, cash_rounding_unit_minor)
       VALUES ('j1', 'X', 'Pack', 'TST', 'T$', 100, 1)`,
    );
    await db.execute(`INSERT INTO tax_code (id, jurisdiction_code, code, name, input_deductible) VALUES ('tc', 'X', 'T1', 'Levy one', 0)`);
    await db.execute(
      `INSERT INTO tax_rate (id, jurisdiction_code, tax_code, rate_bp, base_kind, base_includes, rounding_level, rounding_mode, effective, legal_reference, confirmed_by, confirmed_at)
       VALUES ('tr', 'X', 'T1', 1900, 'net', NULL, 'line', 'half-up', NULL, NULL, NULL, NULL)`,
    );
    await db.execute(
      `INSERT INTO sale (id, tenant_id, location_id, customer_id, price_list_id, receipt_no, business_date, occurred_at, voids_sale_id,
                         currency_code, money_scale, subtotal_net_minor, discount_minor, tax_total_minor, total_minor, hlc, created_at, updated_at)
       VALUES ('srv-sale', NULL, NULL, NULL, 'pl', ?, '2026-12-01', '2026-12-01T10:00:00.000Z', NULL,
               'TST', 3, CAST(1000000 AS INTEGER), 0, CAST(125000 AS INTEGER), CAST(1125000 AS INTEGER), NULL, NULL, NULL)`,
      [receiptNo],
    );
    await db.execute(
      `INSERT INTO sale_line (id, tenant_id, sale_id, line_no, product_id, selling_uom_id, qty_sell, qty_sell_scale, unit_price_e4,
                              stocking_uom_id, qty_stock, qty_stock_scale, factor_num, factor_den, line_discount_minor, line_net_minor, tax_code, tax_minor, hlc, created_at, updated_at)
       VALUES ('sl1', NULL, 'srv-sale', 1, NULL, NULL, CAST(20 AS INTEGER), 0, CAST(500000000 AS INTEGER),
               NULL, 20, 0, 1, 1, 0, CAST(1000000 AS INTEGER), 'T1', CAST(125000 AS INTEGER), NULL, NULL, NULL)`,
    );
    await db.execute(
      `INSERT INTO sale_tax_line (id, tenant_id, sale_id, sale_line_id, seq, tax_code, rate_bp, base_kind, base_includes, rounding_level, rounding_mode, base_minor, tax_minor, tax_rate_id, hlc, created_at, updated_at)
       VALUES ('stl1', NULL, 'srv-sale', 'sl1', 1, 'T1', 1250, 'net', NULL, 'line', 'half-up', CAST(1000000 AS INTEGER), CAST(125000 AS INTEGER), 'tr', NULL, NULL, NULL)`,
    );

    const doc = await documentFromSyncedSale(db, saleId);
    expect(doc).not.toBeNull();
    expect(doc!.currency).toEqual({ code: 'TST', symbol: 'T$', scale: 3 }); // the sale's, not the pack's 2
    expect(doc!.taxLines).toEqual([
      { code: 'T1', name: 'Levy one', rateBp: 1250n, baseMinor: 1_000_000n, taxMinor: 125_000n }, // 12.5%, not the live 19%
    ]);
    expect(doc!.totalMinor).toBe(1_125_000n);
    void cart;
  });
});

describe('queue ordering', () => {
  it('lists outstanding prints oldest request first', async () => {
    const db = openTestDb();
    const a = await ringSale(db, NOW);
    const svc = services(db, fake('ble-escpos'));
    await usable(db, svc);
    await svc.afterSale(a.saleId, a.cart, TEST_CURRENCY);
    const doc = (await getQueueEntry(db, a.saleId))!.doc!;
    await enqueueReceipt(db, { ...doc, saleId: 'later', receiptNo: 'later' }, new Date(NOW + 1000).toISOString());
    expect((await listPending(db)).map((e) => e.saleId)).toEqual([a.saleId, 'later']);
  });
});

describe('tax lines on a just-rung sale', () => {
  it('carries the basis\'s own rate and the pack\'s tax-code name, and the split foots to the total', async () => {
    const db = openTestDb();
    const { saleId, cart } = await ringSale(db);
    await db.execute(`INSERT INTO tax_code (id, jurisdiction_code, code, name, input_deductible) VALUES ('tc', 'X', 'T1', 'Levy one', 0)`);
    const basis = {
      isTaxInclusive: false,
      components: [
        { code: 'T1', rateBp: 1500n, baseKind: 'net' as const, baseIncludes: [], roundingLevel: 'line' as const, roundingMode: 'half-up' as const },
      ],
    };
    const pricing = priceCart(cart.lines, basis);
    const facts = { ...(await readCommittedSale(db, saleId))!, totalMinor: pricing.grossMinor };
    const doc = await documentForCommittedSale(db, facts, { lines: cart.lines, pricing, basis }, TEST_CURRENCY);
    expect(doc.pricesIncludeTax).toBe(false);
    expect(doc.netMinor).toBe(1_240_000n);
    expect(doc.taxLines).toEqual([{ code: 'T1', name: 'Levy one', rateBp: 1500n, baseMinor: 1_240_000n, taxMinor: 186_000n }]);
    expect(doc.netMinor! + doc.taxLines[0]!.taxMinor).toBe(doc.totalMinor);
  });
});
