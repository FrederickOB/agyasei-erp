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
  startFreshCart,
} from '../../data/mutations/cart';
import { readCartPricingBasis } from '../../data/pricing/cart-basis';
import {
  priceCart,
  UNTAXED_BASIS,
  type CartPricingBasis,
} from '../../data/pricing/cart-pricing';
import {
  checkout,
  DuplicateSaleError,
  SaleContextIncompleteError,
  SalePayloadInvalidError,
} from '../../data/mutations/checkout';
import { getCartLines, getOpenCart, type CartLineRow } from '../../data/queries/cart';
import { getOrCreateDeviceNode } from '../../data/queries/config';
import { readActivePriceListId } from '../../data/queries/session';
import {
  blocksSale,
  resolveCartPriceList,
  type CartPriceListState,
} from '../../data/session/device-price-list';
import { loadActiveProducts, type ProductWithPrice } from '../../data/queries/products';
import { useLiveQuery } from '../../data/use-live-query';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { usePrintService } from '../printing/PrintingContext';
import { Icon } from '../../ui/Icon';
import { useMediaQuery, WIDE_LAYOUT } from '../../ui/use-media-query';
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

export function Counter({
  db,
  onOpenPrinterSettings,
}: {
  readonly db: LocalDb;
  readonly onOpenPrinterSettings?: () => void;
}): ReactNode {
  const [mode, setMode] = useState<CounterMode>({ step: 'cart' });
  const [removed, setRemoved] = useState<RemovedLine | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlcRef = useRef<ClaimedHlcClock | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const cartTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The cart is a docked column on a tablet and a modal sheet on a phone.
  // Which one it IS decides more than styling: `aria-modal`, whether Escape
  // means anything, and where focus belongs.
  const wide = useMediaQuery(WIDE_LAYOUT);
  const printing = usePrintService();
  const currency = useCurrencySpec();

  useEffect(() => {
    void getOrCreateDeviceNode(db).then((node) => {
      hlcRef.current = createClaimedHlcClock(node);
    });
  }, [db]);

  // Deliberately NOT defaulted to []: `undefined` means the local read has not
  // resolved and the catalogue shows skeletons; [] means this counter really
  // has nothing to sell, which is a different sentence on screen.
  const products = useLiveQuery(db, loadActiveProducts, []);
  const cart = useLiveQuery(db, getOpenCart, []);
  const cartId = cart?.id ?? null;
  const lines = useLiveQuery(
    db,
    (d) => (cartId === null ? Promise.resolve<CartLineRow[]>([]) : getCartLines(d, cartId)),
    [cartId],
  );

  // Can what is in front of the cashier actually be sold? Judged only once a
  // cart genuinely exists: while the read is resolving, and in the instant
  // between "no open cart" and the effect below minting one, there is nothing
  // to judge, and a banner flashed at an empty counter would be a lie.
  const pinnedPriceListId = cart === undefined || cart === null ? undefined : cart.priceListId;
  const saleable = useLiveQuery(
    db,
    (d) =>
      pinnedPriceListId === undefined
        ? Promise.resolve<CartPriceListState | null>(null)
        : resolveCartPriceList(d, pinnedPriceListId),
    [pinnedPriceListId],
  );
  const cartBlocked = saleable !== undefined && saleable !== null && blocksSale(saleable);

  // WHAT THE CUSTOMER HANDS OVER depends on the list's own convention and on
  // the tax components in force on the trading day, both of which are rows on
  // this device. Read live, because both can arrive or change while a till is
  // switched on. Until they resolve the neutral basis stands: the extension of
  // the lines, which is the same figure this screen has always shown.
  const basis = useLiveQuery(
    db,
    (d) =>
      pinnedPriceListId === undefined
        ? Promise.resolve<CartPricingBasis | null>(null)
        : readCartPricingBasis(d, pinnedPriceListId),
    [pinnedPriceListId],
  );

  // The cart — and with it the sale's idempotency key — exists BEFORE the
  // first line is added (§8.2).
  useEffect(() => {
    if (cart === null) void createCart(db);
  }, [cart, db]);

  // AN EMPTY CART THAT CANNOT BE SOLD IS REPLACED WITHOUT ASKING.
  //
  // With no lines on it there is nothing to re-ring, no price anyone was
  // quoted, and nothing to decide — so the honest thing is to fix it and say
  // nothing, rather than hand a cashier a banner about an empty cart. A device
  // wedged by a stale pin heals itself the next time the counter opens.
  //
  // The id comparison is what makes this terminate: replacing a cart with one
  // pinned to the SAME list would produce another unsellable cart, and the
  // effect would run again on that one, forever.
  useEffect(() => {
    if (cart === undefined || cart === null || !cartBlocked) return;
    if (lines === undefined || lines.length > 0) return;
    void (async () => {
      const provisioned = await readActivePriceListId(db);
      if (provisioned === cart.priceListId) return;
      await startFreshCart(db, cart.id);
    })();
  }, [db, cart, cartBlocked, lines]);

  // A tablet rotated into a wide layout has the cart docked and visible; a
  // sheet left "open" behind it would trap focus in a panel that is no longer
  // a panel.
  useEffect(() => {
    if (wide) setCartOpen(false);
  }, [wide]);

  // Focus moves INTO the sheet when it opens and back to the bar that opened
  // it when it closes — otherwise a keyboard or screen-reader user is left
  // pointing at the catalogue behind a modal they cannot reach.
  useEffect(() => {
    if (!cartOpen) return;
    sheetRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => cartTriggerRef.current?.focus();
  }, [cartOpen]);

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

  // ONE pricing, shared by the cart footer, the amount due and the payload:
  // three places that must never show three numbers.
  const pricing = useMemo(
    () => priceCart(lines ?? [], basis ?? UNTAXED_BASIS),
    [lines, basis],
  );
  const totalMinor = pricing.grossMinor;

  const onCompleteSale = useCallback(
    (tenderedMinor: bigint) => {
      const hlc = hlcRef.current;
      if (cartId === null || hlc === null) return;
      setRefusal(null);
      void checkout(db, { cartId, tenderedMinor, hlc })
        .then((result) => {
          setMode({ step: 'receipt', saleId: result.saleId, changeMinor: result.changeMinor });
          // The sale is COMMITTED here. Only now is a receipt queued, and
          // nothing below can fail the sale, delay the next customer, or be
          // awaited: it is fire-and-forget by design (printing/service.ts).
          if (printing !== null) {
            void printing.afterSale(
              result.saleId,
              { lines: lines ?? [], pricing, basis: basis ?? UNTAXED_BASIS },
              currency,
            );
          }
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
    [db, cartId, printing, lines, pricing, basis, currency],
  );

  if (mode.step === 'receipt') {
    return (
      <ReceiptView
        db={db}
        saleId={mode.saleId}
        changeMinor={mode.changeMinor}
        onNewSale={() => setMode({ step: 'cart' })}
        {...(onOpenPrinterSettings === undefined ? {} : { onOpenPrinterSettings })}
      />
    );
  }

  const refusalBanner =
    refusal === null ? null : (
      <p className="sale-refused" role="alert">
        <Icon name="alert" size={22} />
        <span>{refusal}</span>
      </p>
    );

  // A cart that cannot be sold, with lines on it, is the one case that needs a
  // person: the lines were priced from a list this device no longer sells
  // from, and nobody may be charged from prices they were not quoted. So the
  // till says so plainly and offers the one action that resolves it — rather
  // than refusing at tender, where the previous behaviour left the counter
  // with no way forward at all.
  const stuckBanner =
    !cartBlocked || saleable === undefined || saleable === null ? null : (
      <div className="sale-refused" role="alert">
        <Icon name="alert" size={22} />
        <div className="sale-refused-body">
          <span>{saleable.message}</span>
          <button
            type="button"
            className="secondary-action pressable"
            onClick={() => {
              if (cartId === null) return;
              setRefusal(null);
              setCartOpen(false);
              void startFreshCart(db, cartId);
            }}
          >
            <Icon name="undo" size={20} />
            Start a fresh cart
          </button>
        </div>
      </div>
    );

  const takePayment = (): void => {
    // A disabled attribute is a hint, not a policy.
    if (cartBlocked) return;
    setCartOpen(false);
    setMode({ step: 'tender' });
  };
  const cartProps = {
    lines: lines ?? [],
    onSetQty: (lineId: string, qty: bigint) => void setCartLineQty(db, lineId, qty),
    onRemove,
    onUndoRemove,
    removed,
    onTakePayment: takePayment,
    pricing,
    // Preventing the tap beats refusing it: walking someone to the tender
    // screen only to turn them back is a worse way to say the same thing.
    sellable: !cartBlocked,
  };

  if (mode.step === 'tender') {
    return (
      <>
        {refusalBanner}
        {stuckBanner}
        <TenderPanel
          pricing={pricing}
          onBack={() => setMode({ step: 'cart' })}
          onComplete={onCompleteSale}
        />
      </>
    );
  }

  const lineCount = lines?.length ?? 0;

  return (
    <div className="counter">
      {refusalBanner}
      {stuckBanner}
      <ProductSearch products={products} onAdd={onAdd} />

      {wide ? (
        <div className="cart-dock">
          <CartPanel {...cartProps} />
        </div>
      ) : (
        <>
          {/* The phone's cart lives in the thumb zone and never scrolls away:
              what is in it, what it comes to, and the one action that matters.
              Two targets, because "check the cart" and "charge for it" are
              different intentions and a single control would guess. */}
          <div className="cart-bar">
            {cartBlocked ? (
              // The banner at the top of the page scrolls away; this bar does
              // not. Somebody halfway down a catalogue, reaching for a pay
              // button that is dead, needs the reason WHERE THE BUTTON IS.
              <p className="cart-bar-blocked">
                <Icon name="alert" size={18} />
                These prices are out of date
              </p>
            ) : null}
            <div className="cart-bar-row">
              <button
                type="button"
                ref={cartTriggerRef}
                className="cart-bar-summary pressable"
                aria-expanded={cartOpen}
                onClick={() => setCartOpen(true)}
              >
                <Icon name="cart" size={22} />
                <span>
                  <span className="cart-bar-lines">
                    {lineCount === 1 ? '1 line' : `${lineCount} lines`}
                  </span>
                  <br />
                  <Money amount={totalMinor} className="money cart-bar-total" />
                </span>
              </button>
              <button
                type="button"
                className="primary-action pressable"
                disabled={lineCount === 0 || cartBlocked}
                onClick={takePayment}
              >
                Take payment
              </button>
            </div>
          </div>

          {cartOpen ? (
            <div
              ref={sheetRef}
              onKeyDown={(e) => {
                // Every sheet offers an escape route (§ escape-routes): the
                // close button, the scrim, and this.
                if (e.key === 'Escape') setCartOpen(false);
              }}
            >
              {/* The scrim is a POINTER shortcut, not a second control: it is
                  hidden from the accessibility tree because the close button
                  and Escape already cover the keyboard, and two focusable
                  things both announcing "Close cart" is one thing too many to
                  tab through. */}
              <div
                className="sheet-scrim"
                aria-hidden="true"
                onClick={() => setCartOpen(false)}
              />
              <CartPanel
                {...cartProps}
                variant="sheet"
                modal
                onClose={() => setCartOpen(false)}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
