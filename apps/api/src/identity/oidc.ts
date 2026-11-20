/**
 * The platform as an OIDC RELYING PARTY, and nothing more (02 §2.2, ADR-0003
 * amendment A4). Provider-generic: Zitadel, Auth0 EU, Keycloak — chosen at
 * provisioning, configured here by issuer + client id.
 *
 * The flow, end to end:
 *   1. The PWA runs authorization code + PKCE against the IdP as a PUBLIC
 *      client, with nonce = `${device jkt}.${random}`.
 *   2. It sends the IdP's id_token, the nonce, and a DPoP proof from its
 *      enrolled key to `POST /auth/session`.
 *   3. This module verifies the id_token: signature via the IdP's JWKS (alg
 *      pinned, never HS* or none), exact `iss`, `aud` contains our client id,
 *      `azp` is ours when there are several audiences, exp/iat, and the nonce.
 *   4. The CALLER binds the nonce to the PROVEN device key (the jkt prefix
 *      must equal the DPoP thumbprint), so an id_token lifted from one tablet
 *      cannot sign anyone in on another.
 *
 * WHAT IS NEVER READ FROM THE ID TOKEN: a tenant, an org, a role, a group,
 * an email used as identity. A tenant administrator can edit IdP-side claims;
 * only `iss` + `sub` are used, and they are mapped to OUR user record — whose
 * tenant_id is the only tenant this login can ever have (CLAUDE.md §2.1).
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface OidcConfig {
  /** Exact issuer string the IdP puts in `iss`. */
  readonly issuer: string;
  /** Our client id at the IdP — the id_token's audience. */
  readonly clientId: string;
  /** Accepted id_token algorithms. Asymmetric only; HS* and none are refused at config. */
  readonly algorithms: readonly string[];
  /** Override for the JWKS URI (otherwise from discovery). */
  readonly jwksUri?: string | undefined;
  /** Scope requested by the PWA. */
  readonly scope?: string | undefined;
}

export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly endSessionEndpoint?: string | undefined;
}

export class IdTokenRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdTokenRejected';
  }
}

/** §2.2: the IdP must offer EdDSA or ES256; RS256 is accepted only if configured. */
export const DEFAULT_ID_TOKEN_ALGS = ['ES256', 'EdDSA'] as const;

export function assertAsymmetricAlgs(algs: readonly string[]): void {
  if (algs.length === 0) throw new Error('OIDC: at least one id_token algorithm is required');
  for (const a of algs) {
    if (a === 'none' || /^HS/i.test(a)) {
      throw new Error(`OIDC: id_token algorithm ${a} is refused — symmetric or unsigned`);
    }
  }
}

/** A freshly-issued id_token only: sign-in is interactive, so an old one is a replay. */
export const ID_TOKEN_MAX_AGE_S = 10 * 60;

export interface VerifiedSubject {
  readonly issuer: string;
  readonly subject: string;
  readonly nonce: string;
}

export interface IdTokenVerifier {
  verify(idToken: string, expectedNonce: string, nowS?: number): Promise<VerifiedSubject>;
  discovery(): Promise<OidcDiscovery>;
}

export async function discover(issuer: string, fetchFn: typeof fetch = fetch): Promise<OidcDiscovery> {
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const res = await fetchFn(`${base}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  if (doc['issuer'] !== issuer) {
    // A discovery document for a DIFFERENT issuer is a mis-configuration or
    // an attack; either way the id_tokens it describes are not ours to trust.
    throw new Error(`OIDC discovery: issuer mismatch (${String(doc['issuer'])} ≠ ${issuer})`);
  }
  const str = (k: string): string => {
    const v = doc[k];
    if (typeof v !== 'string' || v.length === 0) throw new Error(`OIDC discovery: ${k} missing`);
    return v;
  };
  const end = doc['end_session_endpoint'];
  return {
    issuer,
    authorizationEndpoint: str('authorization_endpoint'),
    tokenEndpoint: str('token_endpoint'),
    jwksUri: str('jwks_uri'),
    endSessionEndpoint: typeof end === 'string' ? end : undefined,
  };
}

export function createIdTokenVerifier(
  config: OidcConfig,
  opts: {
    /** Inject the key source (tests, the dev IdP). Default: remote JWKS from discovery. */
    keys?: JWTVerifyGetKey;
    /** Inject discovery (tests). Default: fetch it once, lazily. */
    discovery?: OidcDiscovery;
    fetchFn?: typeof fetch;
  } = {},
): IdTokenVerifier {
  assertAsymmetricAlgs(config.algorithms);
  let disco: Promise<OidcDiscovery> | null = opts.discovery ? Promise.resolve(opts.discovery) : null;
  let keys: JWTVerifyGetKey | null = opts.keys ?? null;

  const getDiscovery = (): Promise<OidcDiscovery> => {
    if (!disco) {
      disco = discover(config.issuer, opts.fetchFn).catch((err: unknown) => {
        disco = null; // retry next time; never cache a failure
        throw err;
      });
    }
    return disco;
  };

  const getKeys = async (): Promise<JWTVerifyGetKey> => {
    if (keys) return keys;
    const uri = config.jwksUri ?? (await getDiscovery()).jwksUri;
    // createRemoteJWKSet refetches on an unknown kid, rate-limited by its
    // cooldown — §2.2's "one refetch, then fail".
    keys = createRemoteJWKSet(new URL(uri), { cooldownDuration: 60_000 });
    return keys;
  };

  return {
    discovery: getDiscovery,
    async verify(idToken, expectedNonce, nowS) {
      const now = nowS ?? Math.floor(Date.now() / 1000);
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(idToken, await getKeys(), {
          algorithms: [...config.algorithms],
          issuer: config.issuer,
          audience: config.clientId,
          clockTolerance: 60,
          currentDate: new Date(now * 1000),
        });
        payload = verified.payload as Record<string, unknown>;
      } catch (err) {
        throw new IdTokenRejected(`id_token refused: ${err instanceof Error ? err.message : String(err)}`);
      }
      const aud = payload['aud'];
      if (Array.isArray(aud) && aud.length > 1 && payload['azp'] !== config.clientId) {
        throw new IdTokenRejected('id_token refused: several audiences and azp is not this client');
      }
      const iat = payload['iat'];
      if (typeof iat !== 'number' || iat > now + 60 || now - iat > ID_TOKEN_MAX_AGE_S) {
        throw new IdTokenRejected('id_token refused: not freshly issued');
      }
      const sub = payload['sub'];
      if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255) {
        throw new IdTokenRejected('id_token refused: no usable sub');
      }
      if (typeof payload['nonce'] !== 'string' || payload['nonce'] !== expectedNonce) {
        throw new IdTokenRejected('id_token refused: nonce does not match this sign-in');
      }
      return { issuer: config.issuer, subject: sub, nonce: expectedNonce };
    },
  };
}
