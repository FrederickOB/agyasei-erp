/**
 * VOID OR RETURN — from a sale, at the counter, with the radio off (08 §8.7;
 * migration 0030).
 *
 *   sale → "Void" or "Return items" → (lines, quantity, shelf or damaged) →
 *   how the money goes back → a reason → a DELIBERATE confirm that names the
 *   amount → the slip prints.
 *
 * A void or a refund is a real, ledger-visible event that takes money out of a
 * drawer, so it is the one place 08 §8.7 asks for a second step and a reason
 * rather than an undo bar. Everything the screen shows is computed by the rule
 * the server will run (`priceReturn`), from the sale's own snapshot — the refund
 * on the confirm button is the refund the books will record.
 *
 * Offered by capability AT THIS LOCATION (`sale.void`, `sale.return`), as a
 * courtesy: the server re-checks both at ingest and bounds a return by its own
 * figure. Tablet-first; every control is a full-width row at 360 px.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CAPABILITY, holdsCapabilityAt, type PermissionsState } from '../../data/api/session';
import type { LocalDb } from '../../data/db';
import { getOrCreateDeviceNode } from '../../data/queries/config';
import {
  loadReturnableSale,
  priceReturn,
  ReturnPickError,
  type PricedReturn,
  type ReturnableSale,
  type ReturnPick,
} from '../../data/queries/returns';
import { readDeviceLocation } from '../../data/queries/session';
import { loadTenderMethods, type TenderMethod } from '../../data/queries/tender-methods';
import { recordReturn, recordVoid, SaleReturnError, type RecordedReturn } from '../../data/mutations/saleReturn';
import { readOpenTill } from '../../data/mutations/till';
import { useLiveQuery } from '../../data/use-live-query';
import { createClaimedHlcClock, type ClaimedHlcClock } from '../../lib/hlc';
import { formatQtyScaled } from '../../lib/quantity';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';
import { usePrintService } from '../printing/PrintingContext';
import { PrintStatus } from '../printing/PrintStatus';

type Mode = 'choose' | 'void' | 'return';

/** Product chrome. A tenant's own reason list is a later configuration surface. */
const QUICK_REASONS = ['Rung in error', 'Customer changed their mind', 'Damaged', 'Wrong item'] as const;

function scaleStep(scale: number): bigint {
  return 10n ** BigInt(scale);
}

export function ReturnFlow({
  db,
  saleKey,
  permissions,
  onDone,
  onOpenPrinterSettings,
}: {
  readonly db: LocalDb;
  readonly saleKey: string;
  readonly permissions: PermissionsState;
  readonly onDone: () => void;
  readonly onOpenPrinterSettings?: () => void;
}): ReactNode {
  const spec = useCurrencySpec();
  const printing = usePrintService();
  const sale = useLiveQuery(db, (d) => loadReturnableSale(d, saleKey), [saleKey]);
  const till = useLiveQuery(db, readOpenTill, []);
  const location = useLiveQuery(db, readDeviceLocation, []);
  const methods = useLiveQuery(db, loadTenderMethods, []);
  const hlcRef = useRef<ClaimedHlcClock | null>(null);
  useEffect(() => {
    void getOrCreateDeviceNode(db).then((node) => {
      hlcRef.current = createClaimedHlcClock(node);
    });
  }, [db]);

  const [mode, setMode] = useState<Mode>('choose');
  const [qty, setQty] = useState<Record<number, bigint>>({});
  const [damaged, setDamaged] = useState<Record<number, boolean>>({});
  const [methodId, setMethodId] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<RecordedReturn | null>(null);

  const immediate = useMemo(() => (methods ?? []).filter((m) => !m.isOnAccount), [methods]);
  const method: TenderMethod | null =
    immediate.find((m) => m.id === methodId) ?? immediate.find((m) => m.isCash) ?? immediate[0] ?? null;

  const picks: ReturnPick[] = (sale?.lines ?? []).map((l) => ({
    lineNo: l.lineNo,
    qty: qty[l.lineNo] ?? 0n,
    disposition: damaged[l.lineNo] === true ? 'DAMAGED' : 'RESTOCK',
  }));
  let priced: PricedReturn | null = null;
  let pickProblem: string | null = null;
  if (mode === 'return' && sale !== undefined && sale !== null) {
    try {
      priced = priceReturn(sale, picks);
    } catch (e) {
      pickProblem = e instanceof ReturnPickError ? e.message : 'These quantities cannot be returned.';
    }
  }

  if (sale === undefined || till === undefined || location === undefined) {
    return <div className="skeleton skeleton-row" aria-hidden="true" />;
  }
  if (sale === null) {
    return (
      <section className="return-flow">
        <p className="sale-refused" role="alert">
          <Icon name="alert" size={22} />
          <span>This device does not hold that sale.</span>
        </p>
        <button type="button" className="secondary-action pressable" onClick={onDone}>
          <Icon name="back" size={20} /> Back to sales
        </button>
      </section>
    );
  }

  const here = location?.id ?? '';
  const mayVoid = holdsCapabilityAt(permissions, CAPABILITY.saleVoid, here);
  const mayReturn = holdsCapabilityAt(permissions, CAPABILITY.saleReturn, here);
  const voidable = till !== null && sale.cashSessionId === till.id && !sale.alreadyVoided && !sale.anyReturned;
  const returnable = sale.synced && !sale.alreadyVoided && sale.lines.some((l) => l.remainingQty > 0n);

  if (done !== null) {
    return (
      <section className="return-flow" aria-label="Refund recorded">
        <span className="receipt-crest">
          <Icon name="check" size={30} />
        </span>
        <h2 className="receipt-heading">
          {done.kind === 'VOID' ? 'Sale voided' : 'Return recorded'}
          <span className="receipt-number tabular">{done.returnNo}</span>
        </h2>
        <div className="receipt-rows">
          {done.cashOutMinor > 0n ? (
            <div className="total-row">
              <span className="total-label">Cash to hand back</span>
              <Money amount={done.cashOutMinor} className="money receipt-total" />
            </div>
          ) : null}
          {done.onAccountMinor > 0n ? (
            <div className="total-row">
              <span className="total-label">Credited to the customer’s account</span>
              <Money amount={done.onAccountMinor} className="money" />
            </div>
          ) : null}
          {done.totalMinor - done.cashOutMinor - done.onAccountMinor > 0n ? (
            <div className="total-row">
              <span className="total-label">Refunded by {method?.name ?? 'transfer'}</span>
              <Money amount={done.totalMinor - done.cashOutMinor - done.onAccountMinor} className="money" />
            </div>
          ) : null}
        </div>
        <PrintStatus db={db} saleId={done.returnId} onOpenSettings={onOpenPrinterSettings} />
        <button type="button" className="primary-action pressable" onClick={onDone}>
          <Icon name="receipt" size={20} /> Back to sales
        </button>
      </section>
    );
  }

  const confirm = async (): Promise<void> => {
    const hlc = hlcRef.current;
    if (hlc === null || busy) return;
    setBusy(true);
    setRefusal(null);
    const before: ReturnableSale = sale;
    try {
      if (mode === 'void') {
        const r = await recordVoid(db, { saleKey, reason, hlc });
        setDone(r);
        if (printing !== null) {
          void printing.afterReturn(
            { returnId: r.returnId, returnNo: r.returnNo, kind: 'VOID', createdAt: new Date().toISOString(),
              businessDate: till?.businessDate ?? '', sale: before, priced: null, method: null, reference: null },
            spec,
          );
        }
      } else if (method !== null) {
        const r = await recordReturn(db, {
          saleKey, reason, hlc, picks, method, ...(reference.trim().length === 0 ? {} : { reference }),
        });
        setDone(r);
        if (printing !== null) {
          void printing.afterReturn(
            { returnId: r.returnId, returnNo: r.returnNo, kind: 'RETURN', createdAt: new Date().toISOString(),
              businessDate: till?.businessDate ?? '', sale: before, priced: r.priced, method: { name: method.name },
              reference: reference.trim().length === 0 ? null : reference.trim() },
            spec,
          );
        }
      }
    } catch (e) {
      setRefusal(e instanceof SaleReturnError || e instanceof ReturnPickError ? e.message : 'The refund could not be recorded. Nothing was saved.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const refundTotal = mode === 'void' ? sale.totalMinor : (priced?.totalMinor ?? 0n);
  const needsReference = mode === 'return' && method !== null && method.requiresReference && (priced?.immediateMinor ?? 0n) > 0n;
  const ready =
    reason.trim().length > 0 &&
    !busy &&
    (mode === 'void' || (priced !== null && method !== null && (!needsReference || reference.trim().length > 0)));

  return (
    <section className="return-flow" aria-label="Void or return">
      <header className="return-head">
        <button type="button" className="secondary-action pressable" onClick={onDone} aria-label="Back to sales">
          <Icon name="back" size={20} />
        </button>
        <h2>
          Sale <span className="tabular">{sale.receiptNo}</span>
        </h2>
        <Money amount={sale.totalMinor} className="money" />
      </header>

      {mode === 'choose' ? (
        <div className="return-choices">
          <button
            type="button"
            className="secondary-action pressable"
            disabled={!mayVoid || !voidable}
            onClick={() => setMode('void')}
          >
            <Icon name="undo" size={20} /> Void the whole sale
          </button>
          <p className="tender-hint">
            {!mayVoid
              ? 'Voiding a sale is not part of what you are allowed to do here.'
              : sale.alreadyVoided
                ? 'This sale has already been voided.'
                : !voidable
                  ? 'A sale can be voided only in the till it was rung in, before anything of it has come back.'
                  : 'For a sale rung in error: every line, and the money back the way it was paid.'}
          </p>
          <button
            type="button"
            className="secondary-action pressable"
            disabled={!mayReturn || !returnable}
            onClick={() => setMode('return')}
          >
            <Icon name="download" size={20} /> Return items
          </button>
          <p className="tender-hint">
            {!mayReturn
              ? 'Taking goods back is not part of what you are allowed to do here.'
              : !sale.synced
                ? 'This sale has not reached the office yet. Once it has, items can come back one by one.'
                : !returnable
                  ? 'Everything on this sale has already come back.'
                  : 'Some lines, some quantity — at the price the customer paid.'}
          </p>
        </div>
      ) : null}

      {mode === 'return' ? (
        <ul className="return-lines" aria-label="What is coming back">
          {sale.lines.map((l) => {
            const n = qty[l.lineNo] ?? 0n;
            const step = scaleStep(l.qtyScale);
            const max = l.remainingQty;
            const set = (v: bigint): void => setQty({ ...qty, [l.lineNo]: v < 0n ? 0n : v > max ? max : v });
            return (
              <li key={l.lineNo} className="return-line">
                <span className="return-line-name">{l.name}</span>
                <span className="tender-hint">
                  {formatQtyScaled(l.remainingQty, l.qtyScale)} of {formatQtyScaled(l.qtySold, l.qtyScale)} {l.uomLabel} can come back
                </span>
                <div className="return-line-controls">
                  <button type="button" className="qty-button pressable" aria-label={`One less ${l.name}`} disabled={n <= 0n} onClick={() => set(n - step)}>
                    −
                  </button>
                  <span className="qty-display tabular" aria-live="polite">
                    {formatQtyScaled(n, l.qtyScale)}
                  </span>
                  <button type="button" className="qty-button pressable" aria-label={`One more ${l.name}`} disabled={n >= max} onClick={() => set(n + step)}>
                    +
                  </button>
                  <button type="button" className="chip pressable" aria-pressed={damaged[l.lineNo] === true}
                    onClick={() => setDamaged({ ...damaged, [l.lineNo]: !(damaged[l.lineNo] === true) })}>
                    {damaged[l.lineNo] === true ? 'Damaged — write off' : 'Back on the shelf'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {mode !== 'choose' ? (
        <>
          {mode === 'return' && priced !== null && priced.onAccountMinor > 0n ? (
            <div className="total-row">
              <span className="total-label">Credited to the customer’s account (the sale was on account)</span>
              <Money amount={priced.onAccountMinor} className="money" />
            </div>
          ) : null}
          {mode === 'return' && (priced === null || priced.immediateMinor > 0n) ? (
            <>
              <span className="tender-label">How the money goes back</span>
              <div className="chip-row" role="group" aria-label="Refund method">
                {immediate.map((m) => (
                  <button key={m.id} type="button" className="chip pressable" aria-pressed={method?.id === m.id} onClick={() => setMethodId(m.id)}>
                    {m.name}
                  </button>
                ))}
              </div>
              {needsReference ? (
                <input className="tender-input" type="text" autoComplete="off" placeholder="Reference (transaction id)"
                  value={reference} onChange={(e) => setReference(e.target.value)} aria-label="Refund reference" />
              ) : null}
            </>
          ) : null}
          {mode === 'void' && sale.tenders.length > 0 ? (
            <div className="receipt-rows">
              {sale.tenders.map((t, i) => (
                <div className="total-row" key={`${t.methodId}-${String(i)}`}>
                  <span className="total-label">Back by {t.name}</span>
                  <Money amount={t.amountMinor} className="money" />
                </div>
              ))}
            </div>
          ) : null}

          <span className="tender-label">Why</span>
          <div className="chip-row" role="group" aria-label="Reason">
            {QUICK_REASONS.map((r) => (
              <button key={r} type="button" className="chip pressable" aria-pressed={reason === r} onClick={() => setReason(r)}>
                {r}
              </button>
            ))}
          </div>
          <input className="tender-input" type="text" autoComplete="off" maxLength={200} placeholder="Or say why"
            value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />

          {pickProblem !== null && mode === 'return' && picks.some((p) => p.qty > 0n) ? (
            <p className="tender-hint" role="alert">{pickProblem}</p>
          ) : null}
          {refusal !== null ? (
            <p className="sale-refused" role="alert">
              <Icon name="alert" size={22} />
              <span>{refusal}</span>
            </p>
          ) : null}

          <div className="tender-actions">
            <button type="button" className="secondary-action pressable" onClick={() => { setMode('choose'); setConfirming(false); }}>
              <Icon name="back" size={20} /> Back
            </button>
            {confirming ? (
              <button type="button" className="primary-action danger pressable" disabled={!ready} onClick={() => void confirm()}>
                <Icon name="check" size={20} />
                {busy ? 'Recording…' : <>Confirm: refund <Money amount={refundTotal} className="money" /></>}
              </button>
            ) : (
              <button type="button" className="primary-action pressable" disabled={!ready} onClick={() => setConfirming(true)}>
                {mode === 'void' ? 'Void this sale' : 'Take these back'}
              </button>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
