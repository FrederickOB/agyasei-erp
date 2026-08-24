/**
 * Provisioning: tenant lifecycle (operator plane) and template application.
 *
 * createTenant writes platform.* — an operator path, never app_user
 * (01-tenancy §1.1). applyTemplate runs INSIDE the tenant's own RLS context
 * as app_user, exactly like the @erp/db applier requires: templates are
 * seed data applied once to create ordinary editable rows (ADR-0006), and
 * the applier is already idempotent (deterministic ids + ON CONFLICT DO
 * NOTHING), so it does not go through the DEVICE write pipeline — its
 * writes are SERVER-origin write_log rows the applier mints itself.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { uuidv7 } from '@erp/db';
import { TEMPLATE_ID, applySequenceCounters, applyTemplate, applyTenant1Locations } from '@erp/db/seed';
import { operatorProcedure, router, tenantProcedure } from '../trpc.js';
import { zUuid } from '../wire.js';

const createTenantInput = z
  .object({
    tenantId: zUuid.optional(),
    slug: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase slug'),
    legalName: z.string().min(1),
    jurisdictionCode: z.string().length(2),
  })
  .strict();

const applyTemplateInput = z
  .object({
    template: z.literal(TEMPLATE_ID),
    /** Tenant #1's 25-outlet network — ONBOARDING INPUT, not template data. */
    includePilotLocations: z.boolean().default(false),
  })
  .strict();

export const provisioningRouter = router({
  createTenant: operatorProcedure.input(createTenantInput).mutation(async ({ ctx, input }) => {
    const admin = ctx.deps.admin;
    if (!admin) throw new TRPCError({ code: 'FORBIDDEN', message: 'operator plane not configured' });
    const tenantId = input.tenantId ?? uuidv7();
    await admin.run(async (tx) => {
      const jur = await tx.query<{ code: string }>(
        'select code from platform.jurisdiction where code = $1',
        [input.jurisdictionCode],
      );
      if (jur.rows.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `jurisdiction ${input.jurisdictionCode} is not provisioned`,
        });
      }
      // ── G-1: A TENANT IS BORN 'provisioning', NOT 'active'. ──────────────
      // The Phase 2 gate found `platform.tax_rate.confirmed_by/confirmed_at`
      // existing, commented as "the §2.8 gate, in the schema", NULL on every
      // seeded Ghana row — and read by nothing, while `createTenant` wrote
      // 'active' immediately. So the facility fee (unmodelled upside) refused
      // to post without a human while sales tax (every sale, statutory) was
      // applied unconfirmed. That asymmetry was exactly backwards.
      //
      // Activation is now its own act with its own check (`activateTenant`).
      // Creating a tenant is cheap and reversible; letting one trade under
      // rates nobody has confirmed is neither.
      await tx.query(
        `insert into platform.tenant (id, slug, legal_name, status, jurisdiction_code)
         values ($1, $2, $3, 'provisioning', $4)
         on conflict (id) do nothing`,
        [tenantId, input.slug, input.legalName, input.jurisdictionCode],
      );
      await tx.query(
        `insert into platform.tenant_database (tenant_id, dsn_ref, sync_service_ref)
         values ($1, $2, $3)
         on conflict (tenant_id) do nothing`,
        [tenantId, 'secret://clusters/eu-west-1-shared/dsn', 'https://sync.invalid/eu-west-1-shared'],
      );
    });
    return { tenantId };
  }),

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * ACTIVATE A TENANT — the §2.8 tax gate, enforced (G-1).
   * ═════════════════════════════════════════════════════════════════════════
   * A tenant may not leave 'provisioning' while any tax rate in force for its
   * jurisdiction is unconfirmed. `confirmed_by` and `confirmed_at` have been
   * in the schema since migration 0001, paired by a CHECK, and until now
   * nothing read them.
   *
   * WHAT "IN FORCE" MEANS HERE: every rate row whose effective range has not
   * ended. A lapsed historical rate is deliberately NOT required — a tenant
   * cannot be blocked forever by a 2019 row nobody can now attest to, and a
   * historical transaction reprices against the row in force on its own date,
   * which is a separate and already-tested guarantee.
   *
   * WHY THE CHECK IS HERE AND NOT ON THE SALE PATH: blocking a sale would take
   * a trading counter down over a configuration gap, which is the pattern
   * CLAUDE.md §2.2 rejects everywhere else. Blocking ACTIVATION stops the
   * problem before anybody trades, which is when it is cheap.
   */
  activateTenant: operatorProcedure
    .input(z.object({ tenantId: zUuid }).strict())
    .mutation(async ({ ctx, input }) => {
      const admin = ctx.deps.admin;
      if (!admin) throw new TRPCError({ code: 'FORBIDDEN', message: 'operator plane not configured' });

      return admin.run(async (tx) => {
        const found = await tx.query<{ status: string; jurisdiction_code: string }>(
          `select status, jurisdiction_code from platform.tenant where id = $1`,
          [input.tenantId],
        );
        const tenant = found.rows[0];
        if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such tenant' });
        if (tenant.status === 'active') {
          return { tenantId: input.tenantId, status: 'active' as const, alreadyActive: true };
        }

        const unconfirmed = await tx.query<{ tax_code: string; effective: string }>(
          `select tax_code, effective::text
             from platform.tax_rate
            where jurisdiction_code = $1
              and upper_inf(effective)
              and confirmed_by is null
            order by tax_code`,
          [tenant.jurisdiction_code],
        );
        if (unconfirmed.rows.length > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `TAX_RATES_UNCONFIRMED: ${unconfirmed.rows.length} tax rate(s) in force for ` +
              `${tenant.jurisdiction_code} carry no confirmation from a qualified practitioner ` +
              `(${unconfirmed.rows.map((r) => r.tax_code).join(', ')}). CLAUDE.md §2.8 makes that ` +
              `review blocking: a tenant may not trade under rates nobody has attested to.`,
          });
        }

        await tx.query(
          `update platform.tenant
              set status = 'active', activated_at = transaction_timestamp()
            where id = $1`,
          [input.tenantId],
        );
        return { tenantId: input.tenantId, status: 'active' as const, alreadyActive: false };
      });
    }),

  /**
   * What is standing between this tenant and activation. A question, not an
   * act — so an operator can see the gap without attempting the transition
   * and reading it off an error.
   */
  activationReadiness: operatorProcedure
    .input(z.object({ tenantId: zUuid }).strict())
    .query(async ({ ctx, input }) => {
      const admin = ctx.deps.admin;
      if (!admin) throw new TRPCError({ code: 'FORBIDDEN', message: 'operator plane not configured' });
      return admin.run(async (tx) => {
        const found = await tx.query<{ status: string; jurisdiction_code: string }>(
          `select status, jurisdiction_code from platform.tenant where id = $1`,
          [input.tenantId],
        );
        const tenant = found.rows[0];
        if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such tenant' });
        const rates = await tx.query<{ tax_code: string; confirmed_by: string | null }>(
          `select tax_code, confirmed_by from platform.tax_rate
            where jurisdiction_code = $1 and upper_inf(effective) order by tax_code`,
          [tenant.jurisdiction_code],
        );
        const unconfirmed = rates.rows.filter((r) => r.confirmed_by === null).map((r) => r.tax_code);
        return {
          tenantId: input.tenantId,
          status: tenant.status,
          jurisdictionCode: tenant.jurisdiction_code,
          ratesInForce: rates.rows.length,
          unconfirmedTaxCodes: unconfirmed,
          canActivate: unconfirmed.length === 0,
        };
      });
    }),

  /**
   * Apply the named starter template to THIS token's tenant. The tenant id
   * comes from the verified token only — there is no tenant parameter.
   */
  applyTemplate: tenantProcedure.input(applyTemplateInput).mutation(async ({ ctx, input }) => {
    const tenantId = ctx.identity.tenantId;
    return ctx.deps.runner.withTenant(tenantId, async (tx) => {
      const result = await applyTemplate(tx, tenantId);
      if (input.includePilotLocations) {
        await applyTenant1Locations(tx, tenantId);
      }
      // Receipt-number counters need locations to exist, so they are seeded
      // last (03 §3.7.5). Additive and idempotent: a location created later
      // gets its counter from ensureSequenceCounters below, and a counter the
      // tenant has since edited is never overwritten.
      const sequenceCounters = await applySequenceCounters(tx, tenantId);
      return {
        templateId: result.templateId,
        templateVersion: result.templateVersion,
        founderPendingCount: result.founderPending.length,
        sequenceCounters,
      };
    });
  }),

  /**
   * Give every selling location a receipt-number counter (03 §3.7.5).
   * Additive and idempotent — run it after adding a location. Without a
   * counter row a location cannot allocate a block and the POS refuses to
   * number a receipt, which is the correct fail-closed behaviour: the
   * numbering format is tenant data, and the platform never invents one.
   */
  ensureSequenceCounters: tenantProcedure.mutation(async ({ ctx }) => {
    const tenantId = ctx.identity.tenantId;
    const locations = await ctx.deps.runner.withTenant(tenantId, (tx) =>
      applySequenceCounters(tx, tenantId),
    );
    return { locations };
  }),
});
