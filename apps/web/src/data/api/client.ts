/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE PLACE THE CLIENT TALKS TO THE API OVER HTTP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read this before adding a screen that needs server data. It is short on
 * purpose, and the next screen should not need a second copy of any of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL, IN AN OFFLINE-FIRST PRODUCT
 * ---------------------------------------------------------------------------
 * Almost everything the counter reads is a live query against local SQLite
 * (§8.2): no fetch, no cache layer, no `isLoading`. This module is for the
 * handful of things that genuinely are NOT on the device:
 *
 *   · reporting (`reports.*`) — it aggregates locations this device does not
 *     hold and, by Q-C, is deliberately not synced to a counter tablet;
 *   · the low-stock alert and reorder thresholds — `app.reorder_point` is in
 *     NO sync bucket, so a partitioned device cannot know them;
 *   · the caller's own capability list (`session.permissions`), which is
 *     resolved from the database per request and never read from a token.
 *
 * A device that cannot reach the server therefore cannot answer those
 * questions, and the ONLY correct thing to do is say so. Every failure below
 * is modelled so a screen can say which kind of "no" it got, in words a
 * person at a counter can act on. There is no silent empty list and no
 * last-known figure dressed up as a current one: a wrong balance shown
 * confidently at a counter is worse than no balance.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS TYPED, AND WHAT THAT BUYS
 * ---------------------------------------------------------------------------
 * Request payloads are the shared `@erp/contracts` schemas — the same
 * declarations `apps/api` parses. Callers validate against them BEFORE the
 * request leaves the device (`data/api/reports.ts`, `data/api/inventory.ts`),
 * exactly as `data/sync/transport.ts` proves an upload envelope. A shape
 * disagreement is a `tsc` error, and a malformed request is caught here
 * rather than as a BAD_REQUEST somebody discovers in a district town.
 *
 * RESPONSES are NOT in the contract package, and this file does not pretend
 * otherwise. `apps/web` may not import `apps/api` (only
 * `packages/wire-conformance` may import both trees), so each caller declares
 * the response shape it reads and MAPS it — every money and quantity field
 * through `deserializeMoney` / `BigInt`, never `Number`. A response the
 * mapper cannot read is `malformed`, which is loud, rather than `undefined`
 * flowing into a total. That asymmetry is a real gap and is stated here so
 * the next person does not assume the return type is enforced end to end.
 *
 * ---------------------------------------------------------------------------
 * TRANSPORT DETAIL
 * ---------------------------------------------------------------------------
 * tRPC v11 over HTTP with the superjson transformer (`apps/api/src/trpc.ts`):
 * queries are `GET {base}/trpc/{path}?input={"json":…}`, mutations are
 * `POST {base}/trpc/{path}` with body `{"json":…}`, and a success comes back
 * as `{result:{data:{json:…}}}`. Nothing in a report payload is a type
 * superjson has to annotate — money and quantities cross as decimal strings
 * (ADR-0004), dates as `YYYY-MM-DD` — so there is no `meta` to apply, and a
 * response that carries one is treated as unreadable rather than guessed at.
 *
 * NOTHING HERE NAMES A TENANT. `tenant_id` comes from the verified token,
 * server-side, on every request (CLAUDE.md §2.1).
 */
import type { MinorUnits } from '@erp/money';
import { deserializeMoney } from '@erp/money';
import { authMode, deviceAuth } from '../auth/runtime';

// ---------------------------------------------------------------------------
// The transport seam — small on purpose, so a test can drive it
// ---------------------------------------------------------------------------

export interface ApiResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface ApiFetchInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export type ApiFetch = (url: string, init: ApiFetchInit) => Promise<ApiResponseLike>;

// ---------------------------------------------------------------------------
// Failure taxonomy — every "no" a screen may have to explain
// ---------------------------------------------------------------------------

export type ApiFailureKind =
  /** This build has no API configured at all — the local-only rehearsal (§8.1). */
  | 'not-configured'
  /** The request never reached a server. The expected condition, not an error. */
  | 'offline'
  /** It may have reached one; nothing came back in time. */
  | 'timeout'
  /** 401 — this device's session is not valid any more. */
  | 'unauthenticated'
  /** 403 — the session is fine; this caller does not hold the capability. */
  | 'forbidden'
  /** Another 4xx — the server understood the request and refused it. */
  | 'refused'
  /** 5xx — the server broke. Not the caller's fault and not the radio's. */
  | 'server-error'
  /** 200 with a body this client cannot read. Loud, never coerced to empty. */
  | 'malformed'
  /**
   * The request failed the SHARED contract before it left the device. Caught
   * here rather than as a BAD_REQUEST discovered in a district town — the
   * same discipline `data/sync/transport.ts` applies to an upload envelope.
   */
  | 'invalid-request';

export interface ApiFailure {
  readonly kind: ApiFailureKind;
  /** One sentence, in the words a person at a counter can act on. */
  readonly message: string;
  /** The server's own words, for whoever gets called. Never the headline. */
  readonly detail: string | null;
  readonly status: number | null;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T; readonly fetchedAtMs: number }
  | { readonly ok: false; readonly failure: ApiFailure };

function failure(
  kind: ApiFailureKind,
  message: string,
  detail: string | null,
  status: number | null,
): ApiResult<never> {
  return { ok: false, failure: { kind, message, detail, status } };
}

/**
 * The message a SCREEN leads with. Deliberately not the server's sentence:
 * "PERMISSION_DENIED: report.view.margin is not held by this user" is the
 * right thing to show the person who gets called, and the wrong thing to put
 * in front of somebody with a queue in front of them.
 */
const HEADLINES: Readonly<Record<ApiFailureKind, string>> = {
  'not-configured': 'This device is set up to work on its own and has no server to ask.',
  offline: 'Not available offline.',
  timeout: 'The server did not answer in time.',
  unauthenticated: 'This device needs to sign in again before it can ask the server.',
  forbidden: 'This is not part of what you are allowed to see.',
  refused: 'The server would not answer this request.',
  'server-error': 'The server could not answer this request.',
  malformed: 'The server sent back something this device could not read.',
  'invalid-request': 'This device could not put together a request the server would accept.',
};

export function headlineFor(kind: ApiFailureKind): string {
  return HEADLINES[kind];
}

/**
 * A request this device refused to send, because it does not satisfy the
 * shared `@erp/contracts` declaration the API parses against.
 *
 * Returned as a normal failure so a screen handles it through the same switch
 * as every other "no" — there is no separate throw path for a caller to
 * forget about.
 */
export function invalidRequest(what: string, issues: readonly string[]): ApiResult<never> {
  return failure(
    'invalid-request',
    HEADLINES['invalid-request'],
    `${what}: ${issues.join('; ')}`,
    null,
  );
}

// ---------------------------------------------------------------------------
// Where the API is
// ---------------------------------------------------------------------------

export interface ApiEndpoint {
  /** Base URL with no trailing slash. */
  readonly url: string;
  /** DEV ONLY static bearer (`VITE_API_TOKEN`). Empty on the device path. */
  readonly bearer: string;
  /**
   * THE DEVICE PATH: headers for one request — the DPoP-bound access token and
   * a fresh proof from the enrolled key (data/auth/device-auth.ts). Throws when
   * nobody is signed in, which this module reports as `unauthenticated`.
   */
  readonly authorize?: (method: string, url: string) => Promise<Record<string, string>>;
  /** Told about a `423 device_revoked`, so the device can drain then wipe. */
  readonly onRevoked?: (body: Record<string, unknown>) => Promise<void>;
}

/**
 * The API this build talks to, or `null` for a device with no server at all.
 *
 * Read from the environment directly rather than through `data/powersync.ts`,
 * which is the module that pulls in the PowerSync web SDK (wasm + workers).
 * A reporting screen must not drag that into its import graph; the two env
 * reads agree because they read the same two variables, and `env.example`
 * is the single description of them.
 *
 * `VITE_API_TOKEN` is the DEV bearer. Real credential exchange is the online
 * login flow (§8.2), and when it lands this is the one function that changes.
 */
export function readApiEndpoint(): ApiEndpoint | null {
  const url = import.meta.env.VITE_API_URL;
  if (typeof url !== 'string' || url.length === 0) return null;
  const base = url.endsWith('/') ? url.slice(0, -1) : url;
  if (authMode() === 'device') {
    const auth = deviceAuth();
    if (auth === null) return null;
    return {
      url: base,
      bearer: '',
      authorize: (method, target) => auth.authorize(method, target),
      onRevoked: (body) => auth.markRevoked(body),
    };
  }
  // DEV ONLY: the static bearer from `pnpm dev:token`.
  const bearer = import.meta.env.VITE_API_TOKEN;
  if (typeof bearer !== 'string' || bearer.length === 0) return null;
  return { url: base, bearer };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Default ceiling on a single request. Long enough that a slow rural link
 * still completes — and that an API waking from its free-tier sleep (≈30 s
 * to first answer, measured 25 Nov 2026) answers the request that woke it
 * instead of the screen giving up at 15 s and showing a failure for a server
 * that was about to reply. The screen is not silent meanwhile: past a couple
 * of seconds it says it is still waiting (use-api-query's `slow`). A device
 * with no network fails at once, not at this ceiling.
 */
export const DEFAULT_TIMEOUT_MS = 45_000;

export interface ApiCallOptions {
  readonly endpoint?: ApiEndpoint | null;
  readonly fetchFn?: ApiFetch;
  readonly timeoutMs?: number;
  readonly nowMs?: () => number;
}

/** The `{result:{data:{json}}}` payload of a successful tRPC call. */
function successPayload(body: unknown): { ok: true; json: unknown } | { ok: false; why: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, why: 'response is not an object' };
  const result = (body as Record<string, unknown>)['result'];
  if (typeof result !== 'object' || result === null) return { ok: false, why: 'response has no result' };
  const data = (result as Record<string, unknown>)['data'];
  if (typeof data !== 'object' || data === null) return { ok: false, why: 'response has no data' };
  const record = data as Record<string, unknown>;
  if (!('json' in record)) return { ok: false, why: 'response is not in the expected envelope' };
  if ('meta' in record) {
    // superjson only emits `meta` for types plain JSON cannot carry. Nothing
    // in a report payload is one, so a `meta` here means the server started
    // sending a shape this client was never written to decode. Refusing beats
    // silently dropping the annotation and rendering the raw value.
    return { ok: false, why: 'response carries an encoding this device cannot apply' };
  }
  return { ok: true, json: record['json'] };
}

/** The `{error:{json:{message,data:{code}}}}` payload of a failed tRPC call. */
function errorPayload(body: unknown): { message: string | null; code: string | null } {
  const err = (body as { error?: { json?: { message?: unknown; data?: { code?: unknown } } } })
    ?.error?.json;
  return {
    message: typeof err?.message === 'string' ? err.message : null,
    code: typeof err?.data?.code === 'string' ? err.data.code : null,
  };
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  input: unknown,
  map: (json: unknown) => T,
  options: ApiCallOptions,
): Promise<ApiResult<T>> {
  const endpoint = options.endpoint === undefined ? readApiEndpoint() : options.endpoint;
  if (endpoint === null) {
    return failure(
      'not-configured',
      HEADLINES['not-configured'],
      'No API URL is configured in this build (VITE_API_URL / VITE_API_TOKEN).',
      null,
    );
  }

  const now = options.nowMs ?? Date.now;
  const fetchFn: ApiFetch =
    options.fetchFn ?? ((url, init) => fetch(url, init as RequestInit) as Promise<ApiResponseLike>);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // A slow link is not the same failure as a dead one, and a request that
  // hangs forever is the worst of the three: the screen keeps promising an
  // answer it is not going to get. AbortController is feature-detected
  // because the seam is also driven from tests and from node.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer =
    controller === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

  const serialized = JSON.stringify({ json: input });
  const url =
    method === 'GET'
      ? `${endpoint.url}/trpc/${path}?${new URLSearchParams({ input: serialized }).toString()}`
      : `${endpoint.url}/trpc/${path}`;

  let authHeaders: Record<string, string>;
  try {
    authHeaders = endpoint.authorize
      ? await endpoint.authorize(method, url)
      : { authorization: `Bearer ${endpoint.bearer}` };
  } catch (err) {
    if (timer !== null) clearTimeout(timer);
    // Nobody signed in, or the session could not be renewed (offline). Not the
    // server's answer — this device has no credential to ask with right now.
    return failure(
      'unauthenticated',
      HEADLINES.unauthenticated,
      err instanceof Error ? err.message : String(err),
      null,
    );
  }

  let res: ApiResponseLike;
  try {
    res = await fetchFn(url, {
      method,
      headers: {
        ...authHeaders,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: serialized } : {}),
      ...(controller === null ? {} : { signal: controller.signal }),
    });
  } catch {
    // fetch rejects for a dead radio, a refused connection, DNS, CORS and an
    // abort alike. The device cannot tell those apart and does not pretend to
    // — except for the one it caused itself, which it can.
    return timedOut
      ? failure('timeout', HEADLINES.timeout, `No answer within ${String(timeoutMs)}ms.`, null)
      : failure(
          'offline',
          HEADLINES.offline,
          'This device could not reach the server. Nothing is wrong with the till.',
          null,
        );
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const { message, code } = errorPayload(body);
    const detail = message ?? (code === null ? null : code);
    if (res.status === 401) {
      return failure('unauthenticated', HEADLINES.unauthenticated, detail, res.status);
    }
    if (res.status === 423 && endpoint.onRevoked && body !== null && typeof body === 'object') {
      // §2.7: the device was revoked. Recorded so the device drains its
      // outbox to review and then wipes — never the other way round.
      await endpoint.onRevoked(body as Record<string, unknown>);
      return failure('refused', 'This device has been withdrawn from service.', 'device_revoked', res.status);
    }
    if (res.status === 403) return failure('forbidden', HEADLINES.forbidden, detail, res.status);
    if (res.status >= 500) return failure('server-error', HEADLINES['server-error'], detail, res.status);
    return failure('refused', HEADLINES.refused, detail, res.status);
  }

  const payload = successPayload(body);
  if (!payload.ok) return failure('malformed', HEADLINES.malformed, payload.why, res.status);

  try {
    return { ok: true, data: map(payload.json), fetchedAtMs: now() };
  } catch (err) {
    // A mapper throws when a field it needs is missing or is not a decimal
    // string of scaled units. That is a real disagreement between this build
    // and the server, and it is reported as one rather than rendered as a
    // gap in a total.
    return failure(
      'malformed',
      HEADLINES.malformed,
      err instanceof Error ? err.message : String(err),
      res.status,
    );
  }
}

/** A tRPC QUERY. Input goes in the query string; nothing is mutated. */
export function apiQuery<T>(
  path: string,
  input: unknown,
  map: (json: unknown) => T,
  options: ApiCallOptions = {},
): Promise<ApiResult<T>> {
  return call('GET', path, input, map, options);
}

/**
 * A tRPC MUTATION.
 *
 * ═══ THIS IS NOT THE OFFLINE WRITE PATH AND MUST NOT BECOME ONE ═══
 * Sales go through the local outbox and complete on a per-key server ack
 * (`data/sync/upload.ts`); the counter never waits on a socket to record one.
 * This function is for writes that are CONFIGURATION rather than trade — a
 * reorder threshold, say — which genuinely cannot be made on a partitioned
 * device because the row they change is in no sync bucket. Such a write is
 * refused offline, out loud, and nothing is queued.
 *
 * Adding a trade write here would be a bug of the class this repository has
 * shipped nine times: it would bypass the outbox, bypass idempotent replay,
 * and bypass `outbox-surface.test.ts`, which pins the device's uploadable
 * write surface precisely so a second write path cannot appear unnoticed.
 */
export function apiMutate<T>(
  path: string,
  input: unknown,
  map: (json: unknown) => T,
  options: ApiCallOptions = {},
): Promise<ApiResult<T>> {
  return call('POST', path, input, map, options);
}

// ---------------------------------------------------------------------------
// Mapper primitives — the ONE place a wire value becomes a magnitude
// ---------------------------------------------------------------------------

export class ApiShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiShapeError';
  }
}

export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiShapeError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ApiShapeError(`${what}: expected a list`);
  return value;
}

export function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ApiShapeError(`${what}: expected text`);
  return value;
}

export function asOptionalString(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, what);
}

export function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new ApiShapeError(`${what}: expected true or false`);
  return value;
}

/**
 * A COUNT. The only place a JSON number is accepted, and only for things that
 * are counts of rows or days — never a magnitude of money, quantity or rate
 * (ADR-0004: those cross as decimal strings and become `bigint`).
 */
export function asCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiShapeError(`${what}: expected a whole number`);
  }
  return value;
}

export function asOptionalCount(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  return asCount(value, what);
}

/**
 * A SCALED INTEGER off the wire — money in minor units, a quantity at its
 * unit's scale, a ratio × 10⁴. `deserializeMoney` is the shared parser and it
 * rejects anything that is not an integer decimal string, so `'1.5'`, `'1e2'`
 * and a JSON number all throw here instead of becoming a float somewhere
 * downstream.
 */
export function asScaled(value: unknown, what: string): MinorUnits {
  if (typeof value !== 'string') {
    throw new ApiShapeError(`${what}: expected a decimal string of scaled integer units`);
  }
  try {
    return deserializeMoney(value);
  } catch (err) {
    throw new ApiShapeError(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A scaled integer that the server may withhold.
 *
 * `null` here means UNAVAILABLE and never zero — the reporting routes return
 * `null` for a figure they cannot compute honestly (an incomplete cost basis,
 * a distribution cost with no source), and collapsing that to `0` would put
 * the best-looking number in the business next to a target it never met.
 */
export function asOptionalScaled(value: unknown, what: string): MinorUnits | null {
  if (value === null || value === undefined) return null;
  return asScaled(value, what);
}
