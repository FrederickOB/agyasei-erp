/**
 * The PWA's half of OIDC sign-in: authorization code + PKCE (S256), as a
 * PUBLIC client, against whichever provider the platform was configured with
 * (ADR-0003 A4). The server publishes the endpoints at GET /auth/config, so
 * nothing about the provider is baked into this build.
 *
 * The nonce is `${deviceJkt}.${random}`: the server checks the prefix against
 * the key that signs the DPoP proof on /auth/session, which binds the id_token
 * to THIS device. An id_token lifted from one tablet signs nobody in on another.
 *
 * Nothing from the id_token is trusted HERE — it is forwarded to our API,
 * which verifies it against the IdP's keys. The PWA reads no claim from it.
 */
import { authConfigResponse, type AuthConfigResponse } from '@erp/contracts';
import { randomB64url, sha256B64url } from './webcrypto';

export interface PendingSignIn {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly createdAtMs: number;
}

export type OidcConfig = NonNullable<AuthConfigResponse['oidc']>;

export async function fetchAuthConfig(apiUrl: string, fetchFn: typeof fetch = fetch): Promise<OidcConfig | null> {
  const res = await fetchFn(`${apiUrl}/auth/config`);
  if (!res.ok) throw new Error(`sign-in configuration unavailable (${res.status})`);
  const parsed = authConfigResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error('sign-in configuration is not in the expected shape');
  return parsed.data.oidc;
}

/** Build the authorize URL and the record the callback must match. */
export async function prepareSignIn(
  config: OidcConfig,
  deviceJkt: string,
  redirectUri: string,
  nowMs: number = Date.now(),
): Promise<{ url: string; pending: PendingSignIn }> {
  const verifier = randomB64url(32);
  const challenge = await sha256B64url(verifier);
  const state = randomB64url(16);
  const nonce = `${deviceJkt}.${randomB64url(16)}`;
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // A shared counter tablet: never silently reuse the previous clerk's IdP
  // session. Every sign-in is the person standing here.
  url.searchParams.set('prompt', 'login');
  return {
    url: url.toString(),
    pending: {
      state,
      nonce,
      verifier,
      redirectUri,
      tokenEndpoint: config.tokenEndpoint,
      clientId: config.clientId,
      createdAtMs: nowMs,
    },
  };
}

/** A pending sign-in older than this is refused: the IdP round trip is minutes, not hours. */
export const PENDING_SIGN_IN_TTL_MS = 10 * 60 * 1000;

/** Exchange the code at the IdP's token endpoint. Returns the id_token. */
export async function exchangeCode(
  callbackUrl: string,
  pending: PendingSignIn,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<string> {
  const cb = new URL(callbackUrl);
  const error = cb.searchParams.get('error');
  if (error) throw new Error(`the sign-in provider refused: ${error}`);
  if (cb.searchParams.get('state') !== pending.state) {
    // A callback this tab did not start — CSRF or a stale tab. Refused.
    throw new Error('this sign-in was not started on this device');
  }
  if (nowMs - pending.createdAtMs > PENDING_SIGN_IN_TTL_MS) throw new Error('the sign-in took too long — start again');
  const code = cb.searchParams.get('code');
  if (!code) throw new Error('the sign-in provider returned no code');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  const res = await fetchFn(pending.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`the sign-in provider would not issue a token (${res.status})`);
  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== 'string') throw new Error('the sign-in provider returned no id_token');
  return json.id_token;
}
