/**
 * "Recent sales" — one tap from the counter, always (§8.5). The last 20 sales
 * with their totals and their per-record sync badges, so "did that go
 * through?" is answered without the network and without a manager.
 */
import type { ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import { recentSales } from '../../data/queries/sales';
import { useLiveQuery } from '../../data/use-live-query';
import { recordBadgeLabel } from '../../lib/badges';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { saleNumberLabel } from '../counter/ReceiptView';

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function SalesList({ db }: { readonly db: LocalDb }): ReactNode {
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
        </li>
      ))}
    </ul>
  );
}
