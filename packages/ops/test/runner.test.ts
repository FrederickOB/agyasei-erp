/**
 * The job runner: bookkeeping, mutual exclusion, the due-scheduler, and the
 * alert lifecycle — against real Postgres (PGlite) and migration 0029.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDb } from '@erp/db/testing';
import type { AlertNotification, AlertSink } from '../src/alerts.js';
import { webhookSink } from '../src/alerts.js';
import { silentLogger } from '../src/log.js';
import { defineJob, JobRegistry } from '../src/jobs/registry.js';
import { dueJobs, FAILURE_RETRY_SECONDS, runJob, type RunnerDeps } from '../src/jobs/runner.js';
import { memoryLocks, opsOf, setup, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;
let sent: AlertNotification[][];
let deps: RunnerDeps;
let locks: ReturnType<typeof memoryLocks>;

const sink: AlertSink = {
  async send(batch) {
    sent.push([...batch]);
  },
};

beforeAll(async () => {
  db = await setup();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  sent = [];
  locks = memoryLocks();
  deps = {
    runner: db,
    ops: opsOf(db),
    locks,
    sink,
    log: silentLogger,
    runnerId: 'test-runner',
    build: 'test-build',
    alertRepeatMs: 4 * 3_600_000,
  };
  await db.asAdmin(async (tx) => {
    await tx.query('delete from platform.job_run');
    await tx.query('delete from platform.ops_alert');
  });
});

async function runs(name: string) {
  return db.asAdmin(async (tx) =>
    (
      await tx.query<{ status: string; summary: Record<string, unknown>; error: string | null; runner: string; build: string }>(
        `select status, summary, error, runner, build from platform.job_run where job_name = $1 order by started_at`,
        [name],
      )
    ).rows,
  );
}

describe('runJob', () => {
  it('records a successful run with its summary, runner and build', async () => {
    const job = defineJob({
      name: 'test.ok',
      description: 'ok',
      intervalSeconds: 60,
      async run(ctx) {
        return { summary: { tenants: (await ctx.tenants()).length } };
      },
    });
    const out = await runJob(job, deps);
    expect(out.status).toBe('succeeded');
    const rows = await runs('test.ok');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'succeeded', summary: { tenants: 2 }, runner: 'test-runner', build: 'test-build' });
  });

  it('a job that finds problems is degraded, not succeeded', async () => {
    const job = defineJob({ name: 'test.degraded', description: 'd', intervalSeconds: 60, run: async () => ({ degraded: true }) });
    expect((await runJob(job, deps)).status).toBe('degraded');
    expect((await runs('test.degraded'))[0]!.status).toBe('degraded');
  });

  it('a thrown job is recorded failed with a safe message, pages once, and resolves on the next success', async () => {
    let fail = true;
    const job = defineJob({
      name: 'test.flaky',
      description: 'f',
      intervalSeconds: 60,
      async run() {
        if (fail) {
          const err = new Error('relation "app.nope" does not exist\nDETAIL: secret row value') as Error & { code: string; detail: string };
          err.code = '42P01';
          err.detail = 'Key (receipt_no)=(TCH-RCT-000001) already exists';
          throw err;
        }
        return {};
      },
    });
    const out = await runJob(job, deps);
    expect(out.status).toBe('failed');
    const row = (await runs('test.flaky'))[0]!;
    expect(row.status).toBe('failed');
    // SQLSTATE and the first line of the message only — never DETAIL.
    expect(row.error).toBe('42P01: relation "app.nope" does not exist');
    expect(row.error).not.toContain('TCH-RCT');
    expect(sent.flat().map((n) => [n.state, n.kind])).toEqual([['firing', 'job_failed']]);

    fail = false;
    sent = [];
    expect((await runJob(job, deps)).status).toBe('succeeded');
    expect(sent.flat().map((n) => [n.state, n.kind])).toEqual([['resolved', 'job_failed']]);
  });

  it('skips without a record when another runner holds the job lock', async () => {
    const job = defineJob({ name: 'test.locked', description: 'l', intervalSeconds: 60, run: async () => ({}) });
    locks.held.add('job:test.locked');
    expect((await runJob(job, deps)).status).toBe('skipped_locked');
    expect(await runs('test.locked')).toHaveLength(0);
  });

  it("closes a dead runner's 'running' row as abandoned before running again", async () => {
    await db.asAdmin((tx) =>
      tx.query(`insert into platform.job_run (id, job_name, status, runner) values (gen_random_uuid(), 'test.abandon', 'running', 'dead')`),
    );
    const job = defineJob({ name: 'test.abandon', description: 'a', intervalSeconds: 60, run: async () => ({}) });
    await runJob(job, deps);
    expect((await runs('test.abandon')).map((r) => r.status)).toEqual(['abandoned', 'succeeded']);
  });

  it('gives each job only the RLS door to tenant data: a tenant sees its own rows and nobody else’s', async () => {
    const job = defineJob({
      name: 'test.isolation',
      description: 'i',
      intervalSeconds: 60,
      async run(ctx) {
        const seen: Record<string, string[]> = {};
        for (const t of await ctx.tenants()) {
          seen[t] = await ctx.runner.withTenant(t, async (tx) =>
            (await tx.query<{ tenant_id: string }>(`select distinct tenant_id::text from app.write_log`)).rows.map((r) => r.tenant_id),
          );
        }
        return { summary: seen };
      },
    });
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(`insert into app.write_log (tenant_id, id, origin, hlc, op, request_hash)
                values ($1, gen_random_uuid(), 'SERVER', '0000000000001-00000-00000000000000000000000000000001', 'x', '\\x00')`, [TENANT_A]),
    );
    await runJob(job, deps);
    const summary = (await runs('test.isolation'))[0]!.summary as Record<string, string[]>;
    expect(summary[TENANT_A]).toEqual([TENANT_A]);
    expect(summary[TENANT_B]).toEqual([]);
  });
});

describe('dueJobs', () => {
  const reg = () =>
    new JobRegistry()
      .register(defineJob({ name: 'due.hourly', description: 'h', intervalSeconds: 3600, run: async () => ({}) }))
      .register(defineJob({ name: 'due.daily', description: 'd', intervalSeconds: 86_400, run: async () => ({}) }));

  async function seedRun(name: string, status: string, ageSeconds: number) {
    await db.asAdmin((tx) =>
      tx.query(
        `insert into platform.job_run (id, job_name, status, runner, started_at, finished_at)
         values (gen_random_uuid(), $1, $2, 'seed', now() - make_interval(secs => $3),
                 case when $2 = 'running' then null else now() - make_interval(secs => $3) end)`,
        [name, status, ageSeconds],
      ),
    );
  }

  it('a job that never ran is due', async () => {
    expect((await dueJobs(reg(), opsOf(db), new Date())).map((d) => d.name)).toEqual(['due.daily', 'due.hourly']);
  });

  it('a job is due once its interval has passed since the last attempt', async () => {
    await seedRun('due.hourly', 'succeeded', 1800);
    await seedRun('due.daily', 'succeeded', 90_000);
    expect((await dueJobs(reg(), opsOf(db), new Date())).map((d) => d.name)).toEqual(['due.daily']);
  });

  it('a failed job is retried sooner than its interval', async () => {
    await seedRun('due.daily', 'failed', FAILURE_RETRY_SECONDS + 5);
    await seedRun('due.hourly', 'succeeded', 10);
    expect((await dueJobs(reg(), opsOf(db), new Date())).map((d) => d.name)).toEqual(['due.daily']);
  });

  it('defineJob refuses a bad name or a sub-minute interval', () => {
    expect(() => defineJob({ name: 'Bad Name', description: '', intervalSeconds: 60, run: async () => ({}) })).toThrow();
    expect(() => defineJob({ name: 'ok.name', description: '', intervalSeconds: 5, run: async () => ({}) })).toThrow();
    expect(() => new JobRegistry().register(defineJob({ name: 'a.b', description: '', intervalSeconds: 60, run: async () => ({}) })).register(defineJob({ name: 'a.b', description: '', intervalSeconds: 60, run: async () => ({}) }))).toThrow(/already/);
  });
});

describe('alert lifecycle', () => {
  function alertingJob(current: () => { key: string; quiet?: boolean }[]) {
    return defineJob({
      name: 'test.alerts',
      description: 'a',
      intervalSeconds: 60,
      run: async () => ({
        alerts: current().map((c) => ({ key: c.key, kind: 'dark_device', severity: 'page' as const, summary: `device ${c.key}`, quiet: c.quiet })),
      }),
    });
  }

  it('pages once, stays silent while open, repeats after the repeat interval, and announces resolution', async () => {
    let current = [{ key: 'dark_device:a' }];
    const job = alertingJob(() => current);
    await runJob(job, deps);
    expect(sent.flat().map((n) => n.state)).toEqual(['firing']);

    sent = [];
    await runJob(job, deps);
    expect(sent).toEqual([]);

    await db.asAdmin((tx) => tx.query(`update platform.ops_alert set last_sent_at = now() - interval '5 hours'`));
    await runJob(job, deps);
    expect(sent.flat().map((n) => n.state)).toEqual(['repeat']);

    sent = [];
    current = [];
    await runJob(job, deps);
    expect(sent.flat().map((n) => [n.state, n.key])).toEqual([['resolved', 'dark_device:a']]);
  });

  it('a quiet alert stays open without paging, then pages when it stops being quiet', async () => {
    let quiet = true;
    const job = alertingJob(() => [{ key: 'dark_device:night', quiet }]);
    await runJob(job, deps);
    expect(sent).toEqual([]);
    const open = await db.asAdmin((tx) => tx.query<{ resolved_at: string | null }>(`select resolved_at from platform.ops_alert where key = 'dark_device:night'`));
    expect(open.rows[0]!.resolved_at).toBeNull();
    quiet = false;
    await runJob(job, deps);
    expect(sent.flat().map((n) => n.state)).toEqual(['firing']);
  });

  it('an undelivered alert is retried on the next evaluation', async () => {
    let fail = true;
    const flaky: AlertSink = {
      async send(batch) {
        if (fail) throw new Error('gateway down');
        sent.push([...batch]);
      },
    };
    const job = alertingJob(() => [{ key: 'dark_device:retry' }]);
    await runJob(job, { ...deps, sink: flaky });
    expect(sent).toEqual([]);
    fail = false;
    await runJob(job, { ...deps, sink: flaky });
    expect(sent.flat().map((n) => n.state)).toEqual(['firing']);
  });

  it('the webhook body carries ids and counts in text and structured form', async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    await webhookSink('https://hooks.invalid/x', { fetchImpl: fakeFetch, environment: 'prod' }).send([
      { state: 'firing', key: 'k', kind: 'dark_device', severity: 'page', tenantId: TENANT_A, summary: `tenant ${TENANT_A} device d: 5h`, source: 's', firstSeenAt: 'now' },
    ]);
    const parsed = JSON.parse(bodies[0]!) as { text: string; alerts: unknown[] };
    expect(parsed.text).toBe(`[prod] [PAGE] dark_device: tenant ${TENANT_A} device d: 5h`);
    expect(parsed.alerts).toHaveLength(1);
  });
});
