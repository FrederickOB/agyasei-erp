/**
 * The tenant's own reason vocabulary for a stock movement.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS TENANT DATA. NOTHING IN THE CLIENT MAY BRANCH ON IT.
 * ═══════════════════════════════════════════════════════════════════════════
 * `app.movement_reason` is a tenant-owned, tenant-editable table that arrives
 * through the sync stream like any other configuration (§8.9). A tenant that
 * renames "Damaged goods" tomorrow gets the new word at every counter on the
 * next sync with no deploy — which only stays true because no component
 * compares one of these strings to a literal. The platform's own closed
 * vocabulary for "what kind of document is this" is `sourceKind`, in
 * `@erp/contracts`, and that is the one authority is derived from
 * (apps/api/src/routers/inventory.ts says so in the same words).
 *
 * ---------------------------------------------------------------------------
 * WHY THE LIST IS READ LOCALLY, AND WHY THAT MATTERS MORE THAN IT LOOKS
 * ---------------------------------------------------------------------------
 * `movement_reason` is in the `tenant_reference` sync bucket, so it is on the
 * device and this read works with the radio off. That is what makes the whole
 * adjustment screen an OFFLINE screen: a reason code is required on every
 * movement, and a device that had to ask the server what its reasons were
 * could not record one during the hours this product exists for.
 *
 * It also has to be a PICK, never a typed string. The server answers
 * `PRECONDITION_FAILED: unknown movement reason X` for a code it cannot
 * resolve — a permanently unapplicable payload that `classifyRejection`
 * nonetheless classes RETRYABLE, so it would sit at the head of the queue
 * being retried for ever and every sale behind it would stop draining. The
 * only codes this client can send are codes it read out of the tenant's own
 * rows.
 */
import type { DbExecutor } from '../db';

export interface MovementReason {
  /** The tenant's code — sent on the wire, resolved server-side. */
  readonly code: string;
  /** The tenant's words for it. Rendered; never compared. */
  readonly name: string;
}

export async function loadMovementReasons(db: DbExecutor): Promise<MovementReason[]> {
  const rows = await db.getAll(
    `SELECT code, name FROM movement_reason
      WHERE code IS NOT NULL AND code <> ''
      ORDER BY COALESCE(name, code)`,
  );
  return rows.map((row) => ({
    code: String(row['code']),
    name: typeof row['name'] === 'string' && row['name'].length > 0 ? row['name'] : String(row['code']),
  }));
}
