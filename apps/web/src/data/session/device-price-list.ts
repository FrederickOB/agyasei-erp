/**
 * Device setup, part two: WHICH LIST THIS TILL PRICES FROM.
 *
 * THE SECOND DEAD ENTRY POINT. `writeActivePriceListId` (data/queries/session.ts)
 * was exported and never called from anywhere in `src` — the same shape of bug
 * as `writeDeviceLocation`, one field over, found by auditing for it rather
 * than by waiting for a counter to report it. Its consequence was live and
 * immediate: the only thing that ever wrote `price_list_id` was the DEV SEED,
 * so a synced device carried the seed's placeholder list forever. The sale
 * payload names a price list by CODE, the seed's code is a neutral placeholder
 * no tenant has, and `sales.createSale` answers
 *
 *     PRECONDITION_FAILED — no price list <code> in force
 *
 * for a code it cannot find (apps/api/src/routers/sales.ts). Fixing only the
 * location would have moved the counter's failure from one refusal to another.
 *
 * WHERE THE ANSWER COMES FROM. Not from a claim in the token — the token
 * scopes locations, not pricing — and not from a rule invented here. It comes
 * from the tenant's OWN `price_list` rows as they arrive over the sync stream:
 * a list this device holds, in force on the trading day, whose location scope
 * covers this device. Same policy as the location, for the same reason:
 *
 *   exactly one candidate → provision it. Unambiguous; must Just Work.
 *   more than one         → REFUSE and name the choice. `priority` is the
 *                           tenant's line-pricing resolution order, NOT a
 *                           statement about which counter sells from which
 *                           list, and reading it as one would have a till
 *                           quietly charging one customer segment's rates to
 *                           another. Wrong money, silently, at a counter (§8.7).
 *   none                  → REFUSE. Fail closed until configuration arrives.
 *
 * WHY A LOCAL PLACEHOLDER IS NEVER A CANDIDATE IN SYNC MODE. The dev seed
 * writes its rows with `tenant_id` NULL, because a device never asserts a
 * tenant (CLAUDE.md §2.1) — which makes "carries a tenant id" exactly the
 * test for "arrived from the server". A device with a session trades only on
 * rows the server sent it.
 *
 * Local-only mode (no session) is untouched: the seed's placeholder is the
 * only pricing that exists there, and that mode is the offline rehearsal.
 */
import type { DbExecutor, LocalDb } from '../db';
import {
  clearActivePriceListId,
  readActivePriceListId,
  writeActivePriceListId,
} from '../queries/session';

export type DevicePriceListStatus =
  /** No session: the dev seed's placeholder list stands (§8.1). */
  | 'local-only'
  /** The stored list is one of this device's candidates. Nothing to do. */
  | 'confirmed'
  /** Exactly one candidate and this device had none. Bound. */
  | 'provisioned'
  /** The stored list is no longer a candidate; replaced by the only one left. */
  | 'reconciled'
  /** Several candidates. Someone must say which list this counter sells from. */
  | 'ambiguous'
  /** No usable list at all — configuration has not arrived, or none is in force. */
  | 'unconfigured';

/** A price list the operator may bind this till to. Codes are tenant data. */
export interface PriceListChoice {
  readonly id: string;
  /** The tenant's own code for the list — this is what the wire carries. */
  readonly code: string;
  readonly name: string | null;
  /**
   * Whether the tenant's prices on this list already include tax. Surfaced
   * because `sales.createSale` refuses tax-inclusive lists today, and someone
   * choosing between two lists deserves to know which one the server can
   * actually price. It is NOT used to filter the choice: hiding a list the
   * tenant configured would substitute one silent wrong answer for another.
   */
  readonly isTaxInclusive: boolean | null;
}

export interface DevicePriceListState {
  readonly status: DevicePriceListStatus;
  /** The list carts are rung against. `null` means this device cannot price. */
  readonly priceListId: string | null;
  /** The choice, when the device holds more than one candidate. */
  readonly choices: readonly PriceListChoice[];
  /** A stored list that reconciliation replaced or discarded. */
  readonly replacedPriceListId: string | null;
  /** One sentence a counter can act on, or `null` when nothing is wrong. */
  readonly message: string | null;
}

/**
 * Does this state stop the device selling?
 *
 * Local-only mode is never blocked here, exactly as with the location: an
 * unconfigured local-only device is refused at checkout, where the existing
 * message is the whole story.
 */
export function blocksSalesOnPriceList(state: DevicePriceListState): boolean {
  return state.priceListId === null && state.status !== 'local-only';
}

export interface PriceListScope {
  /** `true` when this device holds a session — see the header. */
  readonly hasSession: boolean;
  /** The location this device is bound to, or `null` when it has none yet. */
  readonly locationId: string | null;
  /** The trading day the candidates must be in force on (YYYY-MM-DD). */
  readonly businessDate: string;
}

interface PriceListRow {
  readonly id: string;
  readonly code: string;
  readonly name: string | null;
  readonly tenantId: string | null;
  readonly isTaxInclusive: boolean | null;
  readonly locationId: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function flag(value: unknown): boolean | null {
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'boolean') return value;
  return null;
}

/**
 * Every price list row this device holds, shaped. Read whole because the local
 * table holds a tenant's handful of lists, and doing the date and scope
 * comparisons here keeps them in one readable place instead of spread across
 * an SQL string that has to agree with the server's predicate.
 */
async function readAllPriceLists(db: DbExecutor): Promise<readonly PriceListRow[]> {
  const rows = await db.getAll(
    `SELECT id, code, name, tenant_id, is_tax_inclusive, location_id,
            effective_from, effective_to
       FROM price_list`,
  );
  const out: PriceListRow[] = [];
  for (const row of rows) {
    const id = text(row['id']);
    const code = text(row['code']);
    if (id === null || code === null) continue;
    out.push({
      id,
      code,
      name: text(row['name']),
      tenantId: text(row['tenant_id']),
      isTaxInclusive: flag(row['is_tax_inclusive']),
      locationId: text(row['location_id']),
      effectiveFrom: text(row['effective_from']),
      effectiveTo: text(row['effective_to']),
    });
  }
  return out;
}

/**
 * In force on the trading day, on the SAME half-open interval the server
 * prices with: `effective_from <= date < effective_to`
 * (apps/api/src/routers/sales.ts). A list whose last day is today is still
 * sellable today; one whose `effective_to` is today is not.
 *
 * ISO dates compare correctly as strings, which is why the wire and the local
 * mirror both keep them as `YYYY-MM-DD` text.
 */
function inForceOn(row: PriceListRow, businessDate: string): boolean {
  if (row.effectiveFrom !== null && row.effectiveFrom > businessDate) return false;
  if (row.effectiveTo !== null && row.effectiveTo <= businessDate) return false;
  return true;
}

/** NULL location scope means the whole tenant (packages/db 0003 migration). */
function coversLocation(row: PriceListRow, locationId: string | null): boolean {
  if (row.locationId === null) return true;
  return locationId !== null && row.locationId === locationId;
}

/**
 * The lists this device may be bound to. Exported because the selection screen
 * re-reads them live — a till asked to choose before the tenant's `price_list`
 * rows have all arrived should see the list grow, not need a reload. Components
 * never hold SQL (§8.3), so the query lives here.
 */
export async function readPriceListChoices(
  db: DbExecutor,
  scope: PriceListScope,
): Promise<readonly PriceListChoice[]> {
  const rows = await readAllPriceLists(db);
  return rows
    .filter((row) => (scope.hasSession ? row.tenantId !== null : true))
    .filter((row) => inForceOn(row, scope.businessDate))
    .filter((row) => coversLocation(row, scope.locationId))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isTaxInclusive: row.isTaxInclusive,
    }));
}

function describe(choice: PriceListChoice): string {
  return choice.name === null ? choice.code : `${choice.name} (${choice.code})`;
}

function ambiguousMessage(choices: readonly PriceListChoice[]): string {
  return (
    `This organisation has ${choices.length} price lists in force, so this device cannot tell ` +
    `which one this counter sells from. Choose one before recording a sale: ` +
    `${choices.map(describe).join(', ')}.`
  );
}

const UNCONFIGURED_MESSAGE =
  'No price list has reached this device yet, so it cannot price anything. ' +
  'It will be ready once setup data finishes arriving; if it does not, this ' +
  'sign-in’s location has no price list in force today.';

/**
 * Bind this till to the price list it sells from, or refuse and say why. Safe
 * to call on every start; it writes only when the stored value and the
 * tenant's configuration disagree.
 */
export async function reconcileActivePriceList(
  db: LocalDb,
  scope: PriceListScope,
): Promise<DevicePriceListState> {
  const stored = await readActivePriceListId(db);

  if (!scope.hasSession) {
    return {
      status: 'local-only',
      priceListId: stored,
      choices: [],
      replacedPriceListId: null,
      message: null,
    };
  }

  const choices = await readPriceListChoices(db, scope);

  if (stored !== null && choices.some((c) => c.id === stored)) {
    return {
      status: 'confirmed',
      priceListId: stored,
      choices: [],
      replacedPriceListId: null,
      message: null,
    };
  }

  if (choices.length === 0) {
    // Fail closed, and drop a placeholder on the way out: a device that keeps
    // the dev seed's list sends a code the server cannot price, and learns
    // that one refused sale at a time.
    if (stored !== null) await clearActivePriceListId(db);
    return {
      status: 'unconfigured',
      priceListId: null,
      choices: [],
      replacedPriceListId: stored,
      message: UNCONFIGURED_MESSAGE,
    };
  }

  const [only] = choices;
  if (choices.length === 1 && only !== undefined) {
    await writeActivePriceListId(db, only.id);
    return {
      status: stored === null ? 'provisioned' : 'reconciled',
      priceListId: only.id,
      choices: [],
      replacedPriceListId: stored,
      message:
        stored === null
          ? null
          : 'This device now prices from the only price list its organisation has in force. ' +
            'The list it previously held is not one of them and is not being used.',
    };
  }

  if (stored !== null) await clearActivePriceListId(db);
  return {
    status: 'ambiguous',
    priceListId: null,
    choices,
    replacedPriceListId: stored,
    message: ambiguousMessage(choices),
  };
}

/**
 * The selection path for the ambiguous case. A list outside this device's
 * candidates is refused here — the server would refuse the sale later, and a
 * till that discovers that after a day's trading has to be unwound by hand.
 */
export class PriceListNotAvailableError extends Error {
  constructor(readonly priceListId: string) {
    super('That price list is not one this device can sell from.');
    this.name = 'PriceListNotAvailableError';
  }
}

export async function chooseActivePriceList(
  db: LocalDb,
  scope: PriceListScope,
  priceListId: string,
): Promise<DevicePriceListState> {
  const choices = await readPriceListChoices(db, scope);
  if (!choices.some((c) => c.id === priceListId)) {
    throw new PriceListNotAvailableError(priceListId);
  }
  await writeActivePriceListId(db, priceListId);
  return reconcileActivePriceList(db, scope);
}
