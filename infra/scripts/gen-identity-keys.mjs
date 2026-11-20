#!/usr/bin/env node
/**
 * Generate a PRIVATE ES256 JWKS for the API's identity service.
 *
 *   node infra/scripts/gen-identity-keys.mjs <kid> > keys.jwks.json
 *
 * Run it twice, with different kids, for the two rings production needs —
 * they must never share a key (identity/config.ts refuses it):
 *   ERP_SIGNING_JWKS  access + sync tokens  (e.g. kid signing-2026-11)
 *   ERP_LEASE_JWKS    the offline lease     (e.g. kid lease-2026-11)
 *
 * Rotation (02 §2.7, runbook §2): put the NEW key FIRST and keep the previous
 * one after it — the first key signs, every key in the set verifies — then
 * drop the old key once its tokens and leases have expired.
 *
 * The output is a secret. Write it outside the repository, import it with
 * `fly secrets import`, and delete the file.
 */
import { exportJWK, generateKeyPair } from 'jose';

const kid = process.argv[2];
if (!kid || !/^[A-Za-z0-9._-]{3,64}$/.test(kid)) {
  process.stderr.write('usage: gen-identity-keys.mjs <kid>   (3–64 chars: letters, digits, . _ -)\n');
  process.exit(2);
}
const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(privateKey)), kid, alg: 'ES256', use: 'sig' };
process.stdout.write(`${JSON.stringify({ keys: [jwk] })}\n`);
