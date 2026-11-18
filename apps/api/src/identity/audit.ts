/**
 * Audit rows for identity and device acts (02 §2.6 → app.identity_event).
 *
 * Every row hangs off a write_log marker — the unit of work it belongs to —
 * so the audit trail sits on the same spine as everything else. Acts that
 * arrive through the idempotent pipeline (admin screens, enrolment) use that
 * request's own key; acts the SERVER originates (a refused redemption, a
 * detected refresh-credential reuse, a drain the device abandoned) mint a
 * SERVER-origin marker here.
 *
 * `hlc` is server-stamped (§3.4.1). Nothing in an audit row is a device clock.
 */
import { createHash } from 'node:crypto';
import { uuidv7, type HlcClock } from '@erp/db';
import type { Queryable } from '../db.js';
import type { JsonValue } from '../pipeline.js';

export async function serverWrite(
  tx: Queryable,
  clock: HlcClock,
  args: { tenantId: string; op: string; deviceId?: string | null; userId?: string | null; id?: string },
): Promise<string> {
  const id = args.id ?? uuidv7();
  await tx.query(
    `insert into app.write_log
       (tenant_id, id, origin, hlc, device_id, user_id, op, schema_version, request_hash)
     values ($1, $2, 'SERVER', $3, $4, $5, $6, 1, $7)`,
    [
      args.tenantId,
      id,
      clock.next(),
      args.deviceId ?? null,
      args.userId ?? null,
      args.op,
      createHash('sha256').update(`${args.op}:${id}`).digest(),
    ],
  );
  return id;
}

export interface IdentityEventInput {
  tenantId: string;
  writeId: string;
  eventClass: 'write' | 'denial';
  actorKind: 'user' | 'device' | 'system';
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  action: string;
  permissionUsed?: string | null;
  subjectTable: string;
  subjectId?: string | null;
  before?: JsonValue | null;
  after?: JsonValue | null;
  reasonCode?: string | null;
  reasonNote?: string | null;
}

export async function recordIdentityEvent(
  tx: Queryable,
  clock: HlcClock,
  e: IdentityEventInput,
): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.identity_event
       (tenant_id, id, write_id, hlc, event_class, actor_kind, actor_user_id, actor_device_id,
        action, permission_used, subject_table, subject_id, before, after, reason_code, reason_note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16)`,
    [
      e.tenantId,
      id,
      e.writeId,
      clock.next(),
      e.eventClass,
      e.actorKind,
      e.actorUserId ?? null,
      e.actorDeviceId ?? null,
      e.action,
      e.permissionUsed ?? null,
      e.subjectTable,
      e.subjectId ?? null,
      e.before === undefined || e.before === null ? null : JSON.stringify(e.before),
      e.after === undefined || e.after === null ? null : JSON.stringify(e.after),
      e.reasonCode ?? null,
      e.reasonNote ?? null,
    ],
  );
  return id;
}
