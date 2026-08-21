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
import { saleNumberLabel } from '../counter/ReceiptView';

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function SalesList({ db }: { readonly db: LocalDb }): ReactNode {
  const sales = useLiveQuery(db, (d) => recentSales(d, 20), []);

  if (sales === undefined) return null;
  if (sales.length === 0) {
    return <p className="sales-empty">No sales recorded on this device yet.</p>;
  }
  return (
    <ul className="sales-list" aria-label="Recent sales">
      {sales.map((sale) => (
        <li key={sale.id} className="sales-row">
          <span className="sales-number">Sale {saleNumberLabel(sale)}</span>
          <span className="sales-time">{timeOf(sale.createdAt)}</span>
          <Money amount={sale.totalMinor} className="money sales-total" />
          <span className={`sync-badge badge-${sale.syncState}`}>
            {recordBadgeLabel(sale.syncState)}
          </span>
        </li>
      ))}
    </ul>
  );
}
