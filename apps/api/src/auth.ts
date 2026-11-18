/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DEV-ONLY PATH. Production identity is `./identity/` — ES256 tokens bound to
 * an enrolled device key by DPoP, minted after an OIDC sign-in (02 §2.2, §2.7).
 * ═══════════════════════════════════════════════════════════════════════════
 * This file is the HS256 shared-secret token the live drills, the test
 * harness and `pnpm dev:token` use against the local stack. It is accepted
 * ONLY when the server is built with a `jwtSecret`, and `dev.ts` refuses to
 * set one when NODE_ENV=production. Nothing in the device path reads it.
 *
 * Dev-grade HS256 JWTs (jose). Claims: { tid, uid, role, locs } — tid is the
 * ONLY source of tenant identity for every query and write (CLAUDE.md §2.1).
 *
 * `role` is carried as an opaque string: roles are tenant-editable
 * configuration (§2.6), so NO code in this package branches on a role name.
 * The single exception is the platform operator plane (`platform_operator`),
 * which is not tenant RBAC at all — it gates provisioning, which writes
 * platform.* tables no tenant role may touch.
 */
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { deterministicUuid } from '@erp/db';

const claimsSchema = z.object({
  /** Tenant id — the isolation boundary. From the token, never a payload. */
  tid: z.string().uuid(),
  /** User id — audit trail on every write. */
  uid: z.string().uuid(),
  /** Tenant-defined role name. Opaque to the platform — never branched on. */
  role: z.string().min(1),
  /** Location ids this user is scoped to. Mutations must name one of them. */
  locs: z.array(z.string().uuid()),
  /** Device id (uuid). Optional; derived deterministically from uid if absent. */
  dev: z.string().uuid().optional(),
  /** Platform operator plane — provisioning only. NOT a tenant role. */
  platform_operator: z.boolean().optional(),
});

export type Claims = z.infer<typeof claimsSchema>;

export interface VerifiedIdentity {
  tenantId: string;
  userId: string;
  /** Opaque label for logs. NEVER branched on (CLAUDE.md §2.9). */
  role: string;
  /**
   * Where this session may WRITE — the device ceiling. On the device path it
   * is resolved from app.device_location_scope per request; on the dev path it
   * is the HS256 `locs` claim. The permission check decides everything else.
   */
  locationIds: readonly string[];
  deviceId: string;
  platformOperator: boolean;
  /** `sid` — per USER per DEVICE. Absent on the dev path. */
  sessionId?: string | undefined;
  /** Which verifier produced this identity. Never an authorisation input. */
  authKind: 'dev' | 'device';
}

const encoder = new TextEncoder();

export async function signDevToken(
  secret: string,
  claims: Claims,
  opts: { expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({ ...claimsSchema.parse(claims) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '2h')
    .sign(encoder.encode(secret));
}

/**
 * Verify a bearer token and produce the request identity. Throws on any
 * failure — expired, bad signature, malformed claims. The caller maps the
 * throw to UNAUTHORIZED; no partial identity ever escapes.
 */
export async function verifyToken(secret: string, token: string): Promise<VerifiedIdentity> {
  const { payload } = await jwtVerify(token, encoder.encode(secret), { algorithms: ['HS256'] });
  const claims = claimsSchema.parse(payload);
  return {
    tenantId: claims.tid,
    userId: claims.uid,
    role: claims.role,
    locationIds: claims.locs,
    // write_log DEVICE rows require a device identity; a browser session
    // without a registered device gets a stable uid-derived one.
    deviceId: claims.dev ?? deterministicUuid('derived-device', claims.uid),
    platformOperator: claims.platform_operator === true,
    authKind: 'dev',
  };
}
