/**
 * THE TILL — opening and closing a cash session (04 §4.8a; 08 §8.2a; 03 §3.4.2).
 *
 * Both writes are TRADE: they ride the device's ordered outbox (POST
 * /sync/upload → here) through the one idempotent pipeline, carrying the
 * client's idempotency key and claimed HLC (CLAUDE.md §2.2), exactly like a
 * sale. The session's id IS the open's idempotency key, so a sale queued
 * offline can name its till before the server has heard of either, and a
 * replayed open is the same session — never a second one.
 *
 * ── WHAT THE SERVER DOES NOT DO: REFUSE A TILL THAT HAS ALREADY TRADED ─────
 * §8.2a's open rules — ±1 day of the server's date when online, never into a
 * closed or locked accounting period, one session per till per day — are
 * enforced at the COUNTER, before the open is queued, because that is the
 * only moment refusing costs nothing (`openCheck` below is the online half).
 * By the time an open reaches this router the device may have rung a day of
 * sales into it, and every one of them names it. Refusing the open would
 * dead-letter those sales with the cash already in the drawer — CLAUDE.md
 * §2.2's loss path. So the server LANDS every open that is well-formed and
 * authorised, and FLAGS what it cannot accept silently:
 *
 *   · class #17 — a second claim on the same till for the same day lands
 *     CONTESTED (`contested_session_id`) and a review goes to a human. Never
 *     auto-resolved: two open sessions on one till means the count will not
 *     reconcile, and only a person at the outlet knows which drawer is which.
 *   · a till dated more than a day AHEAD of the server's own date at the
 *     location — a device clock in the future — goes to review.
 *   · a till dated into a CLOSED or LOCKED accounting period goes to review;
 *     its sales still land and post as late documents (05 §5.6.1).
 *
 * ── WHERE `device_id` AND `opened_by` COME FROM ───────────────────────────
 * The verified token, always (02 §2.2). The payload names only WHOSE drawer —
 * this device's own, or the location's shared one.
 */
import { TRPCError } from '@trpc/server';
import {
  CASH_SESSION_DATE_TOLERANCE_DAYS,
  cashSessionOpenCheckInput,
  closeCashSessionInput,
  openCashSessionInput,
  type CashSessionOpenCheck,
} from '@erp/contracts';
import { deterministicUuid } from '@erp/db';
import type { Queryable } from '../db.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import { assertLocationInScope, requiresPermission, router, tenantProcedure } from '../trpc.js';
import { wire } from '../wire.js';
import { SEQUENCE_REVIEW_PERMISSION, openConflictReview } from './sequence.js';

/** §3.6 class #17. Severity 2 (03 §3.6): the count will not reconcile. */
export const TILL_CLAIMED_TWICE_CLASS = 'CASH_SESSION_TILL_CLAIMED_TWICE';
export const TILL_DATE_DIVERGENCE_CLASS = 'CASH_SESSION_DATE_DIVERGENCE';
export const TILL_PERIOD_CLOSED_CLASS = 'CASH_SESSION_PERIOD_CLOSED';
const SEVERITY_REVIEW = 2;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface LocationClock {
  kind: string;
  server_date: string;
}

/**
 * The server's own calendar date AT THE LOCATION — in `location.timezone`, the
 * same zone the counter's midnight close uses, never UTC and never the
 * process's locale (a tenant's day is the tenant's).
 */
async function locationClock(tx: Queryable, locationId: string): Promise<LocationClock> {
  const res = await tx.query<LocationClock>(
    `select kind, (transaction_timestamp() at time zone timezone)::date::text as server_date
       from app.location where id = $1 and deleted_at is null`,
    [locationId],
  );
  const row = res.rows[0];
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'location not found' });
  return row;
}

async function periodStatus(tx: Queryable, businessDate: string): Promise<'open' | 'closed' | 'locked' | null> {
  const res = await tx.query<{ status: 'open' | 'closed' | 'locked' }>(
    `select status from app.accounting_period where $1::date between starts_on and ends_on`,
    [businessDate],
  );
  return res.rows[0]?.status ?? null;
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * The online answer to "may this till open for this day?" — shared by the
 * pre-open check and nothing else. Pure over its inputs.
 */
export function openRefusal(
  businessDate: string,
  serverDate: string,
  period: 'open' | 'closed' | 'locked' | null,
): string | null {
  const diff = dayDiff(businessDate, serverDate);
  if (Math.abs(diff) > CASH_SESSION_DATE_TOLERANCE_DAYS) {
    return (
      `The server's date here is ${serverDate}; this tablet proposed ${businessDate}. ` +
      `A till opens only within ${CASH_SESSION_DATE_TOLERANCE_DAYS} day of the server's date — ` +
      `check the tablet's date and time.`
    );
  }
  if (period === 'closed' || period === 'locked') {
    return `The accounting period covering ${businessDate} is ${period}. A till cannot open into it.`;
  }
  return null;
}

export const cashSessionRouter = router({
  /**
   * §8.2a's online check, asked by the counter BEFORE it queues an open. A
   * read, so it needs no idempotency key; it requires the capability it is
   * the first step of, at the location it asks about.
   */
  openCheck: tenantProcedure
    .input(cashSessionOpenCheckInput)
    .use(requiresPermission({ code: 'cash.session.open', at: 'input' }))
    .query(async ({ ctx, input }): Promise<CashSessionOpenCheck> => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const clock = await locationClock(tx, input.locationId);
        const status = await periodStatus(tx, input.businessDate);
        return {
          serverDate: clock.server_date,
          toleranceDays: CASH_SESSION_DATE_TOLERANCE_DAYS,
          periodStatus: status,
          refusal: openRefusal(input.businessDate, clock.server_date, status),
        };
      });
    }),

  open: tenantProcedure
    .input(openCashSessionInput)
    .use(requiresPermission({ code: 'cash.session.open', at: 'input' }))
    .mutation(async ({ ctx, input }) => {
      assertLocationInScope(ctx.identity, input.locationId);
      const tenantId = ctx.identity.tenantId;
      const key = input.idempotencyKey;
      // Whose drawer. The device comes from the TOKEN, never the payload.
      const deviceId = input.drawer === 'DEVICE' ? ctx.identity.deviceId : null;

      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'cash_session.open',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: input.locationId,
        },
        input,
        async (tx) => {
          const clock = await locationClock(tx, input.locationId);
          if (clock.kind !== 'OUTLET') {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'a till opens at an OUTLET location' });
          }

          // ── class #17: has this till already been claimed for this day? ──
          const prior = await tx.query<{ id: string; opened_by: string; opened_at: string; device_id: string | null }>(
            `select id, opened_by, opened_at::text, device_id
               from app.cash_session
              where location_id = $1 and till_key = $2::uuid and business_date = $3::date
                and contested_session_id is null`,
            [input.locationId, deviceId ?? NIL_UUID, input.businessDate],
          );
          const firstClaim = prior.rows[0] ?? null;

          const period = await periodStatus(tx, input.businessDate);
          const aheadDays = dayDiff(input.businessDate, clock.server_date);
          const futureDated = aheadDays > CASH_SESSION_DATE_TOLERANCE_DAYS;
          const intoClosedPeriod = period === 'closed' || period === 'locked';

          const reviews: string[] = [];
          if (firstClaim) reviews.push(TILL_CLAIMED_TWICE_CLASS);
          if (futureDated) reviews.push(TILL_DATE_DIVERGENCE_CLASS);
          if (intoClosedPeriod) reviews.push(TILL_PERIOD_CLOSED_CLASS);

          const response = {
            cashSessionId: key,
            locationId: input.locationId,
            businessDate: input.businessDate,
            serverDate: clock.server_date,
            drawer: input.drawer,
            openedOffline: input.openedOffline,
            openingFloatMinor: wire(input.openingFloatMinor),
            status: 'OPEN',
            /** Set when this open landed as the second claim on its till (class #17). */
            contestedSessionId: firstClaim?.id ?? null,
            reviews,
          } satisfies JsonValue & Record<string, unknown>;

          return {
            response,
            apply: async (atx) => {
              const hlc = ctx.deps.clock.next();
              await atx.query(
                `insert into app.cash_session
                   (tenant_id, id, write_id, hlc, location_id, device_id, business_date,
                    server_date_at_open, opened_by, opened_at, opened_offline,
                    opening_float_minor, contested_session_id)
                 values ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13)`,
                [
                  tenantId, key, key, hlc, input.locationId, deviceId, input.businessDate,
                  clock.server_date, ctx.identity.userId, input.openedAt, input.openedOffline,
                  wire(input.openingFloatMinor), firstClaim?.id ?? null,
                ],
              );

              const common = {
                tenantId,
                writeId: key,
                severity: SEVERITY_REVIEW,
                entityTable: 'app.cash_session',
                entityId: key,
                requiredPermission: SEQUENCE_REVIEW_PERMISSION,
                locationIds: [input.locationId],
              };
              if (firstClaim) {
                await openConflictReview(atx, {
                  ...common,
                  hlc: ctx.deps.clock.next(),
                  reviewId: deterministicUuid(key, 'conflict_review', 'till_claimed_twice'),
                  conflictClass: TILL_CLAIMED_TWICE_CLASS,
                  fieldPath: 'till',
                  proposals: [
                    {
                      party: 'first',
                      detail: 'the session that claimed this till for this day first',
                      cashSessionId: firstClaim.id,
                      openedBy: firstClaim.opened_by,
                      openedAt: firstClaim.opened_at,
                      deviceId: firstClaim.device_id,
                    },
                    {
                      party: 'arriving',
                      detail: 'a second claim on the same till and day, landed contested',
                      cashSessionId: key,
                      openedBy: ctx.identity.userId,
                      deviceId: ctx.identity.deviceId,
                      openedAt: input.openedAt,
                      openedOffline: input.openedOffline,
                      openingFloatMinor: wire(input.openingFloatMinor),
                    },
                  ],
                  pendingState: 'first_applied',
                  pendingValue: {
                    note:
                      'Two sessions are open on one till for one day, so neither count will reconcile ' +
                      'on its own. Both recorded every sale rung into them. Decide which drawer is which ' +
                      'before either is closed.',
                    businessDate: input.businessDate,
                  },
                });
              }
              if (futureDated) {
                await openConflictReview(atx, {
                  ...common,
                  hlc: ctx.deps.clock.next(),
                  reviewId: deterministicUuid(key, 'conflict_review', 'till_date_divergence'),
                  conflictClass: TILL_DATE_DIVERGENCE_CLASS,
                  fieldPath: 'business_date',
                  proposals: [
                    { party: 'device', detail: 'the trading day the till was opened for', businessDate: input.businessDate },
                    { party: 'server', detail: 'the server’s own date at the location when it landed', serverDate: clock.server_date },
                  ],
                  pendingState: 'first_applied',
                  pendingValue: {
                    note:
                      'This till is dated ahead of the server. Its sales are taxed and posted on that ' +
                      'date. Correcting a business date after the fact is restating a VAT period — ' +
                      'decide it here, not on the device (08 §8.2a).',
                    aheadDays: String(aheadDays),
                  },
                });
              }
              if (intoClosedPeriod) {
                await openConflictReview(atx, {
                  ...common,
                  hlc: ctx.deps.clock.next(),
                  reviewId: deterministicUuid(key, 'conflict_review', 'till_period_closed'),
                  conflictClass: TILL_PERIOD_CLOSED_CLASS,
                  fieldPath: 'business_date',
                  proposals: [
                    { party: 'device', detail: 'the trading day the till was opened for', businessDate: input.businessDate },
                  ],
                  pendingState: 'first_applied',
                  pendingValue: {
                    note:
                      `The accounting period covering ${input.businessDate} is ${String(period)}. The ` +
                      'sales rung into this till are recorded and will post as late documents.',
                  },
                });
              }
            },
          };
        },
      );
      return result.response;
    }),

  close: tenantProcedure
    .input(closeCashSessionInput)
    .use(requiresPermission({ code: 'cash.session.close', at: 'input' }))
    .mutation(async ({ ctx, input }) => {
      assertLocationInScope(ctx.identity, input.locationId);
      const key = input.idempotencyKey;

      const result = await runIdempotent(
        { runner: ctx.deps.runner, clock: ctx.deps.clock },
        ctx.identity,
        {
          op: 'cash_session.close',
          idempotencyKey: key,
          claimedHlc: input.claimedHlc,
          clientWallAt: input.clientWallAt,
          locationId: input.locationId,
        },
        input,
        async (tx) => {
          const found = await tx.query<{
            id: string;
            location_id: string;
            status: string;
            business_date: string;
            opening_float_minor: string;
          }>(
            `select id, location_id, status, business_date::text, opening_float_minor::text
               from app.cash_session where id = $1`,
            [input.cashSessionId],
          );
          const session = found.rows[0];
          if (!session) {
            // The open is queued AHEAD of this close on the same device; if it
            // has not landed, it is still in flight — retryable, never lost.
            throw new TRPCError({
              code: 'CONFLICT',
              message: `RETRY_LATER: cash session ${input.cashSessionId} is not recorded yet`,
            });
          }
          if (session.location_id !== input.locationId) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'this till is at a different location' });
          }
          if (session.status !== 'OPEN') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `this till is already ${session.status}; a session is closed once`,
            });
          }

          // EXPECTED CASH, computed HERE from what the server recorded — the
          // float plus every drawer-cash tender rung into this session, LESS
          // every drawer-cash refund paid out of it (voids and returns,
          // migration 0030). The device's figure is a claim kept beside it,
          // never the source.
          const cash = await tx.query<{ cash_minor: string; refunded_minor: string }>(
            `select
               (select coalesce(sum(st.amount_minor), 0)::bigint
                  from app.sale s
                  join app.sale_tender st on st.tenant_id = s.tenant_id and st.sale_id = s.id
                  join app.tender_method m on m.tenant_id = st.tenant_id and m.id = st.method_id
                 where s.cash_session_id = $1 and m.is_cash)::text as cash_minor,
               (select coalesce(sum(rf.amount_minor), 0)::bigint
                  from app.sale_return r
                  join app.sale_return_refund rf on rf.tenant_id = r.tenant_id and rf.return_id = r.id
                  join app.tender_method m on m.tenant_id = rf.tenant_id and m.id = rf.method_id
                 where r.cash_session_id = $1 and m.is_cash)::text as refunded_minor`,
            [session.id],
          );
          const expected =
            BigInt(session.opening_float_minor) +
            BigInt(cash.rows[0]!.cash_minor) -
            BigInt(cash.rows[0]!.refunded_minor);
          const counted = input.countedMinor ?? null;
          const variance = counted === null ? null : counted - expected;
          const banked = input.bankedMinor ?? null;
          const clientExpected = input.clientExpectedMinor ?? null;

          const response = {
            cashSessionId: session.id,
            status: 'CLOSED',
            businessDate: session.business_date,
            autoClosed: input.autoClosed,
            openingFloatMinor: session.opening_float_minor,
            expectedCashMinor: wire(expected),
            countedMinor: counted === null ? null : wire(counted),
            varianceMinor: variance === null ? null : wire(variance),
            bankedMinor: banked === null ? null : wire(banked),
            clientExpectedMinor: clientExpected === null ? null : wire(clientExpected),
            /** Null when the device stated none. False is worth a look: see the close report. */
            expectedMatchesDevice: clientExpected === null ? null : clientExpected === expected,
          } satisfies JsonValue & Record<string, unknown>;

          return {
            response,
            apply: async (atx) => {
              const updated = await atx.query<{ id: string }>(
                `update app.cash_session
                    set status = 'CLOSED', closed_by = $2, closed_at = $3, auto_closed = $4,
                        counted_minor = $5, banked_minor = $6, expected_cash_minor = $7,
                        variance_minor = $8, client_expected_minor = $9, close_write_id = $10,
                        hlc = $11, updated_at = transaction_timestamp()
                  where id = $1 and status = 'OPEN'
                  returning id`,
                [
                  session.id, ctx.identity.userId, input.closedAt, input.autoClosed,
                  counted === null ? null : wire(counted),
                  banked === null ? null : wire(banked),
                  wire(expected),
                  variance === null ? null : wire(variance),
                  clientExpected === null ? null : wire(clientExpected),
                  key, ctx.deps.clock.next(),
                ],
              );
              if (updated.rows.length === 0) {
                // A concurrent close won between the read and here.
                throw new TRPCError({ code: 'BAD_REQUEST', message: 'this till was closed by another write' });
              }
            },
          };
        },
      );
      return result.response;
    }),
});
