/**
 * "Recent sales" — one tap from the counter, always (§8.5). The last 20 sales
 * with their totals and their per-record sync badges, so "did that go
 * through?" is answered without the network and without a manager.
 */
import type { ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import { recentSales, type RecordedSale } from '../../data/queries/sales';
import { useLiveQuery } from '../../data/use-live-query';
import { recordBadgeLabel } from '../../lib/badges';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { saleNumberLabel } from '../counter/ReceiptView';
import { PrintStatus } from '../printing/PrintStatus';

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * What the server said, on the record it said it about — the surface stock
 * adjustments, goods receipts and delivery updates have always had and this
 * list never did. Two different sentences, because they are two different
 * situations for the person reading them:
 *
 * - DEAD-LETTERED: the sale is not going anywhere on its own; it is work.
 * - REFUSED BUT STILL QUEUED: the till is still trying, so the copy must not
 *   read as failure — but a sale that has been refused rather than merely
 *   waiting for a signal is not the same thing as one that is waiting, and the
 *   badge alone ("Waiting to send") cannot tell them apart.
 */
function ServerAnswer({ sale }: { readonly sale: RecordedSale }): ReactNode {
  if (sale.syncState === 'attention') {
    return (
      <p className="sales-answer sales-answer-attn" role="status">
        <Icon name="alert" size={18} />
        <span>
          The office refused this sale, so it has not been recorded there. Tell your manager.
          {sale.rejectReason === null ? null : (
            <>
              {' '}
              <span className="server-answer-detail-label">They will want to know:</span>{' '}
              <span className="tabular">{sale.rejectReason}</span>
            </>
          )}
        </span>
      </p>
    );
  }
  if (sale.syncState === 'pending' && sale.lastRefusalReason !== null) {
    return (
      <p className="sales-answer sales-answer-wait" role="status">
        <Icon name="alert" size={18} />
        <span>
          The office has not accepted this sale yet and the till is still trying.{' '}
          <span className="server-answer-detail-label">It last said:</span>{' '}
          <span className="tabular">{sale.lastRefusalReason}</span>
        </span>
      </p>
    );
  }
  return null;
}

export function SalesList({
  db,
  onOpenPrinterSettings,
}: {
  readonly db: LocalDb;
  readonly onOpenPrinterSettings?: () => void;
}): ReactNode {
  const sales = useLiveQuery(db, (d) => recentSales(d, 20), []);

  // Not `null` while the read resolves: a blank panel where a list belongs
  // reads as "nothing sold today", which is the one answer this screen must
  // never give by accident.
  if (sales === undefined) {
    return (
      <ul className="sales-list" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className="skeleton skeleton-row" />
        ))}
      </ul>
    );
  }
  if (sales.length === 0) {
    return (
      <div className="empty-state">
        <Icon name="receipt" size={40} />
        <span className="empty-title">No sales yet</span>
        <p className="empty-body">
          Sales rung up on this device appear here with their sending state — including the ones
          taken while offline.
        </p>
      </div>
    );
  }
  return (
    <ul className="sales-list" aria-label="Recent sales">
      {sales.map((sale) => (
        <li key={sale.id} className="sales-row">
          <span className="sales-number">Sale {saleNumberLabel(sale)}</span>
          <Money amount={sale.totalMinor} className="money sales-total" />
          <span className="sales-meta">
            <span className="tabular">{timeOf(sale.createdAt)}</span>
            <span className={`sync-badge badge-${sale.syncState}`}>
              <Icon
                name={
                  sale.syncState === 'synced' ? 'check' : sale.syncState === 'pending' ? 'clock' : 'alert'
                }
                size={14}
              />
              {recordBadgeLabel(sale.syncState)}
            </span>
          </span>
          <ServerAnswer sale={sale} />
          <PrintStatus db={db} saleId={sale.id} onOpenSettings={onOpenPrinterSettings} showStatus={false} />
        </li>
      ))}
    </ul>
  );
}
