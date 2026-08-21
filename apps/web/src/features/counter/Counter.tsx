/**
 * The counter flow (§8.7): search or quick grid -> cart -> cash tender ->
 * receipt. Every step is local; nothing on this path can wait on a socket.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import { createClaimedHlcClock, type ClaimedHlcClock } from '../../lib/hlc';
import {
  addProductToCart,
  createCart,
  removeCartLine,
  setCartLineQty,
} from '../../data/mutations/cart';
import {
  cartTotalMinor,
  checkout,
  DuplicateSaleError,
  SaleContextIncompleteError,
  SalePayloadInvalidError,
} from '../../data/mutations/checkout';
import { getCartLines, getOpenCart, type CartLineRow } from '../../data/queries/cart';
import { getOrCreateDeviceNode } from '../../data/queries/config';
import { loadActiveProducts, type ProductWithPrice } from '../../data/queries/products';
import { useLiveQuery } from '../../data/use-live-query';
import { CartPanel, type RemovedLine } from './CartPanel';
import { ProductSearch } from './ProductSearch';
import { ReceiptView } from './ReceiptView';
import { TenderPanel } from './TenderPanel';

type CounterMode =
  | { readonly step: 'cart' }
  | { readonly step: 'tender' }
  | { readonly step: 'receipt'; readonly saleId: string; readonly changeMinor: bigint | null };

const UNDO_MS = 5000;

/**
 * A refused sale is WORK, not a toast (§8.5, and the frontend brief: conflicts
 * and refusals surface as something a person can act on, never as a message
 * that disappears). The cart is still there when this shows — the sale can be
 * re-rung or the device fixed; nothing has been dropped.
 */
function refusalMessage(err: unknown): string {
  if (err instanceof SaleContextIncompleteError) return err.message;
  if (err instanceof SalePayloadInvalidError) {
    // Caught HERE, at the counter, rather than as a silent rejection hours
    // later at sync. The detail is for whoever is called; the first line is
    // for the person holding the cash.
    return `This sale cannot be recorded and was not taken. Call support with: ${err.issues.join('; ')}`;
  }
  return `This sale was not recorded: ${err instanceof Error ? err.message : String(err)}`;
}

export function Counter({ db }: { readonly db: LocalDb }): ReactNode {
  const [mode, setMode] = useState<CounterMode>({ step: 'cart' });
  const [removed, setRemoved] = useState<RemovedLine | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlcRef = useRef<ClaimedHlcClock | null>(null);

  useEffect(() => {
    void getOrCreateDeviceNode(db).then((node) => {
      hlcRef.current = createClaimedHlcClock(node);
    });
  }, [db]);

  const products = useLiveQuery(db, loadActiveProducts, []);
  const cart = useLiveQuery(db, getOpenCart, []);
  const cartId = cart?.id ?? null;
  const lines = useLiveQuery(
    db,
    (d) => (cartId === null ? Promise.resolve<CartLineRow[]>([]) : getCartLines(d, cartId)),
    [cartId],
  );

  // The cart — and with it the sale's idempotency key — exists BEFORE the
  // first line is added (§8.2).
  useEffect(() => {
    if (cart === null) void createCart(db);
  }, [cart, db]);

  const onAdd = useCallback(
    (product: ProductWithPrice) => {
      if (cartId !== null) void addProductToCart(db, cartId, product);
    },
    [db, cartId],
  );

  const onRemove = useCallback(
    (line: CartLineRow) => {
      void removeCartLine(db, line.id);
      setRemoved({ line });
      if (undoTimer.current !== null) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setRemoved(null), UNDO_MS);
    },
    [db],
  );

  const onUndoRemove = useCallback(() => {
    const entry = removed;
    setRemoved(null);
    if (entry === null || cartId === null) return;
    // Re-add the removed line from its snapshot, exactly as it was.
    void db
      .execute(
        `INSERT INTO cart_line
           (id, cart_id, seq, product_id, name_snapshot, uom_label_snapshot,
            qty_scale, qty_scaled, unit_price_e4)
         VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER))`,
        [
          entry.line.id,
          entry.line.cartId,
          entry.line.seq,
          entry.line.productId,
          entry.line.name,
          entry.line.uomLabel,
          entry.line.qtyScale,
          entry.line.qtyScaled.toString(),
          entry.line.unitPriceE4.toString(),
        ],
      )
      .then(() => db.changes.notify());
  }, [db, removed, cartId]);

  const totalMinor = useMemo(() => cartTotalMinor(lines ?? []), [lines]);

  const onCompleteSale = useCallback(
    (tenderedMinor: bigint) => {
      const hlc = hlcRef.current;
      if (cartId === null || hlc === null) return;
      setRefusal(null);
      void checkout(db, { cartId, tenderedMinor, hlc })
        .then((result) => {
          setMode({ step: 'receipt', saleId: result.saleId, changeMinor: result.changeMinor });
          // The next customer's cart opens via the cart === null effect above
          // (checkout's notify re-runs the live query); creating it here too
          // would race that effect into a second open cart.
        })
        .catch((err: unknown) => {
          if (err instanceof DuplicateSaleError) {
            // The sale already exists: SHOW it rather than let anyone re-ring it.
            setMode({ step: 'receipt', saleId: err.saleId, changeMinor: null });
            return;
          }
          // Everything else stays on screen with the cart intact. A refusal
          // that vanished would leave a cashier believing a sale was taken.
          setRefusal(refusalMessage(err));
        });
    },
    [db, cartId],
  );

  if (mode.step === 'receipt') {
    return (
      <ReceiptView
        db={db}
        saleId={mode.saleId}
        changeMinor={mode.changeMinor}
        onNewSale={() => setMode({ step: 'cart' })}
      />
    );
  }

  const refusalBanner =
    refusal === null ? null : (
      <p className="sale-refused" role="alert">
        {refusal}
      </p>
    );

  if (mode.step === 'tender') {
    return (
      <>
        {refusalBanner}
        <TenderPanel
          totalMinor={totalMinor}
          onBack={() => setMode({ step: 'cart' })}
          onComplete={onCompleteSale}
        />
      </>
    );
  }

  return (
    <div className="counter">
      {refusalBanner}
      <ProductSearch products={products ?? []} onAdd={onAdd} />
      <CartPanel
        lines={lines ?? []}
        onSetQty={(lineId, qty) => void setCartLineQty(db, lineId, qty)}
        onRemove={onRemove}
        onUndoRemove={onUndoRemove}
        removed={removed}
        onTakePayment={() => setMode({ step: 'tender' })}
      />
    </div>
  );
}
