// @vitest-environment jsdom
/**
 * The printing UI, exercised the way a counter uses it: ring a sale, read what
 * the receipt screen says about the paper copy, retry, reprint, fall back to the
 * on-screen receipt, set the printer up, run the spike.
 *
 * Two things are pinned above all: the screen says only the weaker thing it
 * knows ("sent to the printer", never "printed"), and nothing on any of these
 * screens can alter, delay or duplicate a sale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { LocalDb } from '../src/data/db';
import { DEV_PLACEHOLDER_CURRENCY } from '../src/data/seed';
import { Counter } from '../src/features/counter/Counter';
import { PrintingProvider } from '../src/features/printing/PrintingContext';
import { PrinterSettings } from '../src/features/printing/PrinterSettings';
import { ReceiptSheet } from '../src/features/printing/ReceiptSheet';
import { describePrint, describeAttempt } from '../src/features/printing/status-text';
import { SalesList } from '../src/features/sales/SalesList';
import { CurrencyProvider } from '../src/money/CurrencyContext';
import { getQueueEntry, type QueueEntry } from '../src/printing/queue';
import { PrintService } from '../src/printing/service';
import type { PrintAttempt, PrintJob, ReceiptTransport, TransportId } from '../src/printing/transports/types';
import { provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

function setLayout(wide: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: wide,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

interface Fake extends ReceiptTransport {
  calls: PrintJob[];
  behaviour: 'sent' | 'failed' | 'timeout' | 'needs-pairing';
}

function fake(id: TransportId, raw = true, evidence: PrintAttempt['evidence'] = 'bytes-accepted'): Fake {
  const t: Fake = {
    id,
    label: `Route ${id}`,
    raw,
    calls: [],
    behaviour: 'sent',
    probe: () => Promise.resolve({ state: 'ready', detail: 'Ready.' }),
    pair: () => Promise.resolve({ ok: true, detail: 'Printer chosen.', printerName: 'Test Printer' }),
    print(job) {
      t.calls.push(job);
      const base = { transport: id, durationMs: 5, byteCount: job.bytes.length };
      if (t.behaviour === 'sent') {
        return Promise.resolve<PrintAttempt>({
          ...base,
          outcome: id === 'none' ? 'shown' : 'sent',
          evidence: id === 'none' ? 'shown' : evidence,
          detail: null,
        });
      }
      return Promise.resolve<PrintAttempt>({
        ...base,
        outcome: t.behaviour,
        evidence: 'none',
        detail: t.behaviour === 'failed' ? 'Printer is off.' : t.behaviour === 'needs-pairing' ? 'No printer chosen yet.' : 'late',
      });
    },
  };
  return t;
}

function makeService(db: LocalDb, ble: Fake, none: Fake = fake('none', false)): PrintService {
  const transports = {
    'ble-escpos': ble,
    'webusb-escpos': fake('webusb-escpos'),
    'web-serial': fake('web-serial'),
    'android-print-bridge': fake('android-print-bridge', true, 'handed-off'),
    'system-print': fake('system-print', false, 'dialog-closed'),
    none,
  } as Record<TransportId, ReceiptTransport>;
  return new PrintService(db, { transports, retry: { baseMs: 60_000, maxMs: 60_000 } });
}

async function till(): Promise<LocalDb> {
  const db = openTestDb();
  const device = await provisionDevice(db);
  await seedProduct(db, {
    code: 'P-1',
    name: 'Cement 50kg',
    category: 'Cement',
    uomLabel: 'bag',
    unitPriceE4: 620_000_000n,
    priceListId: device.priceListId,
  });
  return db;
}

function counter(db: LocalDb, svc: PrintService): ReactElement {
  return (
    <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
      <PrintingProvider db={db} service={svc}>
        <Counter db={db} />
      </PrintingProvider>
    </CurrencyProvider>
  );
}

async function ringCashSale(): Promise<void> {
  const card = await screen.findByRole('button', { name: /Cement 50kg/ });
  await screen.findByRole('button', { name: /0 lines/ }); // the cart exists before the first line
  fireEvent.click(card);
  await waitFor(() => expect(screen.getByRole('button', { name: /1 line/ })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /Take payment/ }));
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '700' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Complete sale' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Complete sale' }));
}

async function outboxCount(db: LocalDb): Promise<number> {
  return Number((await db.getAll('SELECT COUNT(*) AS n FROM outbox'))[0]?.['n']);
}

beforeEach(() => setLayout(false));
afterEach(cleanup);

describe('what the screen says about the paper copy', () => {
  const entry = (over: Partial<QueueEntry>): QueueEntry => ({
    saleId: 's',
    receiptNo: 'R-1',
    doc: null,
    bytesB64: null,
    paperWidthMm: 58,
    state: 'pending',
    isCopy: false,
    attempts: 1,
    lastOutcome: null,
    lastEvidence: null,
    lastDetail: null,
    lastTransport: null,
    lastAttemptAt: '2026-12-01T14:02:00.000Z',
    requestedAt: '2026-12-01T14:00:00.000Z',
    createdAt: '2026-12-01T14:00:00.000Z',
    expiresAt: '2026-12-08T14:00:00.000Z',
    ...over,
  });

  it('never claims "printed" as a fact, in any state', () => {
    const states: QueueEntry[] = [
      entry({ attempts: 0 }),
      entry({ state: 'sent', lastOutcome: 'sent', lastEvidence: 'bytes-accepted' }),
      entry({ state: 'sent', lastOutcome: 'sent', lastEvidence: 'handed-off' }),
      entry({ state: 'sent', lastOutcome: 'sent', lastEvidence: 'dialog-closed' }),
      entry({ state: 'sent', lastOutcome: 'shown', lastEvidence: 'shown' }),
      entry({ lastOutcome: 'timeout' }),
      entry({ lastOutcome: 'failed', lastDetail: 'x' }),
      entry({ lastOutcome: 'needs-pairing' }),
      entry({ lastOutcome: 'unavailable' }),
    ];
    const attempts: PrintAttempt[] = (['sent', 'shown', 'timeout', 'failed', 'needs-pairing', 'unavailable'] as const).flatMap((outcome) =>
      (['bytes-accepted', 'handed-off', 'dialog-closed', 'none'] as const).map((evidence) => ({
        transport: 'none' as const,
        outcome,
        evidence,
        detail: null,
        durationMs: 1,
        byteCount: 0,
      })),
    );
    const texts = [
      ...states.flatMap((e) => {
        const d = describePrint(e, false, { autoPrint: true });
        return [{ headline: d.headline, detail: d.detail ?? '' }];
      }),
      { headline: describePrint(null, false, { autoPrint: true }).headline, detail: '' },
      { headline: describePrint(null, true, { autoPrint: true }).headline, detail: '' },
      ...attempts.map((a) => ({ headline: '', detail: describeAttempt(a).text })),
    ];
    for (const t of texts) {
      expect(t.headline).not.toMatch(/printed/i); // a headline is a claim: never "printed"
      // The word may appear only to deny knowledge of it.
      const hits = t.detail.match(/.{0,24}printed/gi) ?? [];
      for (const h of hits) expect(h).toMatch(/(whether a page was|may or may not have) printed/i);
    }
  });

  it('says exactly what each route knows', () => {
    expect(describePrint(entry({ state: 'sent', lastOutcome: 'sent', lastEvidence: 'bytes-accepted' }), false, { autoPrint: true }).headline).toMatch(/^Sent to the printer at \d\d:\d\d$/);
    expect(describePrint(entry({ state: 'sent', lastOutcome: 'sent', lastEvidence: 'handed-off' }), false, { autoPrint: true }).headline).toMatch(/^Handed to the print app/);
    expect(describePrint(entry({ lastOutcome: 'timeout' }), false, { autoPrint: true }).detail).toMatch(/may or may not/);
  });
});

describe('after a sale, on the counter', () => {
  it('the sale is saved first; the receipt screen then says "Sent to the printer", and the sale stays one sale', async () => {
    const db = await till();
    const ble = fake('ble-escpos');
    const svc = makeService(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos' });
    render(counter(db, svc));
    await ringCashSale();

    expect(await screen.findByText('Sale recorded', { exact: false })).toBeTruthy();
    expect(await screen.findByText(/^Sent to the printer at/)).toBeTruthy();
    expect(await outboxCount(db)).toBe(1);
    expect(ble.calls).toHaveLength(1);
    // Cash-up facts are untouched by printing.
    const row = (await db.getAll('SELECT CAST(tendered_minor AS TEXT) AS t, CAST(change_minor AS TEXT) AS c FROM outbox'))[0];
    expect(row).toMatchObject({ t: '70000', c: '8000' });
  });

  it('a printer that is off does not stop the sale; Retry sends it, and nothing is re-rung', async () => {
    const db = await till();
    const ble = fake('ble-escpos');
    ble.behaviour = 'failed';
    const svc = makeService(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos' });
    render(counter(db, svc));
    await ringCashSale();

    expect(await screen.findByText('Could not reach the printer')).toBeTruthy();
    expect(screen.getByText(/Printer is off\./)).toBeTruthy();
    expect(await outboxCount(db)).toBe(1);

    ble.behaviour = 'sent';
    fireEvent.click(screen.getByRole('button', { name: /Retry print/ }));
    expect(await screen.findByText(/^Sent to the printer at/)).toBeTruthy();
    expect(await outboxCount(db)).toBe(1); // still ONE sale
    // The next customer is one tap away the whole time.
    expect(screen.getByRole('button', { name: /New sale/ })).toBeTruthy();
  });

  it('a timeout says the printer may or may not have printed, and offers retry and the on-screen receipt', async () => {
    const db = await till();
    const ble = fake('ble-escpos');
    ble.behaviour = 'timeout';
    const svc = makeService(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos' });
    render(counter(db, svc));
    await ringCashSale();
    expect(await screen.findByText('The printer did not answer')).toBeTruthy();
    expect(screen.getByText(/may or may not have come out/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry print/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Show receipt/ })).toBeTruthy();
  });

  it('with no printer chosen, routes the cashier to settings rather than dead-ending', async () => {
    const db = await till();
    const ble = fake('ble-escpos');
    ble.behaviour = 'needs-pairing';
    const svc = makeService(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos' });
    const onOpen = vi.fn();
    render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <PrintingProvider db={db} service={svc}>
          <Counter db={db} onOpenPrinterSettings={onOpen} />
        </PrintingProvider>
      </CurrencyProvider>,
    );
    await ringCashSale();
    fireEvent.click(await screen.findByRole('button', { name: /Printer settings/ }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('on the no-printer route the receipt is shown full screen with a large number, and closes to the receipt screen', async () => {
    const db = await till();
    const svc = makeService(db, fake('ble-escpos'));
    await svc.loadSettings(); // default route: none
    render(counter(db, svc));
    await ringCashSale();
    const sheet = await screen.findByRole('dialog', { name: 'Receipt' });
    const number = within(sheet).getByTestId('receipt-sheet-number');
    expect(number.textContent).toMatch(/\S/);
    expect(within(sheet).getByText(/Cement 50kg/)).toBeTruthy();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Receipt' })).toBeNull());
  });

  it('with printing unavailable altogether (no provider) the counter sells exactly as before', async () => {
    const db = await till();
    render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <Counter db={db} />
      </CurrencyProvider>,
    );
    await ringCashSale();
    expect(await screen.findByText('Sale recorded', { exact: false })).toBeTruthy();
    expect(await outboxCount(db)).toBe(1);
    expect(screen.getByRole('button', { name: /Show receipt/ })).toBeTruthy();
  });
});

describe('reprint', () => {
  it('Reprint after a send makes a copy, and leaves the sale list showing one sale', async () => {
    const db = await till();
    const ble = fake('ble-escpos');
    const svc = makeService(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos' });
    const view = render(counter(db, svc));
    await ringCashSale();
    await screen.findByText(/^Sent to the printer at/);
    fireEvent.click(screen.getByRole('button', { name: 'Reprint' }));
    await waitFor(() => expect(ble.calls).toHaveLength(2));
    expect(ble.calls[1]!.isCopy).toBe(true);
    const id = (await db.getAll('SELECT id FROM outbox'))[0]!['id'] as string;
    await waitFor(async () => expect((await getQueueEntry(db, id))?.state).toBe('sent'));
    view.unmount();

    render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <PrintingProvider db={db} service={svc}>
          <SalesList db={db} />
        </PrintingProvider>
      </CurrencyProvider>,
    );
    expect(await screen.findAllByRole('button', { name: 'Reprint' })).toHaveLength(1);
    expect(await outboxCount(db)).toBe(1);
  });
});

describe('the on-screen receipt formats money from the document, not the live pack', () => {
  it('renders at the document scale even when the live currency spec says otherwise', async () => {
    const db = await till();
    const svc = makeService(db, fake('ble-escpos'));
    await svc.loadSettings();
    render(counter(db, svc)); // live spec: the placeholder, scale 2
    await ringCashSale();
    const sheet = await screen.findByRole('dialog', { name: 'Receipt' });
    // Rung at scale 2: 62000 minor => 620.00 on the receipt.
    expect(within(sheet).getAllByText(/620\.00/).length).toBeGreaterThan(0);
  });

  it('shows the number and says so when the line detail is gone', async () => {
    const db = openTestDb();
    const svc = makeService(db, fake('ble-escpos'));
    await svc.loadSettings();
    const onClose = vi.fn();
    render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <PrintingProvider db={db} service={svc}>
          <ReceiptSheet db={db} saleId="019b0000-0000-7000-8000-000000abcdef" onClose={onClose} />
        </PrintingProvider>
      </CurrencyProvider>,
    );
    expect((await screen.findByTestId('receipt-sheet-number')).textContent).toBe('ABCDEF');
    expect(await screen.findByText(/not on this device any more/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('printer settings', () => {
  function renderSettings(db: LocalDb, svc: PrintService): void {
    render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <PrintingProvider db={db} service={svc}>
          <PrinterSettings db={db} />
        </PrintingProvider>
      </CurrencyProvider>,
    );
  }

  it('lists every route, explains the ones this device cannot use, and defaults to the on-screen receipt', async () => {
    const db = openTestDb();
    const svc = makeService(db, fake('ble-escpos'));
    await svc.loadSettings();
    renderSettings(db, svc);
    const group = await screen.findByRole('radiogroup', { name: 'Printer route' });
    expect(within(group).getAllByRole('radio')).toHaveLength(6);
    // jsdom has no Web Bluetooth, USB or Serial: unsupported, disabled, and told why.
    const ble = within(group).getByRole('radio', { name: /Route ble-escpos/ }) as HTMLInputElement;
    expect(ble.disabled).toBe(true);
    expect(within(group).getByText(/Not available on this device\. This browser has no Web Bluetooth/)).toBeTruthy();
    expect((within(group).getByRole('radio', { name: /Route none/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('chooses a printer from a tap, persists the paper width, and prints a test page with the weaker wording', async () => {
    const db = openTestDb();
    const ble = fake('ble-escpos');
    const svc = makeService(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos' });
    renderSettings(db, svc);

    fireEvent.click(await screen.findByRole('button', { name: /Choose printer/ }));
    expect(await screen.findByText(/Printer chosen\. \(Test Printer\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /80 mm/ }));
    await waitFor(() => expect(svc.settings.paperWidthMm).toBe(80));

    fireEvent.click(screen.getByRole('button', { name: /Print test page/ }));
    expect(await screen.findByText(/Sent to the printer\. Look at the paper/)).toBeTruthy();
    expect(ble.calls).toHaveLength(1);
    expect(ble.calls[0]!.doc.receiptNo).toMatch(/^TEST-/);
    // The test page is not a sale and not queued.
    expect(await outboxCount(db)).toBe(0);
    expect(Number((await db.getAll('SELECT COUNT(*) AS n FROM local_print_queue'))[0]?.['n'])).toBe(0);
  });

  it('reads at phone width: every action is a real button with a name, no horizontal scroll container needed', async () => {
    const db = openTestDb();
    const svc = makeService(db, fake('ble-escpos'));
    await svc.loadSettings();
    renderSettings(db, svc);
    await screen.findByRole('radiogroup', { name: 'Printer route' });
    for (const b of screen.getAllByRole('button')) expect((b.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('shows what is waiting to print and retries it on demand', async () => {
    const db = await till();
    const ble = fake('ble-escpos');
    ble.behaviour = 'failed';
    const svc = makeService(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos' });
    const view = render(counter(db, svc));
    await ringCashSale();
    await screen.findByText('Could not reach the printer');
    view.unmount();
    renderSettings(db, svc);
    expect(await screen.findByText(/1 receipt has not been sent to a printer/)).toBeTruthy();
    ble.behaviour = 'sent';
    fireEvent.click(screen.getByRole('button', { name: /Retry all now/ }));
    expect(await screen.findByText('Nothing is waiting.')).toBeTruthy();
  });
});

describe('spike mode', () => {
  it('runs N receipts through the chosen route and shows the numbers the pass criteria use', async () => {
    const db = openTestDb();
    const ble = fake('ble-escpos');
    const svc = makeService(db, ble);
    await svc.loadSettings();
    await svc.saveSettings({ transport: 'ble-escpos' });
    render(
      <CurrencyProvider spec={DEV_PLACEHOLDER_CURRENCY}>
        <PrintingProvider db={db} service={svc}>
          <PrinterSettings db={db} />
        </PrintingProvider>
      </CurrencyProvider>,
    );
    const spike = await screen.findByRole('region', { name: 'Hardware test' });
    const inputs = within(spike).getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(inputs[0]!, { target: { value: '5' } });
    fireEvent.change(inputs[1]!, { target: { value: '0' } });
    fireEvent.click(within(spike).getByRole('button', { name: /Start run/ }));
    await waitFor(() => expect(ble.calls).toHaveLength(5), { timeout: 5000 });
    const stats = within(spike).getByLabelText('Run results');
    await waitFor(() => expect(stats.textContent).toContain('100.00%'));
    expect(stats.textContent).toContain('Hangs (must be 0)0');
    // Spike receipts are synthetic: no sale, no queue row.
    expect(await outboxCount(db)).toBe(0);
    expect(Number((await db.getAll('SELECT COUNT(*) AS n FROM local_print_queue'))[0]?.['n'])).toBe(0);
  });
});
