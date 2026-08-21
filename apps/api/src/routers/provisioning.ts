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
      await tx.query(
        `insert into platform.tenant (id, slug, legal_name, status, jurisdiction_code, activated_at)
         values ($1, $2, $3, 'active', $4, transaction_timestamp())
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
