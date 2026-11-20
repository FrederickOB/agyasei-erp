/**
 * A brand-new tenant's FIRST administrator, and the one enrolment code that
 * brings its first device online — onboarding's single bootstrap act
 * (02 §2.2, §2.7).
 *
 * WHY THIS EXISTS. A user signs in only on an ENROLLED device (the tenant
 * comes from the device, never from the IdP), and an enrolment code is issued
 * only by an administrator signed in on an enrolled device
 * (admin.devices.issueCode). A tenant fresh from createTenant + applyTemplate
 * has its roles, no users and no devices — so nothing in the product can bring
 * its first device online. The dev stack sidesteps this with the HS256 dev
 * path, which production refuses outright. This is the production answer, run
 * ONCE by whoever provisions the tenant.
 *
 * WHAT IT IS NOT. It is not a second way to mint codes. It acts only while the
 * tenant has NO enrolled device (any status, retired included):
 *   - no user at all → create the first administrator and a code;
 *   - exactly one user, created by this function, linked to the SAME subject →
 *     a fresh code for that administrator (the first one lapsed unused — it
 *     lives 15 minutes, and onboarding is a person at a keyboard);
 *   - anything else → refused.
 * The moment the first device enrols, it is closed for good: from then on,
 * codes come from the Devices screen, audited against a named person.
 *
 * HOW. It runs INSIDE the tenant's own RLS context, as app_user — the caller's
 * withTenant — so the tenant is the GUC, exactly like every other write. It
 * writes the same rows admin.users.create and admin.devices.issueCode write:
 * a user holding the tenant's OWNER role at the root (the role that holds the
 * whole catalogue by construction, 0005), linked to an IdP subject; and a
 * single-use, 15-minute code stored only as its SHA-256. Both hang off one
 * SERVER-origin write_log marker, with identity_event audit rows whose actor
 * is 'system'.
 */
import { uuidv7, type HlcClock } from '@erp/db';
import { provisionPrincipal } from '@erp/db/seed';
import type { Queryable } from '../db.js';
import { recordIdentityEvent, serverWrite } from './audit.js';
import {
  ENROLMENT_CODE_TTL_S,
  displayEnrolmentCode,
  generateEnrolmentCode,
  hashEnrolmentCode,
} from './enrolment-code.js';

export type FirstAdminRefusal =
  | 'NOT_IN_TENANT_CONTEXT'
  | 'FIRST_ADMIN_EXISTS'
  | 'INVALID_INPUT'
  | 'BAD_LOCATION';

export class FirstAdminRefused extends Error {
  constructor(
    readonly reason: FirstAdminRefusal,
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = 'FirstAdminRefused';
  }
}

export interface FirstAdminInput {
  /** Must equal the tenant GUC the caller set — a cross-check, not a source. */
  tenantId: string;
  /** The IdP's issuer, EXACTLY as its id_tokens carry it in `iss`. */
  subjectIssuer: string;
  /** The IdP's `sub` for this person. */
  subjectRef: string;
  username: string;
  displayName: string;
  /** The first device. `locationId: null` is the head-office laptop that
   *  syncs nothing and works online (02 §2.5). */
  device: { label: string; formFactor: 'tablet' | 'phone' | 'laptop'; locationId: string | null };
}

export interface FirstAdminResult {
  userId: string;
  /** True when the administrator already existed and only a fresh code was issued. */
  reissued: boolean;
  codeId: string;
  /** Display form (XXXX-XXXX). Exists only here — only its hash is stored. */
  code: string;
  expiresAt: string;
}

const USERNAME = /^[a-z0-9._-]{2,64}$/i;

export async function bootstrapFirstAdmin(
  tx: Queryable,
  clock: HlcClock,
  input: FirstAdminInput,
): Promise<FirstAdminResult> {
  const issuer = input.subjectIssuer.trim();
  const subject = input.subjectRef.trim();
  const displayName = input.displayName.trim();
  const label = input.device.label.trim();
  if (!/^https?:\/\/\S+$/.test(issuer)) throw new FirstAdminRefused('INVALID_INPUT', 'subjectIssuer must be the IdP issuer URL');
  if (subject.length < 1 || subject.length > 255) throw new FirstAdminRefused('INVALID_INPUT', 'subjectRef must be 1–255 characters');
  if (!USERNAME.test(input.username)) throw new FirstAdminRefused('INVALID_INPUT', 'username must be 2–64 of letters, digits, . _ -');
  if (displayName.length < 1 || displayName.length > 120) throw new FirstAdminRefused('INVALID_INPUT', 'displayName must be 1–120 characters');
  if (label.length < 1 || label.length > 80) throw new FirstAdminRefused('INVALID_INPUT', 'device label must be 1–80 characters');

  // The tenant is the GUC the caller set, as app_user. The input's tenantId is
  // only a cross-check that the caller opened the context they meant to.
  const ctx = await tx.query<{ tenant: string | null }>(`select app.current_tenant()::text as tenant`);
  if (ctx.rows[0]?.tenant !== input.tenantId) {
    throw new FirstAdminRefused('NOT_IN_TENANT_CONTEXT', 'run inside the tenant’s own RLS context (withTenant)');
  }

  // Closed for good once ANY device has enrolled — codes then come from a
  // named administrator on the Devices screen.
  const refuse = (): never => {
    throw new FirstAdminRefused(
      'FIRST_ADMIN_EXISTS',
      'this tenant is already onboarded; issue enrolment codes from the Devices screen as an administrator',
    );
  };
  const devices = await tx.query<{ n: string }>(`select count(*)::text as n from app.device`);
  if (Number(devices.rows[0]?.n ?? '0') > 0) refuse();

  // Every user row counts — active, disabled or deleted.
  const users = await tx.query<{ id: string; subject_issuer: string | null; subject_ref: string | null }>(
    `select id, subject_issuer, subject_ref from app.user_account`,
  );
  let existingAdmin: string | null = null;
  if (users.rows.length > 0) {
    const only = users.rows.length === 1 ? users.rows[0]! : null;
    if (!only || only.subject_issuer !== issuer || only.subject_ref !== subject) refuse();
    const madeHere = await tx.query(
      `select 1 from app.identity_event
        where subject_id = $1 and action = 'user.create' and actor_kind = 'system'
          and after ->> 'firstAdmin' = 'true'`,
      [only!.id],
    );
    if (madeHere.rows.length === 0) refuse();
    existingAdmin = only!.id;
  }

  if (input.device.locationId !== null) {
    const loc = await tx.query<{ kind: string }>(
      `select kind from app.location where id = $1 and deleted_at is null and is_active`,
      [input.device.locationId],
    );
    if (!loc.rows[0]) throw new FirstAdminRefused('BAD_LOCATION', 'no such active location');
    if (loc.rows[0].kind === 'TRANSIT') {
      throw new FirstAdminRefused('BAD_LOCATION', 'a device is never homed at a TRANSIT node — choose its outlet');
    }
  }

  // The owner role at the root: provisionPrincipal's default (roleRef omitted).
  const userId = existingAdmin ?? uuidv7();
  if (existingAdmin === null) {
    await provisionPrincipal(tx, input.tenantId, { userId, username: input.username, displayName });
    await tx.query(
      `update app.user_account set subject_issuer = $2, subject_ref = $3 where id = $1`,
      [userId, issuer, subject],
    );
  } else {
    // One live first-device code at a time: any earlier one still unused is
    // cancelled, and redeeming it answers enrolment_code_used.
    await tx.query(
      `update app.device_enrolment_code
          set consumed_at = transaction_timestamp(), outcome = 'cancelled', updated_at = transaction_timestamp()
        where consumed_at is null`,
    );
  }

  const writeId = await serverWrite(tx, clock, { tenantId: input.tenantId, op: 'onboarding.first_admin', userId });

  const code = generateEnrolmentCode();
  const codeHash = hashEnrolmentCode(code);
  const codeId = uuidv7();
  const expires = await tx.query<{ at: string }>(
    `select (transaction_timestamp() + ($1 || ' seconds')::interval)::text as at`,
    [String(ENROLMENT_CODE_TTL_S)],
  );
  const expiresAt = expires.rows[0]!.at;
  await tx.query(
    `insert into app.device_enrolment_code
       (tenant_id, id, write_id, hlc, code_hash, location_id, label, form_factor, issued_by, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,
    [input.tenantId, codeId, writeId, clock.next(), codeHash, input.device.locationId, label, input.device.formFactor, userId, expiresAt],
  );
  await tx.query(`select platform.publish_enrolment_code($1, $2)`, [codeHash, codeId]);

  if (existingAdmin === null) {
    await recordIdentityEvent(tx, clock, {
      tenantId: input.tenantId,
      writeId,
      eventClass: 'write',
      actorKind: 'system',
      action: 'user.create',
      subjectTable: 'user_account',
      subjectId: userId,
      after: { username: input.username, displayName, linked: true, firstAdmin: true },
    });
  }
  await recordIdentityEvent(tx, clock, {
    tenantId: input.tenantId,
    writeId,
    eventClass: 'write',
    actorKind: 'system',
    action: 'enrolment_code.issue',
    subjectTable: 'device_enrolment_code',
    subjectId: codeId,
    after: { label, formFactor: input.device.formFactor, locationId: input.device.locationId, expiresAt, firstAdmin: true },
  });

  return { userId, reissued: existingAdmin !== null, codeId, code: displayEnrolmentCode(code), expiresAt };
}
