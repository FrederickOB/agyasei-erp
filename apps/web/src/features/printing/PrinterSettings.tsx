/**
 * Per-device printer settings. "Per device" is the point: the printer beside
 * THIS tablet is a fact about this tablet, so nothing here syncs.
 *
 * Reads top to bottom as the order a person sets a printer up in:
 *   1. choose the route (how this device reaches a printer) — every route that
 *      cannot work on this device is still listed, with the reason, so nobody
 *      hunts for an option that is not there;
 *   2. choose/pair the printer (a tap, because browsers insist on a gesture);
 *   3. paper width and the few printer behaviours;
 *   4. print a test page;
 *   5. see what is waiting to print, and the hardware spike.
 *
 * Touch targets are the counter's 48-56 px; at phone width (360 px) everything
 * stacks in one column; on a laptop the cards sit in a two-column grid.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import { useLiveQuery } from '../../data/use-live-query';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { listPending } from '../../printing/queue';
import type { PrinterSettings as Settings } from '../../printing/settings';
import { defaultTransportEnvs, detectSupport } from '../../printing/transports/registry';
import { ALL_TRANSPORT_IDS, type PrintAttempt, type TransportHealth, type TransportId } from '../../printing/transports/types';
import { Icon } from '../../ui/Icon';
import { usePrintService, usePrintServiceState } from './PrintingContext';
import { PrinterSpike } from './PrinterSpike';
import { describeAttempt } from './status-text';

const ROUTE_HELP: Readonly<Record<TransportId, string>> = {
  'ble-escpos': 'A Bluetooth printer beside the tablet, if it is a Bluetooth LE model.',
  'webusb-escpos': 'A printer on a USB cable.',
  'web-serial': 'A laptop with a printer paired in the system Bluetooth settings, or on a USB-serial cable.',
  'android-print-bridge': 'An Android terminal with a built-in printer, or a classic Bluetooth printer, through a print app.',
  'system-print': 'The normal print dialog: A4 invoices, or a roll printer with a system driver.',
  none: 'No printer. The receipt is shown on screen with a large number.',
};

const NEEDS_PAIRING: ReadonlySet<TransportId> = new Set(['ble-escpos', 'webusb-escpos', 'web-serial']);

export function PrinterSettings({ db }: { readonly db: LocalDb }): ReactNode {
  const svc = usePrintService();
  const { settings } = usePrintServiceState(svc);
  const currency = useCurrencySpec();
  const support = useMemo(() => detectSupport(defaultTransportEnvs()), []);
  const [health, setHealth] = useState<TransportHealth | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ tone: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useLiveQuery(db, listPending, []);

  const transport = settings?.transport ?? 'none';
  useEffect(() => {
    if (svc === null) return;
    let alive = true;
    setHealth(null);
    void svc.probe(transport).then((h) => {
      if (alive) setHealth(h);
    });
    return () => {
      alive = false;
    };
  }, [svc, transport, settings?.devices]);

  if (svc === null || settings === null) {
    return (
      <div className="empty-state">
        <Icon name="printer" size={40} />
        <span className="empty-title">Printer settings are not available</span>
        <p className="empty-body">The receipt can still be shown on screen after every sale.</p>
      </div>
    );
  }

  const set = (patch: Partial<Settings>): void => {
    void svc.saveSettings(patch);
  };

  const pair = (): void => {
    // Called straight from the tap, so the browser sees a user gesture.
    setBusy(true);
    setMessage(null);
    void svc
      .pair(transport)
      .then((r) => setMessage(r.ok ? `${r.detail}${r.printerName === null ? '' : ` (${r.printerName})`}` : r.detail))
      .finally(() => setBusy(false));
  };

  const check = (): void => {
    setBusy(true);
    void svc
      .probe(transport, true)
      .then(setHealth)
      .finally(() => setBusy(false));
  };

  const test = (): void => {
    setBusy(true);
    setTestResult(null);
    void svc
      .printTest(currency)
      .then((a: PrintAttempt) => setTestResult(describeAttempt(a)))
      .finally(() => setBusy(false));
  };

  const remembered = settings.devices[transport]?.name ?? null;
  const supportedFirst = [...ALL_TRANSPORT_IDS].sort(
    (a, b) => Number(support[b].supported) - Number(support[a].supported),
  );

  return (
    <section className="printer-screen" aria-label="Printer settings">
      <h2 className="printer-h2">Printer on this device</h2>
      <p className="printer-note">
        These settings belong to this device only. Sales never wait for the printer: the sale is saved first, and
        a receipt that fails to print can be retried from the sale.
      </p>

      <fieldset className="printer-card">
        <legend className="printer-h3">How this device reaches a printer</legend>
        <div className="printer-routes" role="radiogroup" aria-label="Printer route">
          {supportedFirst.map((id) => {
            const s = support[id];
            return (
              <label key={id} className={`printer-route${transport === id ? ' printer-route-on' : ''}${s.supported ? '' : ' printer-route-off'}`}>
                <input
                  type="radio"
                  name="printer-route"
                  value={id}
                  checked={transport === id}
                  disabled={!s.supported}
                  onChange={() => set({ transport: id })}
                />
                <span className="printer-route-text">
                  <strong>{svc.transport(id).label}</strong>
                  <span>{s.supported ? ROUTE_HELP[id] : `Not available on this device. ${s.reason}`}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <section className="printer-card" aria-label="Chosen printer">
        <h3 className="printer-h3">Printer</h3>
        <p className={`printer-health printer-health-${health?.state ?? 'unknown'}`} role="status">
          <Icon name={health?.state === 'ready' ? 'check' : 'clock'} size={18} />
          <span>
            {health === null ? 'Checking...' : health.detail}
            {remembered === null ? '' : ` Chosen: ${remembered}.`}
          </span>
        </p>
        <div className="print-actions">
          {NEEDS_PAIRING.has(transport) ? (
            <button type="button" className="primary-action pressable" onClick={pair} disabled={busy}>
              <Icon name="printer" size={20} />
              {remembered === null ? 'Choose printer' : 'Choose a different printer'}
            </button>
          ) : null}
          {NEEDS_PAIRING.has(transport) || transport === 'android-print-bridge' ? (
            <button type="button" className="secondary-action pressable" onClick={check} disabled={busy}>
              Check connection
            </button>
          ) : null}
          {remembered !== null ? (
            <button type="button" className="secondary-action pressable" onClick={() => void svc.forget(transport)}>
              Forget printer
            </button>
          ) : null}
        </div>
        {message === null ? null : (
          <p className="printer-note" role="status">
            {message}
          </p>
        )}
        {transport === 'android-print-bridge' ? (
          <label className="printer-field">
            <span>Print app package</span>
            <input
              value={settings.bridgePackage}
              onChange={(e) => set({ bridgePackage: e.target.value })}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <small>
              This route needs a print-service app installed and set up on the tablet, with its own printer chosen.
              This device cannot detect whether it is installed.
            </small>
          </label>
        ) : null}
      </section>

      <section className="printer-card" aria-label="Paper and behaviour">
        <h3 className="printer-h3">Paper</h3>
        <div className="chip-row" role="group" aria-label="Paper width">
          {([58, 80] as const).map((mm) => (
            <button
              key={mm}
              type="button"
              className="chip pressable"
              aria-pressed={settings.paperWidthMm === mm}
              onClick={() => set({ paperWidthMm: mm })}
            >
              {mm} mm ({mm === 58 ? 32 : 48} columns)
            </button>
          ))}
        </div>
        {transport === 'system-print' ? (
          <div className="chip-row" role="group" aria-label="Browser print layout">
            {(['roll', 'a4'] as const).map((l) => (
              <button
                key={l}
                type="button"
                className="chip pressable"
                aria-pressed={settings.systemLayout === l}
                onClick={() => set({ systemLayout: l })}
              >
                {l === 'a4' ? 'A4 invoice' : 'Roll receipt'}
              </button>
            ))}
          </div>
        ) : null}
        <label className="printer-toggle">
          <input type="checkbox" checked={settings.autoPrint} onChange={(e) => set({ autoPrint: e.target.checked })} />
          <span>Send each receipt to the printer as soon as the sale is saved</span>
        </label>
        <label className="printer-toggle">
          <input type="checkbox" checked={settings.cut !== 'none'} onChange={(e) => set({ cut: e.target.checked ? 'partial' : 'none' })} />
          <span>Cut the paper after each receipt</span>
        </label>
        <label className="printer-toggle">
          <input type="checkbox" checked={settings.kickDrawer} onChange={(e) => set({ kickDrawer: e.target.checked })} />
          <span>Open the cash drawer with each new receipt (never on a reprint)</span>
        </label>
        <details className="printer-advanced">
          <summary>Advanced</summary>
          <label className="printer-field">
            <span>Character set</span>
            <select value={settings.codePage} onChange={(e) => set({ codePage: e.target.value === 'ascii' ? 'ascii' : 'cp437' })}>
              <option value="cp437">Standard (CP437)</option>
              <option value="ascii">Plain ASCII only</option>
            </select>
          </label>
          <NumberField label="Give up waiting after (ms)" value={settings.timeoutMs} onCommit={(n) => set({ timeoutMs: n })} />
          <NumberField label="Bluetooth chunk size (bytes)" value={settings.chunkBytes} onCommit={(n) => set({ chunkBytes: n })} />
          <NumberField label="Pause between chunks (ms)" value={settings.chunkDelayMs} onCommit={(n) => set({ chunkDelayMs: n })} />
          <NumberField label="Serial speed (baud)" value={settings.baudRate} onCommit={(n) => set({ baudRate: n })} />
        </details>
      </section>

      <section className="printer-card" aria-label="Test page">
        <h3 className="printer-h3">Test page</h3>
        <p className="printer-note">Prints a sample receipt. It is not a sale and is not recorded.</p>
        <div className="print-actions">
          <button type="button" className="primary-action pressable" onClick={test} disabled={busy}>
            <Icon name="printer" size={20} />
            Print test page
          </button>
        </div>
        {testResult === null ? null : (
          <p className={`print-status-line print-tone-${testResult.tone}`} role="status">
            <Icon name={testResult.tone === 'ok' ? 'check' : 'alert'} size={18} />
            <span>{testResult.text}</span>
          </p>
        )}
      </section>

      <section className="printer-card" aria-label="Waiting to print">
        <h3 className="printer-h3">Waiting to print</h3>
        {pending === undefined ? null : pending.length === 0 ? (
          <p className="printer-note">Nothing is waiting.</p>
        ) : (
          <>
            <p className="printer-note" role="status">
              {pending.length === 1 ? '1 receipt has' : `${String(pending.length)} receipts have`} not been sent to a printer.
              They retry by themselves when the printer is back; you can also retry now.
            </p>
            <ul className="printer-pending">
              {pending.slice(0, 8).map((e) => (
                <li key={e.saleId} className="tabular">
                  {e.receiptNo}
                  {e.lastDetail === null ? '' : ` - ${e.lastDetail}`}
                </li>
              ))}
            </ul>
            <div className="print-actions">
              <button type="button" className="secondary-action pressable" onClick={() => void svc.drain()}>
                <Icon name="printer" size={20} />
                Retry all now
              </button>
            </div>
          </>
        )}
      </section>

      <PrinterSpike svc={svc} />
    </section>
  );
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly onCommit: (n: number) => void;
}): ReactNode {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="printer-field">
      <span>{label}</span>
      <input
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number.parseInt(text, 10);
          if (Number.isFinite(n)) onCommit(n);
          else setText(String(value));
        }}
      />
    </label>
  );
}
