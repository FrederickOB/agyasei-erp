/**
 * PowerSync credential exchange (03-offline-sync §3.1.7; infra/README "Auth
 * contract").
 *
 * `fetchCredentials` calls `GET {apiUrl}/sync/token` with the device's API
 * bearer token. The API mints a SHORT-LIVED PowerSync client token — HS256
 * with the one dev secret, `aud: "powersync"`, `tid` from the VERIFIED
 * session. Nothing the client sends can influence `tid`: the tenant boundary
 * lives in the token and the sync rules, never in client parameters
 * (CLAUDE.md §2.1; infra/powersync/sync_rules.yaml).
 *
 * The token is cached until NEAR expiry (not until expiry: a token that dies
 * mid-handshake on a slow connection is a reconnect loop), so a flapping
 * radio does not hammer the token endpoint. A fetch failure throws — the
 * PowerSync client retries with its own backoff, and the counter keeps
 * trading locally in the meantime; credentials are never invented.
 *
 * No `@powersync/web` import here: this module is plain logic so the unit
 * tests can exercise it with a mocked fetch (no live service).
 */
import { syncTokenResponse } from '@erp/contracts';

export interface FetchedSyncToken {
  /** The PowerSync client JWT (opaque to us). */
  readonly token: string;
  /** Absolute expiry from the API's `expires_at`, in epoch ms. */
  readonly expiresAtMs: number;
  /** The sync service endpoint the client connects to (VITE_POWERSYNC_URL). */
  readonly endpoint: string;
}

/** The slice of the Fetch API the cache needs — mockable in unit tests. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
export interface FetchInitLike {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}
export type FetchLike = (url: string, init: FetchInitLike) => Promise<HttpResponseLike>;

export interface CredentialCacheOptions {
  /** API dev server base URL (VITE_API_URL), e.g. http://localhost:3001. */
  readonly apiUrl: string;
  /** Bearer for the API. Dev-only static token; real exchange is the online login flow (§8.2). */
  readonly apiToken: string;
  /** PowerSync service URL (VITE_POWERSYNC_URL) — configuration is authoritative for the endpoint. */
  readonly powersyncUrl: string;
  readonly fetchFn?: FetchLike;
  readonly nowMs?: () => number;
  /**
   * Refresh once this close to expiry. Tokens are short-lived (~5 min per the
   * infra contract), so the default 60s renews at ~80% of lifetime.
   */
  readonly refreshSkewMs?: number;
}

export class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TokenEndpointError';
  }
}

const DEFAULT_REFRESH_SKEW_MS = 60_000;

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export class CredentialCache {
  private cached: FetchedSyncToken | null = null;
  private inflight: Promise<FetchedSyncToken> | null = null;

  constructor(private readonly opts: CredentialCacheOptions) {}

  /** Cached token while comfortably valid; a single deduplicated fetch otherwise. */
  async get(): Promise<FetchedSyncToken> {
    const now = (this.opts.nowMs ?? Date.now)();
    const skew = this.opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    if (this.cached !== null && now < this.cached.expiresAtMs - skew) {
      return this.cached;
    }
    if (this.inflight === null) {
      this.inflight = this.fetchFresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Drop the cache (e.g. after the service rejects the token). */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchFresh(): Promise<FetchedSyncToken> {
    const fetchFn: FetchLike =
      this.opts.fetchFn ?? ((url, init) => fetch(url, init) as Promise<HttpResponseLike>);
    const url = `${trimTrailingSlash(this.opts.apiUrl)}/sync/token`;
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.opts.apiToken}` },
    });
    if (!res.ok) {
      throw new TokenEndpointError(res.status, `token endpoint answered ${res.status}`);
    }
    const body: unknown = await res.json();
    // PARSED WITH THE CONTRACT, not with hand-rolled key extraction. The three
    // keys used to be picked out of an `unknown` here and assembled by hand in
    // `apps/api/src/sync.ts`, with no shared declaration between them — the
    // same two-sides-one-shape gap that made every sale a BAD_REQUEST, in the
    // download direction. A rename on the server is now a compile error there
    // and a named parse failure here.
    const parsed = syncTokenResponse.safeParse(body);
    if (!parsed.success) {
      throw new TokenEndpointError(
        res.status,
        `token endpoint body does not match the contract: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const { token, expires_at: expiresAt } = parsed.data;
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      throw new TokenEndpointError(res.status, `unparseable expires_at: ${expiresAt}`);
    }
    // The CONFIGURED service URL is authoritative for where the client
    // connects; the response's `endpoint` field is advisory only.
    const fresh: FetchedSyncToken = {
      token,
      expiresAtMs,
      endpoint: trimTrailingSlash(this.opts.powersyncUrl),
    };
    this.cached = fresh;
    return fresh;
  }
}
