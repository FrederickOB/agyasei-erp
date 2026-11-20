/**
 * The on-screen receipt — the `none` transport made visible, and a fallback every
 * transport has. Full screen, with the receipt number as large as the screen
 * allows: if the printer is dead, the cashier can read the number out, write it
 * down, or let the customer photograph the screen, and the sale is still
 * provable.
 *
 * It renders from the same fitted lines the printer prints (`layoutReceipt`),
 * with money formatted from the DOCUMENT's own scale — never `useCurrencySpec`,
 * which is the live pack (§8.3).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import { getRecordedSale } from '../../data/queries/sales';
import { useLiveQuery } from '../../data/use-live-query';
import { SCREEN_PAGE } from '../../printing/codepage';
import { layoutReceipt } from '../../printing/layout';
import { loadReceiptDocument } from '../../printing/receipt-source';
import { Icon } from '../../ui/Icon';

const SCREEN_COLUMNS = 40;

export function ReceiptSheet({
  db,
  saleId,
  onClose,
}: {
  readonly db: LocalDb;
  readonly saleId: string;
  readonly onClose: () => void;
}): ReactNode {
  const doc = useLiveQuery(db, (d) => loadReceiptDocument(d, saleId), [saleId]);
  const sale = useLiveQuery(db, (d) => getRecordedSale(d, saleId), [saleId]);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const number =
    doc !== undefined && doc !== null
      ? doc.receiptNo
      : sale !== undefined && sale !== null
        ? (sale.receiptNo ?? sale.id.slice(-6).toUpperCase())
        : saleId.slice(-6).toUpperCase();

  const lines = doc === undefined || doc === null ? [] : layoutReceipt(doc, { columns: SCREEN_COLUMNS, page: SCREEN_PAGE });

  return (
    <div
      className="receipt-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Receipt"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="receipt-sheet-bar">
        <button ref={closeRef} type="button" className="secondary-action pressable" onClick={onClose}>
          <Icon name="close" size={20} />
          Close
        </button>
      </div>
      <p className="receipt-sheet-label">Receipt number</p>
      <p className="receipt-sheet-number tabular" data-testid="receipt-sheet-number">
        {number}
      </p>
      {doc === undefined ? null : doc === null ? (
        <p className="receipt-sheet-missing" role="status">
          The line-by-line details are not on this device any more. The number above identifies this sale.
        </p>
      ) : (
        <div className="receipt-sheet-paper" aria-label="Receipt details">
          {lines.map((l, i) => {
            if (l.kind === 'blank') return <div key={i} className="rs-line">&nbsp;</div>;
            if (l.kind === 'rule') return <div key={i} className="rs-line rs-rule" aria-hidden="true" />;
            if (l.kind === 'qr') return <div key={i} className="rs-line rs-center">(QR code appears on the paper receipt)</div>;
            return (
              <div
                key={i}
                className={`rs-line${l.align === 'center' ? ' rs-center' : l.align === 'right' ? ' rs-right' : ''}${l.bold ? ' rs-bold' : ''}${l.tall === 2 ? ' rs-tall' : ''}`}
              >
                {l.text.length === 0 ? ' ' : l.text}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
