/**
 * Completing a sale lands HERE — on the receipt screen with the sale number
 * and its live sync badge — never back on an empty cart, because an empty
 * cart after a slow tap is the single most reliable way to manufacture a
 * duplicate (§8.5).
 *
 * WHAT GOES BACK, FIRST. When cash changed hands the screen leads with the
 * change to give and the cash it came out of ("755.00 change, out of
 * 2,000.00 received") — the two figures a cashier reads aloud while counting
 * it out, and the two a customer disputes. Both are the device's own record
 * of the moment (`tendered_minor`, `change_minor` on the outbox row), not a
 * recomputation; the tender rows beneath say what each method SETTLED.
 *
 * The number shown is the DEVICE-ALLOCATED receipt number (03 §3.7.5): the
 * one the customer's copy carries, allocated offline from this device's block,
 * and the one to quote when a sale is queried. The short form of the sale id
 * is only a fallback for a record written before a number existed — a receipt
 * screen must always show something a person can read back.
 */
import type { ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import {
  getRecordedSale,
  getRecordedSaleTenders,
  type RecordedSale,
} from '../../data/queries/sales';
import { useLiveQuery } from '../../data/use-live-query';
import { recordBadgeLabel } from '../../lib/badges';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { usePrintService } from '../printing/PrintingContext';
import { PrintStatus } from '../printing/PrintStatus';

export function shortSaleNumber(saleId: string): string {
  return saleId.slice(-6).toUpperCase();
}

/** What a human quotes back at the counter. */
export function saleNumberLabel(sale: Pick<RecordedSale, 'id' | 'receiptNo'>): string {
  return sale.receiptNo ?? shortSaleNumber(sale.id);
}

export function ReceiptView({
  db,
  saleId,
  changeMinor,
  onNewSale,
  onOpenPrinterSettings,
}: {
  readonly db: LocalDb;
  readonly saleId: string;
  readonly changeMinor: bigint | null;
  readonly onNewSale: () => void;
  readonly onOpenPrinterSettings?: () => void;
}): ReactNode {
  const sale = useLiveQuery(db, (d) => getRecordedSale(d, saleId), [saleId]);
  const tenders = useLiveQuery(db, (d) => getRecordedSaleTenders(d, saleId), [saleId]);
  // On the no-printer route the on-screen receipt IS the receipt (§8.8, `none`).
  const printing = usePrintService();
  const showReceiptNow = printing !== null && printing.settings.transport === 'none';
  const heading =
    sale === undefined || sale === null ? shortSaleNumber(saleId) : saleNumberLabel(sale);

  // The record's own figures win; the prop (what checkout just returned) is
  // the fallback for a row written without a change figure.
  const receivedMinor = sale === undefined || sale === null ? null : sale.tenderedMinor;
  const givenMinor = sale !== undefined && sale !== null && sale.changeMinor !== null ? sale.changeMinor : changeMinor;
  const changeDue = givenMinor !== null && givenMinor > 0n ? givenMinor : null;

  return (
    <section className="receipt-view" aria-label="Sale recorded">
      {/* The affirmative moment and the number to quote: the sale is safe. */}
      <div className="receipt-top">
        <span className="receipt-crest">
          <Icon name="check" size={30} />
        </span>
        <h2 className="receipt-heading">
          Sale recorded
          <span className="receipt-number tabular">{heading}</span>
        </h2>
      </div>
      {sale === undefined || sale === null ? null : (
        <>
          {receivedMinor !== null && receivedMinor > 0n ? (
            <div className={`receipt-change${changeDue === null ? ' none-due' : ''}`}>
              <span className="receipt-change-label">{changeDue === null ? 'No change due' : 'Change to give'}</span>
              {changeDue === null ? null : <Money amount={changeDue} className="money receipt-change-value" />}
              <span className="receipt-received">
                out of <Money amount={receivedMinor} className="money receipt-received-value" /> cash received
              </span>
            </div>
          ) : null}
          <div className="receipt-rows">
            <div className="total-row receipt-total-row">
              <span className="total-label">Total</span>
              <Money amount={sale.totalMinor} className="money receipt-total" />
            </div>
            {/* How it was paid: one row per method, with the reference a
                momo or cheque line carried — what the customer will quote. */}
            {(tenders ?? []).map((t, i) => (
              <div className="total-row receipt-tender" key={`${t.name}-${String(i)}`}>
                <span className="total-label">
                  {t.name}
                  {t.reference === null ? null : <small className="receipt-tender-ref"> · {t.reference}</small>}
                </span>
                <Money amount={t.amountMinor} className="money" />
              </div>
            ))}
          </div>
          <p className={`sync-badge badge-${sale.syncState}`}>
            <Icon name={sale.syncState === 'synced' ? 'check' : sale.syncState === 'pending' ? 'clock' : 'alert'} size={16} />
            {recordBadgeLabel(sale.syncState)}
          </p>
        </>
      )}
      {/* After the sale facts and before the next sale: what happened to the
          paper copy, said as weakly as it is known, with a way to retry or to
          show the receipt on screen. The sale above is already saved. */}
      <PrintStatus db={db} saleId={saleId} onOpenSettings={onOpenPrinterSettings} autoOpen={showReceiptNow} />
      <button type="button" className="primary-action new-sale-action pressable" onClick={onNewSale}>
        <Icon name="cart" size={22} />
        New sale
      </button>
    </section>
  );
}
