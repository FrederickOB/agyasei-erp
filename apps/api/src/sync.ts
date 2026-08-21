/**
 * The sync shore of the API — two plain Fastify routes (03-offline-sync §3.3,
 * infra/README "Auth contract"). The PowerSync service is DOWNLOAD-ONLY:
 * every device write lands here, never there.
 *
 *   POST /sync/upload   Ordered batch of outbox ops. Each op is dispatched to
 *                       the EXISTING tRPC mutation for its kind, so it flows
 *                       through the one idempotent pipeline (`runIdempotent`
 *                       over app.write_log: per-tenant key uniqueness,
 *                       server-stamped HLC, claimed_hlc stored untrusted) —
 *                       the pipeline is reused, never forked. One transaction
 *                       per op: a failing op is acked `rejected` and the
 *                       batch continues — head-of-line blocking is the
 *                       client's queue discipline, not the server's (§3.3.4).
 *
 *   GET  /sync/token    Exchanges a verified API JWT for a short-lived
 *                       PowerSync client token: HS256 with the ONE dev
 *                       secret, aud "powersync", `tid` from the VERIFIED
 *                       session — never from any input, query or payload
 *                       (CLAUDE.md §2.1; infra/powersync/sync_rules.yaml).
 *
 * Tenant identity: the verified token's `tid` is the only tenant id anything
 * downstream sees. A `tenant_id`/`tid` smuggled into an op payload is
 * stripped at this boundary and ignored — the server's tid wins; even if a
 * variant key slipped past, every statement still runs under the context
 * tenant (TenantRunner.withTenant takes it from the verified identity).
 */
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import {
  uploadBodySchema,
  uploadOpSchema,
  type DeviceOpKind,
  type SyncTokenResponse,
  type UploadAck,
  type UploadAckStatus,
} from '@erp/contracts';
import { createContextFromHeader, type ContextOptions } from './context.js';
import { appRouter } from './routers/index.js';
import { createCallerFactory, type Context } from './trpc.js';

const makeCaller = createCallerFactory(appRouter);
type Caller = ReturnType<typeof makeCaller>;

// ---------------------------------------------------------------------------
// POST /sync/upload
// ---------------------------------------------------------------------------

/**
 * The envelope schema and the ack types are NOT defined here. They live in
 * `@erp/contracts` (`packages/contracts/src/upload.ts`) alongside the batch
 * cap, so `apps/web`'s outbox drain builds exactly what this route parses
 * instead of hand-rolling a second copy of the same JSON — the same failure
 * that made every sale payload a BAD_REQUEST, one layer out.
 */
export { type UploadAck, type UploadAckStatus } from '@erp/contracts';

/**
 * The device-originated write surface. Kinds are the write_log `op`
 * discriminators — the same vocabulary the pipeline stamps on every marker.
 * Each entry invokes the EXISTING tRPC mutation, so validation (strict zod,
 * decimal-string money), location scoping and idempotency are identical to
 * an online call. The `never` casts are deliberate: the payload arrives
 * untyped from the wire and the mutation's own `.strict()` input schema is
 * the validator — a malformed payload is a per-op rejection, not a crash.
 */
type DeviceOpHandler = (caller: Caller, input: Record<string, unknown>) => Promise<unknown>;

const DEVICE_OPS: Record<DeviceOpKind, DeviceOpHandler> = {
  'sale.create': (c, i) => c.sales.createSale(i as never),
  'stock.record_movement': (c, i) => c.inventory.recordMovement(i as never),
  'credit.open_account': (c, i) => c.credit.openAccount(i as never),
  'credit.record_entry': (c, i) => c.credit.recordEntry(i as never),
  // Report this device's sequence cursor and take a block (03 §3.7.5). It
  // rides the same ordered outbox as every other write, so the report a device
  // queues while offline reaches the server before the sales that follow it.
  'sequence.sync_block': (c, i) => c.sequence.syncBlock(i as never),
};

/** Tenant identity never comes from a client payload (CLAUDE.md §2.1) —
 *  any spelling of it in an op payload is stripped and ignored. */
const FORGED_IDENTITY_KEYS = ['tenant_id', 'tenantId', 'tid'] as const;

/** Ops whose ack carries the stored response back (see UploadAck.result). */
const RESULT_OPS: ReadonlySet<string> = new Set(['sequence.sync_block']);

function reasonFrom(err: unknown): string {
  if (err instanceof TRPCError) return `${err.code}: ${err.message}`;
  return `INTERNAL_SERVER_ERROR: ${err instanceof Error ? err.message : String(err)}`;
}

async function applyOne(
  ctx: Context & { identity: NonNullable<Context['identity']> },
  caller: Caller,
  op: z.infer<typeof uploadOpSchema>,
): Promise<UploadAck> {
  const key = op.idempotency_key;
  // `kind` arrives as a free string so an unrecognised one is a per-op
  // UNKNOWN_KIND ack rather than a whole-batch envelope rejection (§3.3.4).
  // The TABLE, however, is keyed by the contract's DeviceOpKind union: adding
  // a kind to @erp/contracts without wiring it here is a compile error.
  const invoke = (DEVICE_OPS as Record<string, DeviceOpHandler | undefined>)[op.kind];
  if (!invoke) {
    return { key, status: 'rejected', reason: `UNKNOWN_KIND: '${op.kind}' is not an uploadable operation` };
  }

  // Server tid wins: forged tenant identity in the payload is ignored.
  const payload: Record<string, unknown> = { ...op.payload };
  for (const k of FORGED_IDENTITY_KEYS) delete payload[k];

  // The op envelope is authoritative for the write envelope.
  const input: Record<string, unknown> = {
    ...payload,
    idempotencyKey: key,
    ...(op.claimed_hlc !== undefined ? { claimedHlc: op.claimed_hlc } : {}),
    ...(op.client_wall_at !== undefined ? { clientWallAt: op.client_wall_at } : {}),
  };

  // Ack bookkeeping only: was this key already in the per-tenant registry?
  // The pipeline replays the stored response verbatim either way; this read
  // merely decides `applied` vs `duplicate` in the ack. Runs under the
  // VERIFIED tenant's RLS context, so tenant B never observes tenant A's keys.
  const seen = await ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
    const r = await tx.query<{ hit: number }>(
      `select 1 as hit from app.write_log where id = $1`,
      [key],
    );
    return r.rows.length > 0;
  });

  try {
    // One transaction per op (runIdempotent: marker + effect commit
    // atomically); a throw rolls back that op alone — the batch continues.
    const result = await invoke(caller, input);
    const status: UploadAckStatus = seen ? 'duplicate' : 'applied';
    return RESULT_OPS.has(op.kind) ? { key, status, result } : { key, status };
  } catch (err) {
    return { key, status: 'rejected', reason: reasonFrom(err) };
  }
}

// ---------------------------------------------------------------------------
// GET /sync/token
// ---------------------------------------------------------------------------

export interface SyncRouteOptions {
  /** HS256 secret the PowerSync service's client_auth validates. Defaults to
   *  the API jwtSecret — ONE dev secret (DEV_JWT_SECRET) shared by both, per
   *  the infra contract. Real secrets are env-supplied, never committed. */
  powersyncSecret?: string;
  /** PowerSync service endpoint handed to the client connector. */
  powersyncUrl?: string;
  /** Client-token lifetime in seconds. Short-lived: ≤ 5 min is PowerSync's norm. */
  tokenTtlSeconds?: number;
}

const DEFAULT_POWERSYNC_URL = 'http://localhost:8080';
const DEFAULT_TOKEN_TTL_S = 300;

const encoder = new TextEncoder();

export async function registerSyncRoutes(
  app: FastifyInstance,
  opts: ContextOptions & { sync?: SyncRouteOptions | undefined },
): Promise<void> {
  app.post('/sync/upload', async (req, reply) => {
    const ctx = await createContextFromHeader(opts, req.headers.authorization);
    if (!ctx.identity) {
      return reply.code(401).send({ error: 'UNAUTHORIZED: missing or invalid bearer token' });
    }
    const parsed = uploadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      // A malformed ENVELOPE refuses the whole batch, applying nothing —
      // per-op tolerance is for op-level failures, not an unreadable request.
      return reply.code(400).send({
        error: 'BAD_REQUEST: malformed upload batch',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const identityCtx = { ...ctx, identity: ctx.identity };
    const caller = makeCaller(identityCtx);
    const acks: UploadAck[] = [];
    // Sequential, in order: the outbox is an ordered queue (§3.3).
    for (const op of parsed.data.ops) {
      acks.push(await applyOne(identityCtx, caller, op));
    }
    return reply.code(200).send({ acks });
  });

  app.get('/sync/token', async (req, reply) => {
    const ctx = await createContextFromHeader(opts, req.headers.authorization);
    if (!ctx.identity) {
      return reply.code(401).send({ error: 'UNAUTHORIZED: missing or invalid bearer token' });
    }
    const identity = ctx.identity;
    const secret = opts.sync?.powersyncSecret ?? opts.jwtSecret;
    const endpoint = opts.sync?.powersyncUrl ?? DEFAULT_POWERSYNC_URL;
    const ttlS = opts.sync?.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_S;
    const nowS = Math.floor(Date.now() / 1000);
    const expS = nowS + ttlS;

    // tid comes from the VERIFIED session identity — there is deliberately
    // no input (body, query, header) that can influence it. location_id is
    // the interim location-scope claim (sync_rules.yaml): the user's first
    // scoped location, set server-side; no scope → no claim → no location
    // bucket → zero rows (fail closed).
    const firstLocation = identity.locationIds[0];
    const token = await new SignJWT({
      tid: identity.tenantId,
      ...(firstLocation !== undefined ? { location_id: firstLocation } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(identity.userId)
      .setAudience('powersync')
      .setIssuedAt(nowS)
      .setExpirationTime(expS)
      .sign(encoder.encode(secret));

    // TYPED AS THE CONTRACT the PWA parses (`@erp/contracts` sync-token.ts).
    // Renaming a key here without renaming it there used to be a silent,
    // fleet-wide loss of the download path; now it is a compile error.
    const body: SyncTokenResponse = {
      token,
      expires_at: new Date(expS * 1000).toISOString(),
      endpoint,
    };
    return reply.code(200).send(body);
  });
}
