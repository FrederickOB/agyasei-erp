/**
 * Device enrolment: binding this device to the location it trades at.
 *
 * THE BUG THIS FILE EXISTS FOR. `writeDeviceLocation` — the enrolment entry
 * point — was written and never called from anywhere. Every device therefore
 * reached the counter with no `location_id` in `local_config`, and every
 * checkout was correctly refused with "This device has no location assigned."
 * The refusal was right; the missing step was that nothing ever assigned one.
 *
 * WHERE THE ANSWER COMES FROM, AND WHY IT IS NOT INVENTED HERE.
 * The device's location comes from the VERIFIED SESSION — the `locs` claim of
 * the bearer it already holds — because that is the same claim the server
 * enforces writes against (`assertLocationInScope`, apps/api/src/trpc.ts). Any
 * other source is a guess, and a guessed location is not a cosmetic error: a
 * sale filed against the wrong outlet moves stock and cash at a counter that
 * never saw either. So:
 *
 *   exactly one location in scope  → provision it. Unambiguous; must Just Work.
 *   more than one                  → REFUSE and name the choice. Never pick the
 *                                    first: the device has no way to know which
 *                                    counter it is standing on.
 *   none                           → REFUSE. Fail closed.
 *   stored value not in scope      → reconcile to the session and say so. The
 *                                    device was re-enrolled or the scope moved;
 *                                    either way the old value is not tradeable.
 *
 * Reconciliation runs on EVERY start (main.tsx), not once at first install: a
 * device re-assigned between one morning and the next must pick that up when
 * it is next switched on, not when someone remembers to clear its storage.
 */
import type { DbExecutor, LocalDb } from '../db';
import {
  clearDeviceLocation,
  readDeviceLocationId,
  writeDeviceLocation,
} from '../queries/session';
import { readBearerScope } from './bearer-claims';

export type DeviceLocationStatus =
  /** No bearer: local-only mode. Whatever is provisioned locally stands (§8.1). */
  | 'local-only'
  /** The stored location is in the session's scope. Nothing to do. */
  | 'confirmed'
  /** The session named exactly one location and this device had none. Bound. */
  | 'provisioned'
  /** The stored location was not in scope; replaced with the session's. */
  | 'reconciled'
  /** The session covers several locations. The device must be told which one. */
  | 'ambiguous'
  /** The session covers no location at all. Fail closed. */
  | 'unscoped'
  /** A bearer this device cannot read. Reported, never silently treated as empty. */
  | 'session-unreadable';

/** A location the operator may bind this device to. Codes are tenant data. */
export interface LocationChoice {
  readonly id: string;
  /** The location's own code, once its row has synced. Empty until then. */
  readonly code: string;
  /** The location's own name, once its row has synced. */
  readonly name: string | null;
}

export interface DeviceLocationState {
  readonly status: DeviceLocationStatus;
  /** The location sales will be filed against. `null` means this device cannot sell. */
  readonly locationId: string | null;
  /** The choice, when the session names more than one. Empty otherwise. */
  readonly choices: readonly LocationChoice[];
  /** A stored location that reconciliation replaced or discarded. */
  readonly replacedLocationId: string | null;
  /** One sentence a counter can act on, or `null` when nothing is wrong. */
  readonly message: string | null;
}

/**
 * Does this state stop the device selling?
 *
 * Local-only mode is never blocked here — an un-provisioned local-only device
 * is refused at checkout, where the original message ("This device has no
 * location assigned") is both true and the whole story. A device WITH a
 * session and no usable location needs the more specific sentence this module
 * produces, because "assign a location" is not the action to take when the
 * real problem is that the session names four of them.
 */
export function blocksSales(state: DeviceLocationState): boolean {
  return state.locationId === null && state.status !== 'local-only';
}

/**
 * The candidate rows behind a set of location ids, in the SESSION's order.
 * Exported because the selection screen re-reads them live: a device asked to
 * choose before the tenant's `location` rows have synced sees bare ids, and
 * they should turn into names as the rows arrive, without anyone reloading a
 * till. Components never hold SQL (§8.3), so the query lives here.
 */
export async function readLocationChoices(
  db: DbExecutor,
  ids: readonly string[],
): Promise<readonly LocationChoice[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.getAll(
    `SELECT id, code, name FROM location WHERE id IN (${placeholders})`,
    [...ids],
  );
  const byId = new Map<string, { code: string; name: string | null }>();
  for (const row of rows) {
    const id = row['id'];
    if (typeof id !== 'string') continue;
    const code = row['code'];
    const name = row['name'];
    byId.set(id, {
      code: typeof code === 'string' ? code : '',
      name: typeof name === 'string' && name.length > 0 ? name : null,
    });
  }
  // Session order, not database order: the list a person is asked to choose
  // from should not reshuffle itself as rows arrive over the sync stream.
  return ids.map((id) => ({ id, code: byId.get(id)?.code ?? '', name: byId.get(id)?.name ?? null }));
}

/** How a location is named to a human before its row has arrived. */
function describe(choice: LocationChoice): string {
  if (choice.name !== null && choice.code.length > 0) return `${choice.name} (${choice.code})`;
  if (choice.name !== null) return choice.name;
  if (choice.code.length > 0) return choice.code;
  return choice.id;
}

function ambiguousMessage(choices: readonly LocationChoice[]): string {
  return (
    `This sign-in covers ${choices.length} locations, so this device cannot tell which counter ` +
    `it is. Choose one before recording a sale: ${choices.map(describe).join(', ')}.`
  );
}

const UNSCOPED_MESSAGE =
  'This sign-in covers no location at all, so this device cannot record a sale. ' +
  'The account needs a location added to it, then sign in again on this device.';

/**
 * Bind this device to the location its session is scoped to, or refuse and say
 * precisely why. Safe to call on every start; it writes only when the stored
 * value and the session disagree.
 *
 * @param bearerToken the device's API bearer (VITE_API_TOKEN / its credential
 *        path), or null in local-only mode. DECODED, never verified — see
 *        bearer-claims.ts for why that is self-configuration and not trust.
 */
export async function reconcileDeviceLocation(
  db: LocalDb,
  bearerToken: string | null | undefined,
): Promise<DeviceLocationState> {
  const stored = await readDeviceLocationId(db);
  const scope = readBearerScope(bearerToken);

  if (scope.kind === 'absent') {
    // Local-only mode is the offline rehearsal and must not regress: there is
    // no session to reconcile against, so the dev seed's provisioning stands.
    return {
      status: 'local-only',
      locationId: stored,
      choices: [],
      replacedLocationId: null,
      message: null,
    };
  }

  if (scope.kind === 'unreadable') {
    // The stored binding is LEFT ALONE. The server is the enforcement point:
    // if this token is in fact valid, blocking the counter over our own
    // decoding failure would close a till for no reason; if it is not, the
    // upload is refused server-side and no sale is ever filed. Either way the
    // deployment problem is surfaced rather than swallowed.
    return {
      status: 'session-unreadable',
      locationId: stored,
      choices: [],
      replacedLocationId: null,
      message: `This device cannot read its own sign-in — ${scope.reason}. It needs signing in again.`,
    };
  }

  const inScope = scope.locationIds;

  if (inScope.length === 0) {
    // Fail closed, and clear a stale binding on the way out: a session that
    // may write nowhere must not keep trading on a location it once had.
    if (stored !== null) await clearDeviceLocation(db);
    return {
      status: 'unscoped',
      locationId: null,
      choices: [],
      replacedLocationId: stored,
      message: UNSCOPED_MESSAGE,
    };
  }

  if (stored !== null && inScope.includes(stored)) {
    return {
      status: 'confirmed',
      locationId: stored,
      choices: [],
      replacedLocationId: null,
      message: null,
    };
  }

  const [only] = inScope;
  if (inScope.length === 1 && only !== undefined) {
    // Unambiguous. This is the case that must Just Work with no manual step —
    // and the case that replaces a dev-seeded location in sync mode.
    const [choice] = await readLocationChoices(db, [only]);
    await writeDeviceLocation(db, {
      id: only,
      ...(choice !== undefined && choice.code.length > 0 ? { code: choice.code } : {}),
    });
    if (stored === null) {
      return {
        status: 'provisioned',
        locationId: only,
        choices: [],
        replacedLocationId: null,
        message: null,
      };
    }
    return {
      status: 'reconciled',
      locationId: only,
      choices: [],
      replacedLocationId: stored,
      message:
        'This device now records sales against the location its sign-in covers. ' +
        'The location it previously held is no longer in that sign-in and is not being used.',
    };
  }

  // More than one, and nothing stored that the session covers. The device does
  // not guess — not even "the first one", which is the same guess wearing an
  // ordering. It refuses, names the choice, and waits to be told.
  const choices = await readLocationChoices(db, inScope);
  if (stored !== null) await clearDeviceLocation(db);
  return {
    status: 'ambiguous',
    locationId: null,
    choices,
    replacedLocationId: stored,
    message: ambiguousMessage(choices),
  };
}

/**
 * The selection path for the ambiguous case: bind the device to one of the
 * locations the SESSION already covers, then re-reconcile so the result comes
 * back through the same policy rather than being asserted by the caller.
 *
 * A choice outside the session's scope is refused here. It would be refused by
 * the server too (FORBIDDEN, every sale) — but a till that takes a day's
 * trading before discovering that is a till that has to be unwound by hand.
 */
export class LocationChoiceOutOfScopeError extends Error {
  constructor(readonly locationId: string) {
    super('That location is not covered by this device’s sign-in.');
    this.name = 'LocationChoiceOutOfScopeError';
  }
}

export async function chooseDeviceLocation(
  db: LocalDb,
  bearerToken: string | null | undefined,
  locationId: string,
): Promise<DeviceLocationState> {
  const scope = readBearerScope(bearerToken);
  if (scope.kind !== 'scoped' || !scope.locationIds.includes(locationId)) {
    throw new LocationChoiceOutOfScopeError(locationId);
  }
  const [choice] = await readLocationChoices(db, [locationId]);
  await writeDeviceLocation(db, {
    id: locationId,
    ...(choice !== undefined && choice.code.length > 0 ? { code: choice.code } : {}),
  });
  return reconcileDeviceLocation(db, bearerToken);
}
