/**
 * Completing a sale lands HERE — on the receipt screen with the sale number
 * and its live sync badge — never back on an empty cart, because an empty
 * cart after a slow tap is the single most reliable way to manufacture a
 * duplicate (§8.5).
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
}: {
  readonly db: LocalDb;
  readonly saleId: string;
  readonly changeMinor: bigint | null;
  readonly onNewSale: () => void;
}): ReactNode {
  const sale = useLiveQuery(db, (d) => getRecordedSale(d, saleId), [saleId]);
  const tenders = useLiveQuery(db, (d) => getRecordedSaleTenders(d, saleId), [saleId]);
  const heading =
    sale === undefined || sale === null ? shortSaleNumber(saleId) : saleNumberLabel(sale);

  return (
    <section className="receipt-view" aria-label="Sale recorded">
      {/* The affirmative moment, and the number to quote, are the two things
          this screen exists for — so they are the two biggest things on it. */}
      <span className="receipt-crest">
        <Icon name="check" size={30} />
      </span>
      <h2 className="receipt-heading">
        Sale recorded
        <span className="receipt-number tabular">{heading}</span>
      </h2>
      {sale === undefined || sale === null ? null : (
        <>
          <div className="receipt-rows">
            <div className="total-row">
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
            {changeMinor !== null ? (
              <div className="total-row">
                <span className="total-label">Change given</span>
                <Money amount={changeMinor} className="money" />
              </div>
            ) : null}
          </div>
          <p className={`sync-badge badge-${sale.syncState}`}>
            <Icon name={sale.syncState === 'synced' ? 'check' : sale.syncState === 'pending' ? 'clock' : 'alert'} size={16} />
            {recordBadgeLabel(sale.syncState)}
          </p>
        </>
      )}
      <button type="button" className="primary-action pressable" onClick={onNewSale}>
        <Icon name="cart" size={20} />
        New sale
      </button>
    </section>
  );
}
