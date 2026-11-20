/**
 * Is a printed document number already held at a location?
 *
 * A device draws ONE series of numbers (03 §3.7.5) and prints them on sale
 * receipts and on return slips alike, so a collision (class #14 — a wiped
 * device re-issuing numbers) can land on either document type. Both writers
 * ask here, so a sale cannot take a number a return slip already carries, or
 * the other way round, without the #14 review opening.
 */
import type { Queryable } from './db.js';

export interface HeldNumber {
  readonly table: 'app.sale' | 'app.sale_return';
  readonly id: string;
  readonly number: string;
}

export async function documentNumberHolder(
  tx: Queryable,
  locationId: string,
  number: string,
): Promise<HeldNumber | null> {
  const res = await tx.query<{ tbl: string; id: string; no: string }>(
    `select 'app.sale' as tbl, id, receipt_no as no from app.sale
      where location_id = $1 and receipt_no = $2
     union all
     select 'app.sale_return' as tbl, id, return_no as no from app.sale_return
      where location_id = $1 and return_no = $2
     limit 1`,
    [locationId, number],
  );
  const row = res.rows[0];
  if (row === undefined) return null;
  return { table: row.tbl === 'app.sale' ? 'app.sale' : 'app.sale_return', id: row.id, number: row.no };
}
