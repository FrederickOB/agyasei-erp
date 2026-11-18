/**
 * Print status for one sale, with the actions that follow from it. Sits on the
 * receipt screen and in each row of recent sales.
 *
 * Everything on it is a retry or a reprint of a COMPLETED sale. Nothing here can
 * re-ring, edit or re-sync one, and "Show receipt" works whatever the printer is
 * doing — the mandatory `none` fallback.
 */
import { useState, type ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import { useLiveQuery } from '../../data/use-live-query';
import { getQueueEntry } from '../../printing/queue';
import { Icon } from '../../ui/Icon';
import { usePrintService, usePrintServiceState } from './PrintingContext';
import { ReceiptSheet } from './ReceiptSheet';
import { describePrint } from './status-text';

export function PrintStatus({
  db,
  saleId,
  onOpenSettings,
  showStatus = true,
  autoOpen = false,
}: {
  readonly db: LocalDb;
  readonly saleId: string;
  readonly onOpenSettings?: (() => void) | undefined;
  /** Rows in a list show the actions only when there is something to act on. */
  readonly showStatus?: boolean;
  /** Open the on-screen receipt straight away (the no-printer route). */
  readonly autoOpen?: boolean;
}): ReactNode {
  const svc = usePrintService();
  const { settings } = usePrintServiceState(svc);
  const entry = useLiveQuery(db, (d) => getQueueEntry(d, saleId), [saleId]);
  const [sheet, setSheet] = useState(autoOpen);
  const [pendingNote, setPendingNote] = useState<string | null>(null);

  const printing = svc?.isPrinting(saleId) ?? false;
  const status = describePrint(entry ?? null, printing, { autoPrint: settings?.autoPrint ?? false });
  const onNone = settings?.transport === 'none';

  const retry = (): void => {
    setPendingNote(null);
    if (svc === null) return;
    void svc.print(saleId);
  };
  const reprint = (): void => {
    if (svc === null) {
      setSheet(true);
      return;
    }
    void svc.reprint(saleId).then((r) => {
      if (r === 'no-document') {
        setPendingNote('The receipt details are not on this device any more. They return once the sale has synced.');
      } else setPendingNote(null);
    });
  };

  return (
    <div className="print-status">
      {entry === undefined || !showStatus ? null : (
        <p className={`print-status-line print-tone-${status.tone}`} role="status">
          <Icon name={status.tone === 'ok' ? 'check' : status.tone === 'attention' ? 'alert' : 'clock'} size={18} />
          <span>
            <strong>{status.headline}</strong>
            {status.detail === null ? null : <span className="print-status-detail"> {status.detail}</span>}
          </span>
        </p>
      )}
      {pendingNote === null ? null : (
        <p className="print-status-line print-tone-attention" role="status">
          <Icon name="alert" size={18} />
          <span>{pendingNote}</span>
        </p>
      )}
      <div className="print-actions">
        {/* The fallback is the biggest button when there is no printer to wait for. */}
        <button
          type="button"
          className={`${onNone || svc === null ? 'primary-action' : 'secondary-action'} pressable`}
          onClick={() => setSheet(true)}
        >
          <Icon name="receipt" size={20} />
          Show receipt
        </button>
        {svc === null || entry === undefined ? null : status.action === 'retry' ? (
          <button type="button" className="secondary-action pressable" onClick={retry} disabled={printing}>
            <Icon name="printer" size={20} />
            Retry print
          </button>
        ) : status.action === 'reprint' ? (
          <button type="button" className="secondary-action pressable" onClick={reprint} disabled={printing}>
            <Icon name="printer" size={20} />
            Reprint
          </button>
        ) : status.action === 'settings' && onOpenSettings !== undefined ? (
          <button type="button" className="secondary-action pressable" onClick={onOpenSettings}>
            <Icon name="printer" size={20} />
            Printer settings
          </button>
        ) : null}
      </div>
      {sheet ? <ReceiptSheet db={db} saleId={saleId} onClose={() => setSheet(false)} /> : null}
    </div>
  );
}
