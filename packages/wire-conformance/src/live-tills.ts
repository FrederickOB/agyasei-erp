/**
 * Tills and tender lines for the LIVE drills that build sale payloads by hand.
 *
 * Since migrations 0020–0022 a sale names the till it was rung into
 * (`cashSessionId`, whose business date is the sale's) and how it was paid
 * (`tenders`, one line per tenant method). These drills used to send
 * `businessDate` and `tender: 'CASH' | 'CREDIT'`; the contract refuses both now.
 *
 * Two pieces, and nothing clever:
 *  - the tenant's own cash and on-account METHOD ids, read by their platform
 *    properties (`is_cash`, `is_on_account`) — never by a code or a name;
 *  - one SHARED-drawer till per (location, business date), opened ONCE through
 *    the real `cashSession.open` route by whichever principal the drill hands
 *    over (it needs `cash.session.open` at that location).
 *
 * Every tender line is a BALANCE line (no amount): it settles the server's own
 * total, which is what these drills always asserted against.
 */
import { randomUUID } from 'node:crypto';

export interface LiveTenderIds {
  readonly cash: string;
  readonly onAccount: string;
}

export type RowQuery = <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/**
 * The tenant is named EXPLICITLY in the predicate: some drills hold a
 * superuser connection with no RLS context, and a method id from the wrong
 * tenant is exactly what the server refuses (and must).
 */
export async function liveTenderIds(query: RowQuery, tenantId: string): Promise<LiveTenderIds> {
  const rows = await query<{ id: string; is_cash: boolean; is_on_account: boolean }>(
    `select id, is_cash, is_on_account from app.tender_method
      where tenant_id = $1 and is_active and deleted_at is null order by sort_order, id`,
    [tenantId],
  );
  const cash = rows.find((r) => r.is_cash)?.id;
  const onAccount = rows.find((r) => r.is_on_account)?.id;
  if (cash === undefined || onAccount === undefined) {
    throw new Error('the tenant has no cash or on-account tender method — re-run pnpm stack:bootstrap');
  }
  return { cash, onAccount };
}

/** The `tenders` a CASH or CREDIT drill sale carries. */
export function tenderLines(kind: 'CASH' | 'CREDIT', ids: LiveTenderIds): Record<string, unknown>[] {
  return [
    kind === 'CREDIT'
      ? { methodId: ids.onAccount, settlement: 'ON_ACCOUNT' }
      : { methodId: ids.cash, settlement: 'IMMEDIATE' },
  ];
}

/** Opens each (location, day) till once, through the route a device's outbox drains to. */
export class LiveTills {
  private readonly opened = new Map<string, string>();

  constructor(
    private readonly open: (input: Record<string, unknown>) => Promise<{ ok: boolean; detail: string }>,
  ) {}

  async till(locationId: string, businessDate: string): Promise<string> {
    const key = `${locationId}|${businessDate}`;
    const hit = this.opened.get(key);
    if (hit !== undefined) return hit;
    const id = randomUUID();
    const res = await this.open({
      idempotencyKey: id,
      locationId,
      businessDate,
      openingFloatMinor: '0',
      openedAt: new Date().toISOString(),
      openedOffline: false,
      drawer: 'SHARED',
    });
    if (!res.ok) throw new Error(`could not open the till at ${locationId} for ${businessDate}: ${res.detail}`);
    this.opened.set(key, id);
    return id;
  }
}
