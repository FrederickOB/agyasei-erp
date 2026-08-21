/**
 * Completing a sale lands HERE — on the receipt screen with the sale number
 * and its live sync badge — never back on an empty cart, because an empty
 * cart after a slow tap is the single most reliable way to manufacture a
 * duplicate (§8.5).
 */
import type { ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import { getRecordedSale } from '../../data/queries/sales';
import { useLiveQuery } from '../../data/use-live-query';
import { recordBadgeLabel } from '../../lib/badges';
import { Money } from '../../money/Money';

export function shortSaleNumber(saleId: string): string {
  return saleId.slice(-6).toUpperCase();
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

  return (
    <section className="receipt-view" aria-label="Sale recorded">
      <h2 className="receipt-heading">Sale {shortSaleNumber(saleId)} recorded</h2>
      {sale === undefined || sale === null ? null : (
        <>
          <div className="receipt-total-row">
            <span>Total</span>
            <Money amount={sale.totalMinor} className="money receipt-total" />
          </div>
          {changeMinor !== null ? (
            <div className="receipt-change-row">
              <span>Change given</span>
              <Money amount={changeMinor} />
            </div>
          ) : null}
          <p className={`sync-badge badge-${sale.syncState}`}>
            {recordBadgeLabel(sale.syncState)}
          </p>
        </>
      )}
      <button type="button" className="primary-action" onClick={onNewSale}>
        New sale
      </button>
    </section>
  );
}
