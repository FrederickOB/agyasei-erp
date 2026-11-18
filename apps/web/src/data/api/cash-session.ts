/**
 * The ONLINE half of opening a till (08 §8.2a): before the open is queued,
 * ask the server for its own date at this location and the state of the
 * accounting period covering the proposed day.
 *
 * A READ, not a write: the open itself rides the outbox
 * (`data/mutations/till.ts`), so a till opens with the radio off. What this
 * buys is the refusal that only a server can give — "the server's date here is
 * 2027-01-04; this tablet says 2027-01-07" — while the person is standing at
 * the counter. When it cannot be asked (offline, timed out, not configured)
 * the counter opens anyway and the till is FLAGGED `openedOffline`, which is
 * what §8.2a requires rather than a fallback it tolerates.
 */
import {
  cashSessionOpenCheckInput,
  type CashSessionOpenCheck,
  type CashSessionOpenCheckInput,
} from '@erp/contracts';
import {
  apiQuery,
  asRecord,
  asString,
  type ApiCallOptions,
  type ApiResult,
} from './client';
import { guard } from './guard';

function mapOpenCheck(json: unknown): CashSessionOpenCheck {
  const r = asRecord(json, 'cashSession.openCheck');
  const status = r['periodStatus'];
  const periodStatus =
    status === 'open' || status === 'closed' || status === 'locked' ? status : null;
  const tolerance = r['toleranceDays'];
  if (typeof tolerance !== 'number' || !Number.isInteger(tolerance)) {
    throw new Error('cashSession.openCheck: toleranceDays is not an integer');
  }
  const refusal = r['refusal'];
  return {
    serverDate: asString(r['serverDate'], 'cashSession.openCheck.serverDate'),
    // A COUNT of days, not a magnitude — `number` is right here (ADR-0004
    // governs money and quantities).
    toleranceDays: tolerance,
    periodStatus,
    refusal: typeof refusal === 'string' ? refusal : null,
  };
}

export function fetchOpenCheck(
  input: CashSessionOpenCheckInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<CashSessionOpenCheck>> {
  const refused = guard(cashSessionOpenCheckInput, 'cashSession.openCheck', input);
  if (refused !== null) return Promise.resolve(refused);
  return apiQuery('cashSession.openCheck', input, mapOpenCheck, options);
}

/**
 * Whether a failed check means "the server could not be asked" — open
 * offline, flagged — rather than "the server said no". Only the first is a
 * reason to proceed: a till must open when the tower is down, the sign-in has
 * lapsed or the server is broken, because the outlet trades regardless; it
 * must NOT open when the server answered that this person may not open it
 * here.
 */
export function couldNotAsk(result: ApiResult<CashSessionOpenCheck>): boolean {
  if (result.ok) return false;
  switch (result.failure.kind) {
    case 'offline':
    case 'timeout':
    case 'not-configured':
    case 'server-error':
    case 'unauthenticated':
    case 'malformed':
      return true;
    case 'forbidden':
    case 'refused':
    case 'invalid-request':
      return false;
  }
}
