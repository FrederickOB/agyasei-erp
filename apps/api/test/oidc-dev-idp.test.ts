/**
 * The OIDC relying party against a REAL provider over HTTP: the dev IdP
 * (infra/dev-idp/server.mjs) on a loopback port — real discovery, a real
 * remote JWKS fetch, a real authorization-code + PKCE round trip. The suites
 * elsewhere inject keys; this one proves the network path they skip.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdTokenVerifier } from '../src/identity/oidc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 19_400 + Math.floor(Math.random() * 500);
const ISSUER = `http://127.0.0.1:${PORT}`;
const CLIENT = 'erp-pwa-dev';
const REDIRECT = 'http://localhost:5173/auth/callback';
let idp: ChildProcess;

beforeAll(async () => {
  idp = spawn(process.execPath, [path.join(ROOT, 'infra/dev-idp/server.mjs')], {
    env: { ...process.env, DEV_IDP_PORT: String(PORT), DEV_IDP_ISSUER: ISSUER },
    stdio: 'pipe',
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`${ISSUER}/.well-known/openid-configuration`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('dev IdP did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

afterAll(() => {
  idp.kill();
});

async function codeFlow(nonce: string, verifier: string, presented: string = verifier): Promise<Response> {
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const auth = new URL(`${ISSUER}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    scope: 'openid profile',
    state: 's1',
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_as: 'dev-counter_staff',
  })) auth.searchParams.set(k, v);
  const redirect = await fetch(auth, { redirect: 'manual' });
  expect(redirect.status).toBe(302);
  const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
  const token = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: presented }).toString(),
  });
  return token;
}

async function idTokenFrom(nonce: string): Promise<string> {
  const res = await codeFlow(nonce, randomBytes(32).toString('base64url'));
  expect(res.status).toBe(200);
  return ((await res.json()) as { id_token: string }).id_token;
}

describe('the OIDC relying party against the dev IdP, over HTTP', () => {
  it('discovers, fetches the JWKS, and verifies an id_token from a real PKCE round trip', async () => {
    const verifier = createIdTokenVerifier({ issuer: ISSUER, clientId: CLIENT, algorithms: ['ES256'] });
    const d = await verifier.discovery();
    expect(d.tokenEndpoint).toBe(`${ISSUER}/token`);
    const nonce = `${'a'.repeat(43)}.${randomBytes(16).toString('base64url')}`;
    const idToken = await idTokenFrom(nonce);
    const subject = await verifier.verify(idToken, nonce);
    expect(subject).toEqual({ issuer: ISSUER, subject: 'dev-counter_staff', nonce });
  });

  it('refuses a wrong PKCE verifier at the provider, and a wrong nonce or audience at the relying party', async () => {
    const nonce = `${'b'.repeat(43)}.${randomBytes(16).toString('base64url')}`;
    // PKCE: the code redeemed with a verifier that does not match the challenge.
    const stolen = await codeFlow(nonce, randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'));
    expect(stolen.status).toBe(400);
    const idToken = await idTokenFrom(nonce);
    await expect(createIdTokenVerifier({ issuer: ISSUER, clientId: CLIENT, algorithms: ['ES256'] }).verify(idToken, `${nonce}x`)).rejects.toThrow(/nonce/);
    await expect(createIdTokenVerifier({ issuer: ISSUER, clientId: 'someone-else', algorithms: ['ES256'] }).verify(idToken, nonce)).rejects.toThrow();
    expect(() => createIdTokenVerifier({ issuer: ISSUER, clientId: CLIENT, algorithms: ['HS256'] })).toThrow(/refused/);
  });
});
