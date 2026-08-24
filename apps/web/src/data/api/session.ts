/**
 * What this session may do, as far as the SCREEN is concerned.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ THE SERVER'S OWN WORDS FIRST (apps/api/src/routers/session.ts):
 * "UX AFFORDANCE ONLY — the server re-authorises every write at ingest.
 *  Do not treat absence here as security, or presence here as permission."
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything below decides which CONTROLS a person is offered. It decides
 * nothing about what the server accepts, and it is trivially editable by
 * anyone holding the tablet. Hiding a button someone may not press is a
 * courtesy that saves them filling in a form that will be refused after the
 * customer has walked out; it is not a boundary, and no code anywhere may
 * treat the absence of a control as one (CLAUDE.md §2.6, 02 §2.3 layer 3).
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A CACHE
 * ---------------------------------------------------------------------------
 * `session.permissions` is a server read, so a partitioned device cannot ask
 * it. Three states are therefore possible and they are NOT the same:
 *
 *   live        — asked the server just now.
 *   remembered  — could not ask; this device holds the answer from last time,
 *                 for THIS user, and uses it to lay out the navigation.
 *   unknown     — could not ask and has nothing to remember.
 *
 * `unknown` deliberately shows every capability-gated destination rather than
 * hiding them. Hiding on a guess is its own kind of lie: an outlet manager
 * told "you have no reports" because the radio was down would escalate the
 * wrong problem entirely, and the screen behind the tab says plainly that it
 * cannot be answered offline. Presence of a tab is not a claim of permission.
 *
 * The cache is keyed to the token's `uid` and is discarded the moment the
 * device is handed to a different session, so one person's affordances never
 * survive into another's.
 */
import { uuidv7 } from '../../lib/uuidv7';
import type { DbExecutor, LocalDb } from '../db';
import { readBearerUserId } from '../session/bearer-claims';
import {
  apiQuery,
  asArray,
  asRecord,
  asString,
  type ApiCallOptions,
  type ApiFailure,
} from './client';

/**
 * The PLATFORM capability codes this client's screens key off.
 *
 * These are global catalogue codes (`platform.permission` — 36 of them, no
 * `tenant_id`), not a role enum and not tenant vocabulary: a tenant composes
 * them into its own roles and cannot mint one (CLAUDE.md §2.6). Nothing here
 * names a role, and no screen may branch on one.
 */
export const CAPABILITY = {
  /** See reporting for the locations you hold it at. */
  reportLocation: 'report.view.location',
  /** WIDENS reporting to the whole tenant. Never an alternative to the above. */
  reportTenant: 'report.view.tenant',
  /** Cost, margin and inventory-days figures — a strictly narrower audience. */
  reportMargin: 'report.view.margin',
  /** See stock and the low-stock alert at a location. */
  stockView: 'stock.view',
  /** Set a reorder threshold at a location. */
  reorderManage: 'stock.reorder.manage',
  /**
   * Correct what the ledger says is physically there, at a location. The
   * server derives this same code from the movement's `sourceKind` and
   * re-checks it at ingest; counter staff do not hold it.
   */
  stockAdjust: 'stock.adjust',
  /** Look a customer's credit position up. Held at any location. */
  creditView: 'credit.view',
  /**
   * Work the human review queue — the conflicts the system could not settle
   * on its own (CLAUDE.md §2.2). The template gives it to a regional manager
   * and to Accounts, and withholds it from the counter and from an outlet
   * manager. The server checks it again, and then checks the ROW's own
   * `required_permission` at the location the conflict concerns; this
   * capability is what puts the destination on the nav at all.
   */
  conflictReview: 'sync.conflict.review',
  /**
   * Open a customer's credit account, amend its terms, and MOVE IT BETWEEN
   * ACTIVE, SUSPENDED AND CLOSED — the switch behind the check
   * `sales.createSale` has always made and nothing could satisfy. TENANT-WIDE
   * on the server (`at: 'tenant'` — held at every root of the tenant's
   * location tree), which is stricter than anything this file can check:
   * `holdsCapability`
   * answers "somewhere". An outlet manager does not hold it and Accounts does,
   * so the screen shows a manager the account and not the form. The server
   * refuses either way; hiding the form spares somebody filling it in.
   */
  creditAccountManage: 'credit.account.manage',
  /**
   * SET OR CHANGE A CREDIT LIMIT — one of the constitution's two hard
   * prohibitions (CLAUDE.md §2.6: outlet staff never). Required IN ADDITION to
   * `credit.account.manage` on every limit decision, so there is no path to a
   * limit that does not pass through it.
   */
  creditLimitChange: 'credit.limit.change',
  /** Record a payment, adjustment or write-off against a credit account. */
  creditEntryRecord: 'credit.entry.record',
  /** Post fee accruals. Tenant-wide, and gated again by the fee policy itself. */
  creditFeeAccrue: 'credit.fee.accrue',

  // ── Phase 2: buying, receiving and moving goods ─────────────────────────
  //
  // RAISING AN ORDER AND APPROVING ONE ARE TWO CODES, and the pair is the
  // whole control. One person who can do both can commit the business to a
  // spend nobody else saw; one who can approve an order and also sign for its
  // goods can fabricate a receipt against an order they invented. The screens
  // read the two separately and never infer one from the other — and the
  // server derives the required code from `toStatus` and re-checks it at
  // ingest, so hiding a button remains a courtesy (CLAUDE.md §2.6).

  /** See who supplies what, on what terms, at what price. */
  supplierView: 'supplier.view',
  /** Create or amend a supplier. Held at the ROOT — a supplier has no outlet. */
  supplierManage: 'supplier.manage',
  /** Read purchase orders for the locations you hold it at. */
  purchaseOrderView: 'purchase.order.view',
  /** Raise and amend a DRAFT order, and submit it. Never approves one. */
  purchaseOrderCreate: 'purchase.order.create',
  /** Authorise an order. A separate act by a separate person, and bounded. */
  purchaseOrderApprove: 'purchase.order.approve',
  /** Sign for goods at a yard. NOT `stock.receive`, and NOT the approval. */
  goodsReceive: 'goods.receive',
  /** "Where is my order?" — the wider grant; the counter holds it. */
  deliveryView: 'logistics.delivery.view',
  /** Hand a load to a haulier and move its status along. */
  dispatchManage: 'logistics.dispatch.manage',
} as const;

export interface CapabilityGrant {
  readonly code: string;
  readonly locationId: string;
}

export interface PermissionSnapshot {
  readonly userId: string;
  readonly grants: readonly CapabilityGrant[];
  /** Distinct capability codes, in any location. */
  readonly codes: readonly string[];
  /** Distinct locations this session may act at in some way. */
  readonly locationIds: readonly string[];
}

export type PermissionsState =
  /** The first read has not come back yet. Laid out like `unknown`. */
  | { readonly status: 'resolving' }
  /** This build has no server at all — nothing server-side is reachable. */
  | { readonly status: 'no-session' }
  /** Could not ask and has nothing remembered for this user. */
  | { readonly status: 'unknown'; readonly failure: ApiFailure }
  /** Could not ask; laying the screen out from what this device last heard. */
  | {
      readonly status: 'remembered';
      readonly snapshot: PermissionSnapshot;
      readonly asOfMs: number;
      readonly failure: ApiFailure;
    }
  /** Asked the server just now. */
  | { readonly status: 'live'; readonly snapshot: PermissionSnapshot; readonly asOfMs: number };

/**
 * Does this session hold `code` anywhere?
 *
 * `unknown` answers TRUE — see the header: an unanswerable question is not a
 * refusal. `no-session` answers FALSE, because with no server there is
 * nothing behind the control to reach.
 */
export function holdsCapability(state: PermissionsState, code: string): boolean {
  switch (state.status) {
    case 'no-session':
      return false;
    case 'resolving':
    case 'unknown':
      return true;
    case 'remembered':
    case 'live':
      return state.snapshot.codes.includes(code);
  }
}

/**
 * Does this session hold `code` — for a write that will be QUEUED?
 *
 * The same question as `holdsCapability`, answered the OTHER way for
 * `unknown`, and the asymmetry is deliberate rather than an inconsistency.
 *
 * `holdsCapability` over-approximates on purpose: hiding a READ from somebody
 * who holds it costs them the feature, and offering one they do not hold costs
 * them a refusal they can read. Neither outcome damages anything.
 *
 * An OUTBOX write is not symmetric like that. The upload queue is ORDERED and
 * `classifyRejection` (data/sync/upload.ts) treats an unrecognised rejection as
 * RETRYABLE, on purpose — wrongly dead-lettering a write is the loss path. So a
 * queued write the server answers `FORBIDDEN: PERMISSION_DENIED` to sits at the
 * head of the queue being retried for ever, and **every sale behind it stops
 * draining**. The till just looks "stuck".
 *
 * So for a queued write the honest answer to "I could not ask" is NO. The cost
 * of being wrong is one person walking to the desk; the cost of the other
 * mistake is an outlet that silently stops uploading.
 */
export function holdsCapabilityForQueuedWrite(state: PermissionsState, code: string): boolean {
  switch (state.status) {
    case 'no-session':
    case 'resolving':
    case 'unknown':
      return false;
    case 'remembered':
    case 'live':
      return state.snapshot.codes.includes(code);
  }
}

/** Does this session hold `code` AT a specific location? Same `unknown` rule. */
export function holdsCapabilityAt(
  state: PermissionsState,
  code: string,
  locationId: string,
): boolean {
  switch (state.status) {
    case 'no-session':
      return false;
    case 'resolving':
    case 'unknown':
      return true;
    case 'remembered':
    case 'live':
      return state.snapshot.grants.some((g) => g.code === code && g.locationId === locationId);
  }
}

/** The snapshot behind a state, or null when there is none. */
export function snapshotOf(state: PermissionsState): PermissionSnapshot | null {
  return state.status === 'remembered' || state.status === 'live' ? state.snapshot : null;
}

// ---------------------------------------------------------------------------
// The wire read
// ---------------------------------------------------------------------------

function mapPermissions(json: unknown): PermissionSnapshot {
  const root = asRecord(json, 'session.permissions');
  const userId = asString(root['userId'], 'session.permissions.userId');
  const grants: CapabilityGrant[] = asArray(root['grants'], 'session.permissions.grants').map(
    (entry, i) => {
      const g = asRecord(entry, `session.permissions.grants[${String(i)}]`);
      return {
        code: asString(g['code'], `grants[${String(i)}].code`),
        locationId: asString(g['locationId'], `grants[${String(i)}].locationId`),
      };
    },
  );
  return {
    userId,
    grants,
    codes: [...new Set(grants.map((g) => g.code))].sort(),
    locationIds: [...new Set(grants.map((g) => g.locationId))].sort(),
  };
}

// ---------------------------------------------------------------------------
// The device-local memory of it
// ---------------------------------------------------------------------------

/** Device-local, never synced. One row; replaced whole, never merged. */
export const CONFIG_KEY_PERMISSIONS = 'session_permissions';

interface CachedPermissions {
  readonly userId: string;
  readonly grants: readonly CapabilityGrant[];
  readonly asOfMs: number;
}

async function readCache(db: DbExecutor): Promise<CachedPermissions | null> {
  const rows = await db.getAll('SELECT value FROM local_config WHERE key = ? LIMIT 1', [
    CONFIG_KEY_PERMISSIONS,
  ]);
  const raw = rows[0]?.['value'];
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const root = asRecord(parsed, 'cached permissions');
    const grants = asArray(root['grants'], 'cached grants').map((e, i) => {
      const g = asRecord(e, `cached grants[${String(i)}]`);
      return {
        code: asString(g['code'], 'cached grant code'),
        locationId: asString(g['locationId'], 'cached grant locationId'),
      };
    });
    const asOfMs = root['asOfMs'];
    return {
      userId: asString(root['userId'], 'cached userId'),
      grants,
      asOfMs: typeof asOfMs === 'number' ? asOfMs : 0,
    };
  } catch {
    // A cache this build cannot read is treated as absent. It is an
    // affordance, so there is nothing to escalate and nothing to lose.
    return null;
  }
}

async function writeCache(db: LocalDb, cached: CachedPermissions): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_PERMISSIONS]);
    await tx.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      CONFIG_KEY_PERMISSIONS,
      JSON.stringify(cached),
    ]);
  });
  db.changes.notify();
}

function snapshotFrom(cached: CachedPermissions): PermissionSnapshot {
  return {
    userId: cached.userId,
    grants: cached.grants,
    codes: [...new Set(cached.grants.map((g) => g.code))].sort(),
    locationIds: [...new Set(cached.grants.map((g) => g.locationId))].sort(),
  };
}

export interface ResolvePermissionsOptions extends ApiCallOptions {
  /** The device's own bearer, for keying the cache. Never sent from here. */
  readonly bearerToken?: string | null;
}

/**
 * Ask the server; fall back to what this device remembers for this user.
 *
 * The order is deliberate: the server is asked FIRST and its answer always
 * wins, so a capability revoked at HQ stops appearing on the next successful
 * read rather than on the next reinstall.
 */
export async function resolvePermissions(
  db: LocalDb,
  options: ResolvePermissionsOptions = {},
): Promise<PermissionsState> {
  const { bearerToken, ...call } = options;
  const result = await apiQuery('session.permissions', undefined, mapPermissions, call);

  if (result.ok) {
    await writeCache(db, {
      userId: result.data.userId,
      grants: result.data.grants,
      asOfMs: result.fetchedAtMs,
    });
    return { status: 'live', snapshot: result.data, asOfMs: result.fetchedAtMs };
  }

  if (result.failure.kind === 'not-configured') return { status: 'no-session' };

  const cached = await readCache(db);
  const uid = readBearerUserId(bearerToken ?? null);
  // A cache belonging to somebody else is not a fallback, it is a leak of
  // one person's affordances into another's session. Discarded, not used.
  if (cached === null || uid === null || cached.userId !== uid) {
    return { status: 'unknown', failure: result.failure };
  }
  return {
    status: 'remembered',
    snapshot: snapshotFrom(cached),
    asOfMs: cached.asOfMs,
    failure: result.failure,
  };
}
