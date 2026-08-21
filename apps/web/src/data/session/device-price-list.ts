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
 *   settled but tax-inclusive  → REFUSE, at the till. Neither this client nor
 *                                the API can price a gross shelf price yet, so
 *                                binding it would record sales the upload then
 *                                rejects — the very failure this file exists
 *                                to end. See `UNSUPPORTED_MESSAGE`.
 *   stored list not a candidate → reconcile to configuration and say so.
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
  | 'location-unknown'
  /** Configuration settles it, and it is a list this build cannot yet ring. */
  | 'unsupported';

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
   * Shelf prices that already contain tax. Carried because it decides whether
   * this build can ring against the list at all — see `UNSUPPORTED_MESSAGE`.
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
 * A list this build cannot ring against, and why that is a REFUSAL rather than
 * a reason to pick the next one down.
 *
 * The counter's local arithmetic treats `unit_price_e4` as a NET unit price:
 * `lineNetMinor` (@erp/money) extends and rounds it, and nothing anywhere
 * extracts tax back out of a gross shelf price. The API says the same thing
 * about itself in the same words — `sales.createSale` answers
 * PRECONDITION_FAILED, 'tax-inclusive price lists are not yet supported',
 * rather than approximating the extraction (ADR-0004: rounding is explicit at
 * every boundary, never improvised).
 *
 * So the device stops HERE, at the till, before a cart exists. The tempting
 * alternative — quietly resolving to the next list down — is the worst thing
 * this module could do: it would charge every walk-in customer off a list the
 * tenant did not choose for them, all day, with nothing on screen to say so.
 */
const UNSUPPORTED_MESSAGE =
  'The price list set up for this counter uses prices that already include tax, which this ' +
  'version cannot yet ring up. This needs a price list with tax-exclusive prices, or an ' +
  'update to this app.';

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
    if (held.isTaxInclusive) {
      await clearActivePriceListId(db);
      return state('unsupported', null, UNSUPPORTED_MESSAGE, {
        choices: [held],
        replaced: stored,
      });
    }
    return state('confirmed', stored, null);
  }

  const tied = bestRanked(candidates);
  const [only] = tied;
  if (tied.length === 1 && only !== undefined) {
    // Settled, but not necessarily sellable. Refuse BEFORE binding: a bound
    // list is one `createCart` will hand to a cart and `checkout` will put on
    // the wire, and the whole point of this module is that no sale is recorded
    // against a list that cannot survive the trip.
    if (only.isTaxInclusive) {
      if (stored !== null) await clearActivePriceListId(db);
      return state('unsupported', null, UNSUPPORTED_MESSAGE, {
        choices: [only],
        replaced: stored,
      });
    }
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
  if (chosen.isTaxInclusive) {
    // Offered, genuinely configured, and still not rungable. Reported through
    // the state rather than thrown, because this is not a bad choice by whoever
    // tapped it — it is the same refusal reconciliation would reach.
    await clearActivePriceListId(db);
    return state('unsupported', null, UNSUPPORTED_MESSAGE, { choices: [chosen] });
  }
  await writeActivePriceListId(db, priceListId);
  return reconcileDevicePriceList(db, bearerToken, nowIso);
}
