/**
 * §9.4 signals: trading-time arithmetic, the pure evaluator, and per-tenant
 * collection under RLS (a tenant's devices and queues are counted from inside
 * that tenant's boundary, never across it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from '@erp/db/testing';
import { collectSignals, evaluateSignals, type SignalSnapshot, type Thresholds } from '../src/monitoring/signals.js';
import { isTrading, parseTradingWindow, tradingMsBetween } from '../src/monitoring/trading-hours.js';
import { deviceWrite, opsOf, setup, TENANT_A, TENANT_B, uuidv7 } from './util.js';

const H = 3_600_000;
const window = parseTradingWindow('1-6', '07:00', '19:00');

const thresholds: Thresholds = {
  tradingWindow: window,
  darkAfterMs: 4 * H,
  reviewOverdueMs: 24 * H,
  reviewDepth: 25,
  postingExceptionAgeMs: 24 * H,
  slotRetainedBytes: 2n * 1024n * 1048576n,
  expectLogicalSlot: true,
  drillMaxAgeDays: 100,
  scratchMaxAgeHours: 72,
  jobStaleFactor: 3,
};

function snapshot(over: Partial<SignalSnapshot> = {}): SignalSnapshot {
  return {
    collectedAt: '2027-01-12T12:00:00.000Z',
    tenants: [TENANT_A],
    devices: [],
    reviewQueues: [],
    postingExceptions: [],
    slots: [{ slotName: 'powersync_1', slotType: 'logical', active: true, retainedBytes: '1024', lagBytes: '0' }],
    drill: { newestRanAt: '2027-01-01T00:00:00Z', undestroyedScratch: [] },
    jobs: [],
    failedTenants: [],
    watermarkTablePresent: false,
    ...over,
  };
}

describe('trading hours (location timezone, platform default window)', () => {
  it('parses day ranges and lists, and refuses nonsense', () => {
    expect(parseTradingWindow('1-6', '07:00', '19:00').days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseTradingWindow('1,3,5', '08:30', '17:00')).toMatchObject({ days: [1, 3, 5], openMinute: 510, closeMinute: 1020 });
    expect(() => parseTradingWindow('8', '07:00', '19:00')).toThrow();
    expect(() => parseTradingWindow('1-5', '19:00', '07:00')).toThrow();
    expect(() => parseTradingWindow('1-5', '7am', '19:00')).toThrow();
  });

  it('evaluates in the location’s own timezone', () => {
    // Tuesday 12 Jan 2027, 06:30 UTC: 06:30 in Accra (closed), 07:30 in Lagos (open).
    const t = new Date('2027-01-12T06:30:00Z');
    expect(isTrading(t, 'Africa/Accra', window)).toBe(false);
    expect(isTrading(t, 'Africa/Lagos', window)).toBe(true);
    // Sunday is not a trading day in this window.
    expect(isTrading(new Date('2027-01-10T12:00:00Z'), 'Africa/Accra', window)).toBe(false);
  });

  it('counts only trading time: Saturday close to Monday 08:00 is one trading hour', () => {
    const satClose = new Date('2027-01-09T19:00:00Z');
    const mon0800 = new Date('2027-01-11T08:00:00Z');
    expect(tradingMsBetween(satClose, mon0800, 'Africa/Accra', window)).toBe(H);
  });
});

describe('evaluateSignals', () => {
  const tue1500 = new Date('2027-01-12T15:00:00Z');

  it('pages for a device silent for more than the threshold of TRADING time', () => {
    const s = snapshot({
      devices: [
        { tenantId: TENANT_A, deviceId: 'd-dark', locationId: 'l1', timezone: 'Africa/Accra', lastWriteAt: '2027-01-12T09:00:00Z', writes24h: 3 },
        { tenantId: TENANT_A, deviceId: 'd-fine', locationId: 'l1', timezone: 'Africa/Accra', lastWriteAt: '2027-01-12T14:30:00Z', writes24h: 40 },
      ],
    });
    const alerts = evaluateSignals(s, thresholds, tue1500);
    const dark = alerts.filter((a) => a.kind === 'dark_device');
    expect(dark.map((a) => a.key)).toEqual([`dark_device:${TENANT_A}:d-dark`]);
    expect(dark[0]).toMatchObject({ severity: 'page', quiet: false, tenantId: TENANT_A });
  });

  it('a weekend is not an outage, and a still-dark device at night is quiet rather than resolved', () => {
    const monMorning = new Date('2027-01-11T09:00:00Z');
    const friEvening = snapshot({
      devices: [{ tenantId: TENANT_A, deviceId: 'd', locationId: 'l', timezone: 'Africa/Accra', lastWriteAt: '2027-01-09T18:30:00Z', writes24h: 0 }],
    });
    expect(evaluateSignals(friEvening, thresholds, monMorning).filter((a) => a.kind === 'dark_device')).toEqual([]);

    const night = new Date('2027-01-12T23:00:00Z');
    const s = snapshot({
      devices: [{ tenantId: TENANT_A, deviceId: 'd', locationId: 'l', timezone: 'Africa/Accra', lastWriteAt: '2027-01-12T08:00:00Z', writes24h: 1 }],
    });
    const [alert] = evaluateSignals(s, thresholds, night).filter((a) => a.kind === 'dark_device');
    expect(alert).toMatchObject({ quiet: true });
  });

  it('replication: a missing slot and retained WAL page; an inactive slot is a ticket', () => {
    expect(evaluateSignals(snapshot({ slots: [] }), thresholds, tue1500).map((a) => [a.kind, a.severity])).toContainEqual([
      'replication_slot_missing',
      'page',
    ]);
    const heavy = snapshot({
      slots: [{ slotName: 'ps', slotType: 'logical', active: false, retainedBytes: String(3n * 1024n * 1048576n), lagBytes: null }],
    });
    const kinds = evaluateSignals(heavy, thresholds, tue1500).map((a) => [a.kind, a.severity]);
    expect(kinds).toContainEqual(['replication_wal_retained', 'page']);
    expect(kinds).toContainEqual(['replication_slot_inactive', 'ticket']);
    expect(evaluateSignals(snapshot({ slots: [] }), { ...thresholds, expectLogicalSlot: false }, tue1500)).toEqual([]);
  });

  it('review queue: severity-1 pages; overdue and depth are tickets', () => {
    const s = snapshot({
      reviewQueues: [
        { tenantId: TENANT_A, open: 30, oldestOpenAt: '2027-01-10T00:00:00Z', overdue: 2, oldestOverdueAt: '2027-01-10T00:00:00Z', severity1Open: 1 },
        { tenantId: TENANT_B, open: 3, oldestOpenAt: '2027-01-12T14:00:00Z', overdue: 0, oldestOverdueAt: null, severity1Open: 0 },
      ],
    });
    const got = evaluateSignals(s, thresholds, tue1500).map((a) => [a.kind, a.severity, a.tenantId]);
    expect(got).toEqual(
      expect.arrayContaining([
        ['review_severity1', 'page', TENANT_A],
        ['review_overdue', 'ticket', TENANT_A],
        ['review_depth', 'ticket', TENANT_A],
      ]),
    );
    expect(got.some((g) => g[2] === TENANT_B)).toBe(false);
  });

  it('posting exceptions older than a day raise a ticket naming codes and counts only', () => {
    const s = snapshot({
      postingExceptions: [{ tenantId: TENANT_A, open: 4, oldestOpenAt: '2027-01-10T12:00:00Z', byCode: { GL_MAPPING_MISSING: 3, GL_NO_PERIOD: 1 } }],
    });
    const [a] = evaluateSignals(s, thresholds, tue1500).filter((x) => x.kind === 'posting_exceptions');
    expect(a!.summary).toContain('GL_MAPPING_MISSING=3 GL_NO_PERIOD=1');
  });

  it('drills: none recorded, too old, and a scratch copy left alive', () => {
    expect(evaluateSignals(snapshot({ drill: { newestRanAt: null, undestroyedScratch: [] } }), thresholds, tue1500).map((a) => a.kind)).toContain(
      'restore_drill_missing',
    );
    const s = snapshot({ drill: { newestRanAt: '2026-08-01T00:00:00Z', undestroyedScratch: [{ id: 'x', ranAt: '2027-01-08T00:00:00Z' }] } });
    const kinds = evaluateSignals(s, thresholds, tue1500).map((a) => [a.kind, a.severity]);
    expect(kinds).toContainEqual(['restore_drill_stale', 'ticket']);
    expect(kinds).toContainEqual(['scratch_alive', 'page']);
  });

  it('a job that has not succeeded for three intervals pages; the evaluating job is exempt', () => {
    const s = snapshot({
      jobs: [
        { name: 'ledger.posting_sweep', intervalSeconds: 3600, lastSuccessAt: '2027-01-12T10:00:00Z' },
        { name: 'ops.sync_health', intervalSeconds: 900, lastSuccessAt: '2027-01-11T00:00:00Z' },
        { name: 'never.ran', intervalSeconds: 3600, lastSuccessAt: null },
      ],
    });
    const got = evaluateSignals(s, { ...thresholds, selfJob: 'ops.sync_health' }, tue1500).filter((a) => a.kind === 'job_stale');
    expect(got.map((a) => a.key)).toEqual(['job_stale:ledger.posting_sweep']);
  });
});

describe('collectSignals (per tenant, under RLS)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await setup();
  });
  afterAll(async () => {
    await db.close();
  });

  it('attributes each device, queue and exception to its own tenant only', async () => {
    const devA = uuidv7();
    const devB = uuidv7();
    await db.withTenant(TENANT_A, async (tx) => {
      await deviceWrite(tx, TENANT_A, { deviceId: devA, receivedAt: new Date(Date.now() - 2 * H).toISOString() });
      await deviceWrite(tx, TENANT_A, { deviceId: devA });
    });
    await db.withTenant(TENANT_B, (tx) => deviceWrite(tx, TENANT_B, { deviceId: devB }));

    const s = await collectSignals({ runner: db, ops: opsOf(db), tenants: [TENANT_A, TENANT_B] });
    expect(s.failedTenants).toEqual([]);
    expect(s.devices.map((d) => [d.tenantId, d.deviceId, d.writes24h])).toEqual([
      [TENANT_A, devA, 2],
      [TENANT_B, devB, 1],
    ]);
    expect(s.reviewQueues.map((q) => [q.tenantId, q.open])).toEqual([
      [TENANT_A, 0],
      [TENANT_B, 0],
    ]);
    expect(s.watermarkTablePresent).toBe(false);
    expect(s.drill).toEqual({ newestRanAt: null, undestroyedScratch: [] });
  });

  it('a tenant id that matches nothing yields nothing, not another tenant’s rows', async () => {
    const s = await collectSignals({ runner: db, ops: opsOf(db), tenants: ['018f0000-0000-8000-8000-0000000000cc'] });
    expect(s.devices).toEqual([]);
  });
});
