/**
 * DEV-STACK PURCHASE UNITS — the founder's authoring step, played by the
 * bootstrap, because without it three live drills cannot run at all.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT WAS MISSING, AND HOW IT WENT UNNOTICED
 * ════════════════════════════════════════════════════════════════════════════
 * `applyTemplate` authors converting `product_uom` rows — a TON of 12m bars, a
 * ROLL of wire, a PAIR of pieces — and marks every one of them `can_sell` and
 * **`can_buy = false`**. That is deliberate and `packages/db/src/seed/
 * template.ts` says so in its own words: buying cement by the tonne "is a
 * further authoring step the founder confirms".
 *
 * The consequence on a stack built from nothing: `select … from
 * app.product_uom where can_buy and factor_num <> factor_den` returns **zero
 * rows**, and D11 (`drill:procure`), D12 (`drill:q1`) and D13
 * (`drill:counter`) abort at their first precondition — *"no product in this
 * catalogue is bought in a unit other than its stocking unit"*. They were
 * reported green because the dev database had accumulated such a row by hand
 * across earlier passes; `pnpm stack:reset` removes it, and with it the claim
 * that those drills are reproducible from nothing.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ════════════════════════════════════════════════════════════════════════════
 * It sets `can_buy` on converting units the TEMPLATE ALREADY AUTHORED. It
 * invents no unit, and — the part that matters — **no conversion factor**. A
 * factor is a physical claim about the goods (how many 12m bars are in a
 * tonne), it is already computed and reviewed in the template, and a dev
 * fixture that guessed one would put a wrong conversion into every receipt the
 * drills then declare correct. Enabling a direction on an existing row cannot
 * be wrong in that way: the same factor, used in the opposite direction, is
 * exactly §4.10's "same product_uom machinery".
 *
 * It lives in `infra/` for the same reason `dev-prices.ts` does — so it can
 * never be mistaken for template data — and it takes the one write path: a
 * SERVER-origin `app.write_log` row first, then the rows, under the tenant's
 * own RLS context. Idempotent: the second run updates nothing.
 */
import {
  createHlcClock,
  deterministicUuid,
  hlcNodeFromName,
  sha256Hex,
  type SqlClient,
} from '@erp/db';

const SEED_NS = 'infra-dev-purchase-units';

export interface DevPurchaseUnitResult {
  /** Rows this run turned buyable. Zero on a re-run — it is idempotent. */
  readonly enabled: number;
  /** Every converting unit that is buyable afterwards, as `SKU:UOM`. */
  readonly buyable: readonly string[];
}

export async function applyDevPurchaseUnits(
  tx: SqlClient,
  tenantId: string,
): Promise<DevPurchaseUnitResult> {
  const clock = createHlcClock(hlcNodeFromName(`${SEED_NS}:${tenantId}`));
  const writeId = deterministicUuid(tenantId, SEED_NS, 'write', 'enable');
  await tx.query(
    `insert into app.write_log
       (tenant_id, id, origin, hlc, op, schema_version, request_hash)
     values ($1, $2, 'SERVER', $3, 'dev-purchase-units.enable', 1, decode($4, 'hex'))
     on conflict (tenant_id, id) do nothing`,
    [tenantId, writeId, clock.next(), sha256Hex(`${SEED_NS}:${tenantId}`)],
  );

  // Only rows that already convert (`factor_num <> factor_den`) and that the
  // template already trusts in the selling direction. A product's stocking
  // unit is buyable from the start; this adds the second direction.
  const updated = await tx.query<{ id: string }>(
    `update app.product_uom pu
        set can_buy = true, write_id = $2, hlc = $3, updated_at = transaction_timestamp()
      where pu.tenant_id = $1
        and pu.deleted_at is null
        and pu.factor_num <> pu.factor_den
        and pu.can_sell
        and not pu.can_buy
      returning pu.id`,
    [tenantId, writeId, clock.next()],
  );

  const buyable = await tx.query<{ sku_code: string; uom_code: string }>(
    `select p.sku_code, u.code as uom_code
       from app.product_uom pu
       join app.product p on p.tenant_id = pu.tenant_id and p.id = pu.product_id
       join app.unit_of_measure u on u.tenant_id = pu.tenant_id and u.id = pu.uom_id
      where pu.tenant_id = $1 and pu.can_buy and pu.factor_num <> pu.factor_den
        and pu.deleted_at is null
      order by p.sku_code`,
    [tenantId],
  );

  return {
    enabled: updated.rows.length,
    buyable: buyable.rows.map((r) => `${r.sku_code}:${r.uom_code}`),
  };
}
