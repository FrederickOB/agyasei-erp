/**
 * Device provisioning: which of the tenant's price lists this counter sells
 * from by default.
 *
 * THE BUG THIS FILE EXISTS FOR. `writeActivePriceListId` — the provisioning
 * entry point — was written and never called from anywhere. The only thing
 * that ever wrote `local_config.price_list_id` was the DEV SEED, which points
 * it at a placeholder list coded `DEFAULT`. So in sync mode every device rang
 * its sales against `DEFAULT`, `resolvePriceListCode` duly put
 * `priceListCode: 'DEFAULT'` on the wire, and the API answered
 * PRECONDITION_FAILED — `no price list DEFAULT in force` — because the
 * tenant's actual lists are its own (tenant #1's are RETAIL and WHOLESALE).
 * The sale was recorded locally and then rejected at upload, which is the
 * worst of the three possible outcomes: the counter believed it had sold.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE THE ANSWER COMES FROM, AND WHY IT IS NOT INVENTED HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 * `08-client-architecture §8.7` is explicit that the client knows only "the
 * tenant's price lists" and "the default for a walk-in" — the lists themselves
 * are tenant configuration rows, never an enum, and never a platform constant.
 *
 * That configuration ALREADY EXISTS and already reaches the device. The server
 * models it on `app.price_list` itself (migration 0003):
 *
 *   priority       smallint not null   -- "resolution order, low wins"
 *   location_id    uuid                -- "NULL = whole tenant"
 *   effective_from date not null
 *   effective_to   date
 *
 * and `sync_rules.yaml` streams the whole table to every device in the
 * `tenant_reference` bucket. So the default for a walk-in is not a new config
 * surface to invent — it is a QUERY over rows the device is already holding:
 *
 *   candidates = the tenant's lists whose scope covers THIS device's location
 *                (its own location, or tenant-wide) and which are in force on
 *                the trading day, ordered by priority.
 *   exactly one lowest priority → provision it. Unambiguous; must Just Work.
 *   a tie at the lowest        → REFUSE and name the choice. Two lists the
 *                                tenant ranked equally are two lists the
 *                                platform has no basis to choose between, and
 *                                guessing charges every customer off the wrong
 *                                list, silently, all day.
 *   none, and none configured  → WAIT. The rows have not arrived yet.
 *   none, but some configured  → REFUSE. A real configuration gap: nothing the
 *                                tenant has published covers this counter today.
 *   stored list not a candidate → reconcile to configuration and say so.
 *
 * A SETTLED TAX-INCLUSIVE LIST IS NO LONGER A REFUSAL, and the reason it was
 * one is the reason it stopped being one. This gate used to answer
 * `status: 'unsupported'` for a list whose shelf prices already contain tax,
 * because nothing on either side could de-gross one: the counter's own total
 * would have been wrong and `sales.createSale` refused the upload outright, so
 * binding the list meant recording sales the upload then rejected — the exact
 * failure this file exists to end. Extraction now exists (`@erp/money`, driven
 * from the pack rows this device already holds; see `../pricing/`), the
 * counter's total is the shelf price the customer is looking at, and the
 * refusal would now be the harm rather than the protection: tenant #1's
 * best-ranked list IS tax-inclusive, so the gate blocked its counters from
 * trading at all. The refusals that remain are the ones whose cause is still
 * real — a tie, a coverage gap, and rows that have not arrived yet.
 *
 * No branch reads a tenant's identity and no list code appears in this file
 * (CLAUDE.md §2.9). A tenant that ranks its trade list above its counter list
 * gets the trade list, because that is what it configured.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY `tenant_id IS NOT NULL` IS THE TEST FOR "REAL CONFIGURATION".
 * ═══════════════════════════════════════════════════════════════════════════
 * A price list is tenant configuration only if it ARRIVED OVER THE SYNC
 * STREAM, and a synced row always carries a tenant_id: `app.price_list.
 * tenant_id` is `not null` server-side and the bucket selects by it
 * (`WHERE tenant_id = bucket.tenant_id`). The dev seed's placeholder carries
 * none — and that, structurally, is what makes it local-only. A device with a
 * session can never resolve to it, so it can never price a synced sale.
 *
 * This is NOT the client asserting a tenant. Nothing here reads WHICH tenant;
 * the boundary is the sync rules' and the server stamps `tenant_id` on every
 * write from the verified token (CLAUDE.md §2.1). The predicate asks one
 * question only: did this row come from the server, or did we make it up?
 *
 * Reconciliation runs on EVERY start (main.tsx) and re-runs as rows arrive, so
 * a tenant that re-prioritises its lists overnight is picked up when the till
 * is next switched on rather than when someone clears its storage.
 */
import { businessDateFor } from '../../lib/business-date';
import type { DbExecutor, LocalDb } from '../db';
import {
  clearActivePriceListId,
  readActivePriceListId,
  readDeviceLocation,
  writeActivePriceListId,
} from '../queries/session';
import { readBearerScope } from './bearer-claims';

export type DevicePriceListStatus =
  /** No bearer: local-only mode. Whatever is provisioned locally stands (§8.1). */
  | 'local-only'
  /** The stored list is one the tenant's configuration currently offers here. */
  | 'confirmed'
  /** Configuration named exactly one default and this device had none. Bound. */
  | 'provisioned'
  /** The stored list is no longer offered here; replaced with the configured one. */
  | 'reconciled'
  /** Several lists tie for the default. The device must be told which one. */
  | 'ambiguous'
  /** Lists exist, but none covers this counter on this trading day. Fail closed. */
  | 'unconfigured'
  /** No tenant price list has reached this device yet. Not a fault — wait. */
  | 'awaiting-config'
  /** The device has no location, so "which list applies HERE" has no answer yet. */
  | 'location-unknown';

/** A price list the operator may bind this device to. Codes are tenant data. */
export interface PriceListChoice {
  readonly id: string;
  /** The list's own code — this is what goes on the wire. */
  readonly code: string;
  /** The list's own name, as the tenant wrote it. */
  readonly name: string | null;
  /** The tenant's ranking. Low wins; equal ranks are what "ambiguous" means. */
  readonly priority: number;
  /**
   * Shelf prices that already contain tax. Carried because it decides which
   * DIRECTION the counter computes in — de-gross the extension, or compose
   * tax onto it (`../pricing/cart-pricing.ts`). It is not a reason to refuse.
   */
  readonly isTaxInclusive: boolean;
}

export interface DevicePriceListState {
  readonly status: DevicePriceListStatus;
  /** The list sales are priced against. `null` means this device cannot sell. */
  readonly priceListId: string | null;
  /** The choice, when configuration does not settle it. Empty otherwise. */
  readonly choices: readonly PriceListChoice[];
  /** A stored list that reconciliation replaced or discarded. */
  readonly replacedPriceListId: string | null;
  /** One sentence a counter can act on, or `null` when nothing is wrong. */
  readonly message: string | null;
}

/**
 * Does this state stop the device selling?
 *
 * Local-only mode is never blocked here — the dev seed's placeholder list is
 * the whole point of local-only mode, and a local-only device that somehow has
 * no list is refused at checkout, where "The price list for this sale is not
 * recognised on this device" is both true and the whole story.
 */
export function blocksSales(state: DevicePriceListState): boolean {
  return state.priceListId === null && state.status !== 'local-only';
}

// ---------------------------------------------------------------------------
// Reading the tenant's configuration
// ---------------------------------------------------------------------------

/**
 * Only rows that came from the sync stream are tenant configuration. See the
 * header: a synced `price_list` row always carries a tenant_id; the dev seed's
 * placeholder never does, which is exactly what makes it local-only.
 */
const CONFIGURED = 'tenant_id IS NOT NULL';

/**
 * Dates arrive as text. `substr(...,1,10)` is deliberate: it compares the
 * calendar date whether the column arrives as 'YYYY-MM-DD' or as a full
 * timestamp, and a lexicographic compare on a zero-padded ISO date IS a
 * chronological compare. `effective_to` is EXCLUSIVE, matching the API's own
 * window exactly (`effective_to is null or effective_to > $date`,
 * apps/api/src/routers/sales.ts) — a device that disagreed with the server
 * about which day a list stops applying would price against a list the server
 * then refuses.
 */
const IN_FORCE =
  "effective_from IS NOT NULL AND substr(effective_from, 1, 10) <= ?" +
  " AND (effective_to IS NULL OR substr(effective_to, 1, 10) > ?)";

function toChoice(row: Record<string, unknown>): PriceListChoice | null {
  const id = row['id'];
  const code = row['code'];
  if (typeof id !== 'string' || id.length === 0) return null;
  const name = row['name'];
  const priority = row['priority'];
  return {
    id,
    code: typeof code === 'string' ? code : '',
    name: typeof name === 'string' && name.length > 0 ? name : null,
    // A smallint ranking, not money and not a quantity — a plain number is the
    // right type for it (§8.3 governs money/qty columns, which this is not).
    priority: typeof priority === 'number' ? priority : Number.NaN,
    // SQLite has no boolean; the column is INTEGER. Anything that is not a
    // clear 0 counts as inclusive — the cautious direction, because reading it
    // wrong the other way rings gross prices as if they were net.
    isTaxInclusive: row['is_tax_inclusive'] !== 0,
  };
}

/**
 * The tenant's lists that this counter may sell from today, best first.
 *
 * Exported because the setup screen re-reads them live: a device asked to
 * choose before the tenant's `price_list` rows have finished arriving should
 * watch the list fill in, and a device merely WAITING for them should start
 * trading the moment they land — without anyone reloading a till.
 */
export async function readPriceListCandidates(
  db: DbExecutor,
  locationId: string,
  businessDate: string,
): Promise<readonly PriceListChoice[]> {
  const rows = await db.getAll(
    `SELECT id, code, name, priority, is_tax_inclusive FROM price_list
      WHERE ${CONFIGURED}
        AND (location_id IS NULL OR location_id = ?)
        AND ${IN_FORCE}
      ORDER BY priority ASC, code ASC`,
    [locationId, businessDate, businessDate],
  );
  const choices: PriceListChoice[] = [];
  for (const row of rows) {
    const choice = toChoice(row);
    // A row whose ranking did not survive the wire is not silently ranked
    // first: it cannot take part in a comparison, so it takes part in nothing.
    if (choice !== null && Number.isFinite(choice.priority)) choices.push(choice);
  }
  return choices;
}

/** Has ANY tenant price list reached this device? Distinguishes wait from fault. */
async function hasConfiguredLists(db: DbExecutor): Promise<boolean> {
  const rows = await db.getAll(`SELECT 1 AS hit FROM price_list WHERE ${CONFIGURED} LIMIT 1`);
  return rows.length > 0;
}

/** The candidates sharing the best (lowest) ranking — one, or an ambiguity. */
function bestRanked(candidates: readonly PriceListChoice[]): readonly PriceListChoice[] {
  const best = candidates[0];
  if (best === undefined) return [];
  return candidates.filter((c) => c.priority === best.priority);
}

/** How a list is named to a human. The words are the tenant's, never ours. */
function describe(choice: PriceListChoice): string {
  if (choice.name !== null && choice.code.length > 0) return `${choice.name} (${choice.code})`;
  if (choice.name !== null) return choice.name;
  if (choice.code.length > 0) return choice.code;
  return choice.id;
}

function ambiguousMessage(tied: readonly PriceListChoice[]): string {
  return (
    `${tied.length} price lists are set up for this counter with the same ranking, so this ` +
    `device cannot tell which one a walk-in customer should be charged from. Choose one ` +
    `before recording a sale: ${tied.map(describe).join(', ')}.`
  );
}

const UNCONFIGURED_MESSAGE =
  'None of this business’s price lists applies at this counter today, so this device cannot ' +
  'price a sale. A price list needs to cover this location and today’s trading day.';

const AWAITING_MESSAGE =
  'This device is still receiving its price lists. It will be ready to sell as soon as they ' +
  'arrive — leave it connected.';

/**
 * THE REFUSAL THAT USED TO LIVE HERE, and why it is gone.
 *
 * `UNSUPPORTED_MESSAGE` refused to bind a price list whose shelf prices
 * already contain tax, because the counter's arithmetic treated
 * `unit_price_e4` as a NET unit price and nothing anywhere could extract tax
 * back out of a gross one — so the local total would have been wrong and
 * `sales.createSale` refused the upload in the same words. Both halves of that
 * are now addressed: `@erp/money` de-grosses against the pack's own declared
 * composition, and `../pricing/cart-pricing.ts` drives it from the rows this
 * device already holds. The extension of a gross shelf price IS what the
 * customer hands over, so the counter's total is right whether or not the
 * split can be stated.
 *
 * The refusals kept are the ones whose cause did not change:
 *   · `ambiguous`       — two lists the tenant ranked equally. The platform
 *                         has no basis to choose, and guessing charges every
 *                         customer off the wrong list, silently, all day.
 *   · `unconfigured`    — real lists exist and none covers this counter today.
 *   · `awaiting-config` — nothing has arrived yet. A wait, not a fault.
 *   · `location-unknown`— "which list applies HERE" has no answer without a here.
 *   · the cart's own `unrecognised` / `not-offered`.
 * None of them was ever about tax, and none of them is weakened below.
 */

const LOCATION_UNKNOWN_MESSAGE =
  'This device has no location assigned, so it cannot tell which price list applies here. ' +
  'Assign its location first.';

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function state(
  status: DevicePriceListStatus,
  priceListId: string | null,
  message: string | null,
  extra: { choices?: readonly PriceListChoice[]; replaced?: string | null } = {},
): DevicePriceListState {
  return {
    status,
    priceListId,
    choices: extra.choices ?? [],
    replacedPriceListId: extra.replaced ?? null,
    message,
  };
}

/**
 * Bind this device to the price list its tenant's configuration names for this
 * counter, or refuse and say precisely why. Safe to call on every start and on
 * every arrival of synced rows; it writes only when the stored value and the
 * configuration disagree.
 *
 * MUST run AFTER `reconcileDeviceLocation` — "which list applies here" has no
 * answer until "here" does.
 *
 * @param bearerToken the device's API bearer, or null in local-only mode. Only
 *        its PRESENCE is read: unlike location, the answer is not in the token
 *        (there is no price-list claim), it is in the tenant's synced rows.
 */
export async function reconcileDevicePriceList(
  db: LocalDb,
  bearerToken: string | null | undefined,
  nowIso: string = new Date().toISOString(),
): Promise<DevicePriceListState> {
  const stored = await readActivePriceListId(db);

  if (readBearerScope(bearerToken).kind === 'absent') {
    // Local-only mode is the offline rehearsal and must not regress: there is
    // no tenant configuration to reconcile against, so the dev seed stands.
    return state('local-only', stored, null);
  }

  const location = await readDeviceLocation(db);
  if (location === null) {
    // The location gate is shown first and owns this failure; this device is
    // simply not answerable yet. The stored value is left alone — clearing it
    // would destroy information the location gate may still make usable.
    return state('location-unknown', null, LOCATION_UNKNOWN_MESSAGE);
  }

  const businessDate = businessDateFor(nowIso, location.timeZone);
  const candidates = await readPriceListCandidates(db, location.id, businessDate);

  if (candidates.length === 0) {
    // Fail closed either way, and clear a stored value on the way out: in sync
    // mode a stored value that configuration does not offer is the dev seed's
    // placeholder or a list that has lapsed, and either one puts a code on the
    // wire that the server refuses. A cleared value makes `createCart` produce
    // a cart with no list, which `checkout` then refuses at the counter —
    // where it can be acted on — instead of hours later at upload.
    if (stored !== null) await clearActivePriceListId(db);
    const configured = await hasConfiguredLists(db);
    return configured
      ? state('unconfigured', null, UNCONFIGURED_MESSAGE, { replaced: stored })
      : state('awaiting-config', null, AWAITING_MESSAGE, { replaced: stored });
  }

  const held = candidates.find((c) => c.id === stored);
  if (held !== undefined) {
    // Deliberately NOT re-pointed at the best-ranked list. A stored value that
    // configuration still offers is either the default this function bound
    // last time or a choice a human made at this counter; silently overriding
    // the second every morning would undo a decision without telling anyone.
    //
    // `isTaxInclusive` is deliberately NOT consulted: it decides which
    // direction the counter computes in, not whether it may (see the note
    // above the messages below).
    return state('confirmed', stored, null);
  }

  const tied = bestRanked(candidates);
  const [only] = tied;
  if (tied.length === 1 && only !== undefined) {
    // Settled by the tenant's own ranking, and therefore bound — including a
    // list whose prices already contain tax, which is the ordinary shape of a
    // counter list and which the counter can now price in both directions.
    await writeActivePriceListId(db, only.id);
    if (stored === null) return state('provisioned', only.id, null);
    return state(
      'reconciled',
      only.id,
      `This device now prices sales from ${describe(only)}. The price list it previously ` +
        `used is not one this counter is set up for and is no longer being used.`,
      { replaced: stored },
    );
  }

  // A tie. The device does not guess — not even "the first one", which is the
  // same guess wearing an ordering. It refuses, names the choice, and waits.
  if (stored !== null) await clearActivePriceListId(db);
  return state('ambiguous', null, ambiguousMessage(tied), { choices: tied, replaced: stored });
}

// ---------------------------------------------------------------------------
// The CART's price list — the same question, asked of a sale in progress
// ---------------------------------------------------------------------------

/**
 * Can the cart in front of the cashier actually be sold?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A CART NEEDS ITS OWN ANSWER, AND WHAT WENT WRONG WITHOUT ONE.
 * ═══════════════════════════════════════════════════════════════════════════
 * A cart pins its price list ONCE, when it is created (mutations/cart.ts), and
 * nothing ever revisited that pin. Reconciliation above repairs `local_config`
 * — the list the NEXT cart will be created with — and deliberately does not
 * touch a cart that is already open. That left two ways to wedge a till, and
 * both of them happened:
 *
 *   1. THE PIN NAMES A ROW THAT IS GONE. A device healing itself drops its
 *      synced tables and keeps its local-only ones, so that an unsent sale in
 *      the outbox survives (data/powersync.ts). `price_list` is synced; `cart`
 *      is not. The cart outlived the row it pointed at, `resolvePriceListCode`
 *      returned null, and checkout refused — forever, because the ONLY thing
 *      that deletes a cart is a successful sale. Every retry refused, no new
 *      cart was ever minted, and emptying the lines changed nothing. The only
 *      escape was clearing the device's storage.
 *   2. THE PIN NAMES A ROW THAT NO LONGER APPLIES. A list that lapsed
 *      overnight still RESOLVES — the row is right there — so the code went up
 *      the wire and the API refused the sale hours later (`no price list X in
 *      force`). That is the recorded-then-rejected failure this whole module
 *      exists to prevent, arriving through the one door it was not watching.
 *
 * So the cart is now asked the same question the device is: not "does this id
 * match a row" but "is this a list this counter may sell from today". The
 * predicate is not rewritten here — `readPriceListCandidates` above already
 * carries it, and a second copy of a rule about effective windows is a second
 * thing to get wrong.
 *
 * TWO THINGS A LATER READER WILL WANT TO "FIX" BACK. Neither is a mistake:
 *
 *   · THIS IS STRICTER THAN THE SERVER, deliberately. `sales.createSale`
 *     matches a list on code and effective window only — it has no location
 *     predicate — so a list scoped to another outlet would be ACCEPTED there
 *     and is refused here. That is the counter's policy, the same one the
 *     device gate applies: a list the tenant scoped to another outlet is not
 *     one this counter should be charging from. Dropping the location clause
 *     to reach parity would also mean not reusing `readPriceListCandidates`,
 *     and then there would be two copies of the effective-window rule.
 *   · THE VERDICT IS DATE-DERIVED, and midnight is not a row change, so a
 *     cart left untouched across a day boundary is not re-judged on its own.
 *     It does not need to be: every line added, removed or re-quantified
 *     re-derives it, so the counter can never show an enabled "Take payment"
 *     on a cart that was unsellable as of the last thing anyone did to it —
 *     and the remaining sliver (midnight falling between the last tap and the
 *     tender tap) is caught inside checkout's own transaction, which is why
 *     that check stays even though the UI now blocks first. A ticker here
 *     would burn a wake-up every second on a device that trades on battery.
 *
 * LOCAL-ONLY MODE MUST NOT REGRESS, and the test for it is the row itself.
 * `readPriceListCandidates` only considers rows with a `tenant_id`, which the
 * dev seed's placeholder deliberately lacks — that absence is what makes it
 * local-only (see the header). Judging a placeholder against tenant
 * configuration it was never part of would make the offline rehearsal
 * permanently unsellable. So a pinned row WITHOUT a tenant_id is left exactly
 * as it was: it resolves, it sells, nothing else is asked of it. No bearer
 * token is consulted, because the question is about the row, not the session.
 */
export type CartPriceListStatus =
  /** The list is this counter's to sell from, today. */
  | 'sellable'
  /** The pinned id names no row on this device — or a row with no code. */
  | 'unrecognised'
  /** A real row, but not one this counter is offered on this trading day. */
  | 'not-offered';

export interface CartPriceListState {
  readonly status: CartPriceListStatus;
  /** The tenant's own code for the list — what goes on the wire. */
  readonly code: string | null;
  /** One sentence a counter can act on, or `null` when nothing is wrong. */
  readonly message: string | null;
  /**
   * The list's own convention: do its prices already contain tax? It decides
   * which DIRECTION the counter computes the total in, so it travels with the
   * verdict rather than being read a second time by every caller. `false` on a
   * refusal, where there is no list to compute against.
   */
  readonly isTaxInclusive: boolean;
}

/**
 * Both refusals name the FIX, not just the fault. The message they replaced —
 * "The price list for this sale is not recognised on this device." — was true
 * and left the person holding the cash with nowhere to go.
 */
const CART_UNRECOGNISED_MESSAGE =
  'This cart cannot be sold: the price list it was rung against is not one this device has. ' +
  'Start a fresh cart and ring the items again.';

const CART_NOT_OFFERED_MESSAGE =
  'This cart cannot be sold: it was rung against a price list this counter does not sell from ' +
  'today. Start a fresh cart and ring the items again.';

export async function resolveCartPriceList(
  db: DbExecutor,
  priceListId: string | null,
  nowIso: string = new Date().toISOString(),
  businessDateOverride?: string,
): Promise<CartPriceListState> {
  if (priceListId === null || priceListId.length === 0) {
    return {
      status: 'unrecognised',
      code: null,
      message: CART_UNRECOGNISED_MESSAGE,
      isTaxInclusive: false,
    };
  }

  const rows = await db.getAll(
    'SELECT code, tenant_id, is_tax_inclusive FROM price_list WHERE id = ? LIMIT 1',
    [priceListId],
  );
  const row = rows[0];
  const code = row === undefined ? null : row['code'];
  if (typeof code !== 'string' || code.length === 0) {
    return {
      status: 'unrecognised',
      code: null,
      message: CART_UNRECOGNISED_MESSAGE,
      isTaxInclusive: false,
    };
  }
  // SQLite has no boolean; anything that is not a clear 0 counts as inclusive
  // — the cautious direction, matching `toChoice` above. Reading it the other
  // way round would ring gross shelf prices as if they were net.
  const isTaxInclusive = row?.['is_tax_inclusive'] !== 0;

  // A row this device made up rather than received. See the header: this is
  // local-only mode's list, and it is judged by nothing but its own existence.
  if (row?.['tenant_id'] === null || row?.['tenant_id'] === undefined) {
    return { status: 'sellable', code, message: null, isTaxInclusive };
  }

  const location = await readDeviceLocation(db);
  if (location === null) {
    // "Which list applies HERE" has no answer without a here. The location
    // gate owns that failure and checkout refuses on it first, so raising a
    // second, competing refusal would only bury the one that can be acted on.
    return { status: 'sellable', code, message: null, isTaxInclusive };
  }

  const businessDate = businessDateOverride ?? businessDateFor(nowIso, location.timeZone);
  const candidates = await readPriceListCandidates(db, location.id, businessDate);
  const held = candidates.find((c) => c.id === priceListId);
  if (held === undefined) {
    return {
      status: 'not-offered',
      code: null,
      message: CART_NOT_OFFERED_MESSAGE,
      isTaxInclusive: false,
    };
  }
  // `is_tax_inclusive` is a synced column and CAN change under a cart that is
  // already open, so the verdict carries the live value rather than whatever
  // was true when the cart was pinned. It is no longer a refusal: the cart is
  // priced in whichever direction the list currently declares.
  return { status: 'sellable', code, message: null, isTaxInclusive: held.isTaxInclusive };
}

/** Does this state stop the cart being sold? */
export function blocksSale(state: CartPriceListState): boolean {
  return state.code === null;
}

/**
 * The selection path for the ambiguous case: bind the device to one of the
 * lists the tenant's configuration already offers at this counter, then
 * re-reconcile so the result comes back through the same policy rather than
 * being asserted by the caller.
 *
 * A list outside that set is refused here. The server would refuse it too
 * (PRECONDITION_FAILED, every sale) — but a till that takes a day's trading
 * before discovering that is a till that has to be unwound by hand.
 */
export class PriceListChoiceNotOfferedError extends Error {
  constructor(readonly priceListId: string) {
    super('That price list is not one this counter is set up to sell from.');
    this.name = 'PriceListChoiceNotOfferedError';
  }
}

export async function chooseDevicePriceList(
  db: LocalDb,
  bearerToken: string | null | undefined,
  priceListId: string,
  nowIso: string = new Date().toISOString(),
): Promise<DevicePriceListState> {
  const location = await readDeviceLocation(db);
  if (readBearerScope(bearerToken).kind === 'absent' || location === null) {
    throw new PriceListChoiceNotOfferedError(priceListId);
  }
  const candidates = await readPriceListCandidates(
    db,
    location.id,
    businessDateFor(nowIso, location.timeZone),
  );
  const chosen = candidates.find((c) => c.id === priceListId);
  if (chosen === undefined) throw new PriceListChoiceNotOfferedError(priceListId);
  // Membership of the offered set is the whole test. A list's tax convention
  // is not a second gate — it is an input to the arithmetic.
  await writeActivePriceListId(db, priceListId);
  return reconcileDevicePriceList(db, bearerToken, nowIso);
}
