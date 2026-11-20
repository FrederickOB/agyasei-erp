#!/usr/bin/env node
/**
 * A MINIMAL OpenID Connect provider for local development — `pnpm dev:idp`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DEV ONLY. It has no passwords: you pick who you are from a list. It exists so
 * nobody needs a real IdP account to develop or demo the sign-in flow, and so
 * the PWA's OIDC client is exercised against a real authorization-code + PKCE
 * round trip rather than a mock. Production uses a managed provider (Zitadel,
 * Auth0 EU, Keycloak) chosen at provisioning — ADR-0003 amendment A4.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What it implements, and nothing more:
 *   GET  /.well-known/openid-configuration
 *   GET  /jwks                       ES256 public key, with kid
 *   GET  /authorize                  response_type=code, PKCE S256 REQUIRED,
 *                                    nonce REQUIRED, redirect_uri allow-listed
 *   POST /token                      grant_type=authorization_code + code_verifier
 *                                    → id_token (ES256, aud = client_id, nonce)
 *
 * The users are the bootstrap's dev principals (`dev-<roleRef>` subjects,
 * linked by infra/scripts/bootstrap.ts in BOTH dev tenants — the tenant comes
 * from the enrolled device, never from here).
 *
 * Env: DEV_IDP_PORT (9400), DEV_IDP_ISSUER (http://localhost:9400),
 *      DEV_IDP_CLIENT_ID (erp-pwa-dev),
 *      DEV_IDP_REDIRECTS (comma list; default the Vite dev origins + /auth/callback)
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const PORT = Number(process.env.DEV_IDP_PORT ?? 9400);
const ISSUER = process.env.DEV_IDP_ISSUER ?? `http://localhost:${PORT}`;
const CLIENT_ID = process.env.DEV_IDP_CLIENT_ID ?? 'erp-pwa-dev';
const REDIRECTS = new Set(
  (process.env.DEV_IDP_REDIRECTS ??
    'http://localhost:5173/auth/callback,http://127.0.0.1:5173/auth/callback,http://localhost:4173/auth/callback')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const USERS = [
  { sub: 'dev-counter_staff', name: 'Counter staff (dev)' },
  { sub: 'dev-outlet_manager', name: 'Outlet manager (dev)' },
  { sub: 'dev-regional_manager', name: 'Regional manager (dev)' },
  { sub: 'dev-accounts', name: 'Accounts (dev)' },
  { sub: 'dev-head_of_operations', name: 'Head of operations (dev)' },
];

const { privateKey, publicKey } = await generateKeyPair('ES256');
const KID = `dev-idp-${randomBytes(4).toString('hex')}`;
const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'ES256', use: 'sig' };

/** code → { sub, nonce, challenge, redirectUri, clientId, exp } — one use, 60 s. */
const codes = new Map();

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'content-type': isJson ? 'application/json' : 'text/html; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function readForm(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ISSUER);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    if (url.pathname === '/.well-known/openid-configuration') {
      return send(res, 200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }

    if (url.pathname === '/jwks') return send(res, 200, { keys: [publicJwk] });

    if (url.pathname === '/authorize' && req.method === 'GET') {
      const p = url.searchParams;
      const problems = [];
      if (p.get('response_type') !== 'code') problems.push('response_type must be code');
      if (p.get('client_id') !== CLIENT_ID) problems.push(`unknown client_id (expected ${CLIENT_ID})`);
      if (!REDIRECTS.has(p.get('redirect_uri') ?? '')) problems.push('redirect_uri is not allow-listed');
      if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) problems.push('PKCE S256 is required');
      if (!p.get('nonce')) problems.push('nonce is required');
      if (problems.length > 0) return send(res, 400, `<h1>Dev IdP: bad request</h1><ul>${problems.map((x) => `<li>${escape(x)}</li>`).join('')}</ul>`);
      const sub = p.get('login_as');
      if (sub && USERS.some((u) => u.sub === sub)) {
        const code = randomBytes(24).toString('base64url');
        codes.set(code, {
          sub,
          nonce: p.get('nonce'),
          challenge: p.get('code_challenge'),
          redirectUri: p.get('redirect_uri'),
          clientId: p.get('client_id'),
          exp: Date.now() + 60_000,
        });
        const back = new URL(p.get('redirect_uri'));
        back.searchParams.set('code', code);
        if (p.get('state')) back.searchParams.set('state', p.get('state'));
        res.writeHead(302, { location: back.toString(), 'cache-control': 'no-store' });
        return res.end();
      }
      const list = USERS.map((u) => {
        const next = new URL(url);
        next.searchParams.set('login_as', u.sub);
        return `<li><a href="${escape(next.toString())}">${escape(u.name)}</a> <code>${escape(u.sub)}</code></li>`;
      }).join('');
      return send(
        res,
        200,
        `<!doctype html><meta name="viewport" content="width=device-width"><title>Dev sign-in</title>
         <style>body{font:16px system-ui;margin:2rem;max-width:32rem}li{margin:.75rem 0}a{font-weight:600}</style>
         <h1>Development sign-in</h1><p>DEV ONLY — no password. Choose who you are:</p><ul>${list}</ul>`,
      );
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const form = await readForm(req);
      const code = form.get('code') ?? '';
      const entry = codes.get(code);
      codes.delete(code); // one use, whatever happens
      if (form.get('grant_type') !== 'authorization_code' || !entry || entry.exp < Date.now()) {
        return send(res, 400, { error: 'invalid_grant' });
      }
      if (form.get('client_id') !== entry.clientId || form.get('redirect_uri') !== entry.redirectUri) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'client or redirect mismatch' });
      }
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== entry.challenge) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      const user = USERS.find((u) => u.sub === entry.sub);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ nonce: entry.nonce, name: user?.name })
        .setProtectedHeader({ alg: 'ES256', kid: KID, typ: 'JWT' })
        .setIssuer(ISSUER)
        .setAudience(entry.clientId)
        .setSubject(entry.sub)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      return send(res, 200, { id_token: idToken, token_type: 'Bearer', expires_in: 300 });
    }

    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    return send(res, 500, { error: 'server_error', error_description: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`[dev-idp] DEV ONLY OIDC provider at ${ISSUER} (client_id ${CLIENT_ID}, kid ${KID})`);
  console.log(`[dev-idp] API env: OIDC_ISSUER=${ISSUER} OIDC_CLIENT_ID=${CLIENT_ID}`);
});
