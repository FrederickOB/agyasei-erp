/**
 * What a cart is priced against, assembled from local rows.
 *
 * TWO CALLERS, ONE ANSWER — and they must not drift. The counter reads this to
 * show a running total and an amount due; `checkout` reads it to build the
 * figure that goes on the receipt and travels as `clientTotalMinor`. A tender
 * panel that showed one number while the recorded sale carried another would
 * be the worst kind of bug at a counter: quiet, and only discovered at cash-up.
 *
 * The basis is DATED. Both halves are resolved against the SALE'S business day
 * — the list's convention from the row that is in force then, the pack
 * components from the rate rows in force then — never against "today", which
 * is a different day at a counter working past midnight.
 */
import type { CartPricingBasis } from './cart-pricing';
import { UNTAXED_BASIS } from './cart-pricing';
import { readTaxComponentsInForce } from './tax-components';
import { businessDateFor } from '../../lib/business-date';
import type { DbExecutor } from '../db';
import { readDeviceLocation } from '../queries/session';
import { resolveCartPriceList } from '../session/device-price-list';

/**
 * The basis for a list whose convention is already known, on a known day.
 * `checkout` uses this arm: it has resolved both while refusing a cart it
 * cannot sell, and re-resolving them would open a second chance to disagree.
 */
export async function readPricingBasis(
  db: DbExecutor,
  isTaxInclusive: boolean,
  businessDate: string,
): Promise<CartPricingBasis> {
  const set = await readTaxComponentsInForce(db, businessDate);
  return { isTaxInclusive, components: set.components };
}

/**
 * The basis for the cart the cashier is looking at. Returns the neutral basis
 * when the cart's list cannot be resolved at all — the lines are still shown
 * and still add up; the refusal that stops the sale is raised by the price-list
 * gate, and a second, competing failure here would only bury it.
 */
export async function readCartPricingBasis(
  db: DbExecutor,
  priceListId: string | null,
  nowIso: string = new Date().toISOString(),
): Promise<CartPricingBasis> {
  const priceList = await resolveCartPriceList(db, priceListId, nowIso);
  if (priceList.code === null) return UNTAXED_BASIS;
  const location = await readDeviceLocation(db);
  // `businessDateFor` states its own fallback for a missing zone; it is not
  // restated here, so there is one rule for what day it is on this device.
  const businessDate = businessDateFor(nowIso, location?.timeZone ?? null);
  return readPricingBasis(db, priceList.isTaxInclusive, businessDate);
}
