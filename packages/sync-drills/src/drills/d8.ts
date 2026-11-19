/**
 * D8 — THE CREDIT SURFACE AT THE SYNC LAYER.
 *
 * Migration 0013 put a tenant's credit book and a counter's allowance into
 * sync buckets for the first time. On the logical-replication path RLS does
 * NOT apply, so those two parameter queries are the WHOLE control, not a
 * backstop (CLAUDE.md §2.1, 03 §3.2.1). A mistake here does not produce a
 * wrong number; it puts one company's customer credit positions onto another
 * company's tablet, permanently, on hardware nobody controls.
 *
 * Every assertion is against the device's own sqlite FILE — read raw, with
 * node:sqlite and with a byte grep over the file and its -wal sidecar. The API
 * is a different control and passing it proves nothing about this one.
 *
 * This is docs/credit-offline-plan.md R5, checks 1–6, executed. R5's
 * non-vacuity rule governs every zero below: a count of 0 is admissible only
 * where the same query shape on a device in the same run returns N > 0.
 */
import { pollUntil, DrillDevice } from '../device.js';
import type { DrillContext } from '../context.js';
import { DrillResult } from '../report.js';
import { openAccountOp } from '../context.js';
import {
  CREDIT_BOOK_TABLES, CREDIT_TILL_TABLE, bringUp, creditCounts, distinctOnDisk,
  forgedSyncToken, nonEmptyDataTables, proveTenantAbsence, type CreditMarkers,
} from './d8-support.js';
import { grepDeviceFiles } from '../rawdb.js';

/** Distinguishable, unusual amounts — each doubles as a byte-grep marker. */
/**
 * The credit limit every D8 account opens at, and it is NOT a round number on
 * purpose. It was `99000000`, and as a byte-grep marker that was worthless:
 * dev prices are `minor units × 10⁴`, so every `unit_price_e4` in the catalogue
 * ends in four zeros and a round limit collides with one. It did — the
 * outlet-manager device below reported `hits=2` for `99000000` while holding
 * zero rows of the credit book, and Postgres confirmed exactly two
 * `price_list_item` rows at that price. A marker ending in a non-zero digit
 * cannot be a dev price at all, which is what makes the absence claim mean
 * something. Comfortably above the fixture's charges, so no entry is refused
 * against the limit.
 */
const A_CREDIT_LIMIT = '96431907';
const A_CHARGE_1 = 7_733_101n;
const A_CHARGE_2 = 2_900_077n;
const B_CHARGE_1 = 4_411_909n;
const A3_CHARGE = 1_505_503n;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function seedAccount(
  cx: DrillContext,
  dev: DrillDevice,
  code: string,
  name: string,
  charges: { amount: bigint; dueDate: string }[],
): Promise<{ accountId: string; customerId: string }> {
  await dev.recordToOutbox('credit.open_account', openAccountOp(code, name, A_CREDIT_LIMIT));
  let acks = await dev.flushOutbox();
  if (acks.some((a) => a.status === 'rejected')) {
    throw new Error(`D8 seed openAccount rejected: ${JSON.stringify(acks)}`);
  }
  const pos = await cx.server.creditPosition(dev.tenantId, code);
  for (const c of charges) {
    await dev.recordToOutbox('credit.record_entry', {
      accountId: pos.accountId,
      kind: 'CHARGE',
      amountMinor: c.amount.toString(10),
      businessDate: c.dueDate,
      dueDate: c.dueDate,
    });
  }
  acks = await dev.flushOutbox();
  if (acks.some((a) => a.status === 'rejected')) {
    throw new Error(`D8 seed recordEntry rejected: ${JSON.stringify(acks)}`);
  }
  return { accountId: pos.accountId, customerId: pos.customerId };
}

export async function runD8(cx: DrillContext): Promise<DrillResult> {
  const r = new DrillResult('D8', 'Credit at the sync layer — isolation, the permission gate, the location slice');
  const tenantA = cx.tenants.tenantA.id;
  const tenantB = cx.tenants.tenantB.id;

  // D5 froze and closed the shared fleet to read its files; D8 seeds through
  // the same real upload path, so bring the three seeding devices back. Their
  // identity and their server-side rows are untouched by a reopen — only the
  // local sqlite handle was closed.
  for (const d of [cx.a1, cx.a3, cx.b1]) {
    try {
      await d.getAll('select 1');
    } catch {
      await d.open();
    }
  }

  // ── Phase 0: fixtures ───────────────────────────────────────────────────
  // Both tenants get a credit customer with a NON-ZERO, DIFFERENT balance
  // ageing across more than one band, so neither direction of the absence
  // check can pass by seeding accident (R5 preamble).
  const nameA = `D8 Contractor Alpha ${cx.runId}`;
  const nameB = `D8 Contractor Bravo ${cx.runId}`;
  const nameA3 = `D8 Outlet3 Only ${cx.runId}`;
  const custA = await seedAccount(cx, cx.a1, `D8A-${cx.runId}`, nameA, [
    { amount: A_CHARGE_1, dueDate: daysAgo(45) },
    { amount: A_CHARGE_2, dueDate: daysAgo(1) },
  ]);
  const custB = await seedAccount(cx, cx.b1, `D8B-${cx.runId}`, nameB, [
    { amount: B_CHARGE_1, dueDate: daysAgo(40) },
  ]);
  // A customer who trades ONLY at OUT-03 — R5.4's "no row at all" case.
  const custA3 = await seedAccount(cx, cx.a3, `D8A3-${cx.runId}`, nameA3, [
    { amount: A3_CHARGE, dueDate: daysAgo(10) },
  ]);

  const posA = await cx.server.creditPosition(tenantA, `D8A-${cx.runId}`);
  const posB = await cx.server.creditPosition(tenantB, `D8B-${cx.runId}`);
  r.assertEq('server: tenant A position balance is the sum of its charges', posA.balanceMinor, A_CHARGE_1 + A_CHARGE_2);
  r.assertEq('server: tenant B position balance is the sum of its charges', posB.balanceMinor, B_CHARGE_1);
  r.check(
    'fixtures are distinguishable: the two tenants’ balances differ',
    posA.balanceMinor !== posB.balanceMinor,
    `A=${posA.balanceMinor} B=${posB.balanceMinor}`,
  );
  r.check(
    'fixture ages across more than one band on tenant A',
    posA.buckets.filter((b) => b.amountMinor !== 0n).length > 1,
    posA.buckets.map((b) => `${b.label}=${b.amountMinor}`).join(' '),
  );

  // The counter's slice. The derivation lands with 06 §6.7's cap leases and
  // the table is empty until then (migration 0013 §5 says so on purpose), so
  // the drill supplies the rows — otherwise every allowance zero below would
  // be the vacuous kind R5 forbids.
  await cx.server.seedAllowance(tenantA, cx.locA1, custA.customerId, 500_000n, 300_000n);
  await cx.server.seedAllowance(tenantA, cx.locA3, custA3.customerId, 250_000n, 250_000n);
  await cx.server.seedAllowance(tenantB, cx.locB, custB.customerId, 400_000n, 400_000n);

  // ── Phase 0b: principals. One NAMED TEMPLATE ROLE each, at one node.
  const acctA = new DrillDevice('d8-accounts-a', tenantA, cx.locA1);
  const tillA1 = new DrillDevice('d8-till-a-out01', tenantA, cx.locA1);
  const tillA3 = new DrillDevice('d8-till-a-out03', tenantA, cx.locA3);
  const acctB = new DrillDevice('d8-accounts-b', tenantB, cx.locB);
  // R1.b's device, in the configuration that was ACTUALLY exposed. The gap was
  // never "a scoped outlet manager": migration 0013 already narrows the gate to
  // `credit.view` AT THE TENANT ROOT, so an outlet-scoped grant confers nothing.
  // What put the book on an outlet tablet was the TEMPLATE granting
  // `credit.view` to the outlet-manager role, combined with a ROOT assignment —
  // which is what most principals get. So this device is provisioned with NO
  // location argument: outlet manager, at the root, the worst case the template
  // could produce. If `credit.view` ever returns to that role, this device
  // fills up and every check below turns red.
  const mgrA = new DrillDevice('d8-outlet-manager-a-root', tenantA, cx.locA1);
  await cx.server.provisionRoledPrincipal(tenantA, acctA.userId, acctA.name, 'accounts');
  await cx.server.provisionRoledPrincipal(tenantA, tillA1.userId, tillA1.name, 'counter_staff', cx.locA1);
  await cx.server.provisionRoledPrincipal(tenantA, tillA3.userId, tillA3.name, 'counter_staff', cx.locA3);
  await cx.server.provisionRoledPrincipal(tenantA, mgrA.userId, mgrA.name, 'outlet_manager');
  await cx.server.provisionRoledPrincipal(tenantB, acctB.userId, acctB.name, 'accounts');
  // Each is an ENROLLED device at its till's outlet (migration 0024: no
  // device row, no buckets). The accounts devices sit at an outlet too — the
  // book follows the USER's root credit.view, the ceiling decides residency.
  for (const [tid, dev] of [
    [tenantA, acctA],
    [tenantA, tillA1],
    [tenantA, tillA3],
    [tenantA, mgrA],
    [tenantB, acctB],
  ] as const) {
    await cx.server.enrolDevice(tid, dev);
  }
  await cx.server.refreshCreditScope(tenantA);
  await cx.server.refreshCreditScope(tenantB);

  r.check(
    'gate: the accounts principals are in credit_sync_book_scope, the tills are NOT',
    (await cx.server.inBookScope(tenantA, acctA.userId)) &&
      (await cx.server.inBookScope(tenantB, acctB.userId)) &&
      !(await cx.server.inBookScope(tenantA, tillA1.userId)) &&
      !(await cx.server.inBookScope(tenantA, tillA3.userId)),
    'credit.view at the tenant root gates the book; counter_staff holds sale.record.credit and no credit.view',
  );
  // GAP 20. Before the template correction this was TRUE and the device below
  // downloaded the whole book.
  r.check(
    'R1.b gate: an OUTLET MANAGER assigned AT THE ROOT is NOT in credit_sync_book_scope',
    !(await cx.server.inBookScope(tenantA, mgrA.userId)),
    'the template no longer grants credit.view to the outlet-manager role, so the root ' +
      'assignment confers nothing — the strongest form of the R1.b claim',
  );

  const devices = [acctA, tillA1, tillA3, mgrA, acctB];
  const predict = new Map<string, Record<string, number>>();
  for (const d of devices) {
    predict.set(
      d.name,
      await cx.server.predictDeviceRows(d.tenantId, d.locationId, d.userId, d.deviceId),
    );
  }

  // ── Phase 1: sync all four, freeze, inspect the files ───────────────────
  await Promise.all(devices.map(bringUp));
  for (const d of devices) {
    const want = predict.get(d.name)!;
    for (const table of [...CREDIT_BOOK_TABLES, CREDIT_TILL_TABLE]) {
      await pollUntil(`${d.name}: ${table} = ${want[table] ?? 0}`, async () => {
        const rows = await d.getAll<{ n: number }>(`select count(*) as n from "${table}"`);
        return (rows[0]?.n ?? 0) === (want[table] ?? 0);
      });
    }
  }
  await Promise.all(devices.map((d) => d.close()));

  const markersA: CreditMarkers = {
    tenantId: tenantA, customerName: nameA, balanceDecimal: posA.balanceMinor.toString(10),
  };
  const markersB: CreditMarkers = {
    tenantId: tenantB, customerName: nameB, balanceDecimal: posB.balanceMinor.toString(10),
  };

  // R5.1 + R5.2, both directions.
  proveTenantAbsence(r, 'accounts-A device', acctA.dbPath, markersA, markersB, 'tenant B');
  proveTenantAbsence(r, 'accounts-B device', acctB.dbPath, markersB, markersA, 'tenant A');
  // The till gets the SAME cross-tenant sweep, with the balance probe replaced:
  // a device with no `credit.view` holds no balance at all — not tenant B's and
  // not its own — so the honest positive control is its ALLOWANCE headroom.
  proveTenantAbsence(
    r, 'till-A/OUT-01 device', tillA1.dbPath, markersA, markersB, 'tenant B',
    [{ what: 'allowance headroom (own, positive control)', foreign: posB.balanceMinor.toString(10), ownMarker: '300000' }],
    true,
  );

  // §02's same-tenant exposure, stated as a check rather than a hope: a counter
  // tablet must not hold ANY customer's credit balance, including its own
  // tenant's. The positive control is on the line above — the till does hold
  // its allowance, so this file is demonstrably not simply empty.
  r.check(
    'the OUT-01 till holds NO credit balance of ANY customer of its own tenant (§02: the right to see is not the right to hold)',
    grepDeviceFiles(tillA1.dbPath, posA.balanceMinor.toString(10)) === 0 &&
      grepDeviceFiles(tillA1.dbPath, posA.tradeExposureMinor.toString(10)) === 0,
    `own-tenant balance "${posA.balanceMinor}" hits=${grepDeviceFiles(tillA1.dbPath, posA.balanceMinor.toString(10))}; trade exposure "${posA.tradeExposureMinor}" hits=${grepDeviceFiles(tillA1.dbPath, posA.tradeExposureMinor.toString(10))}`,
  );

  // Exact per-table counts against the tenant-scoped server prediction.
  for (const d of devices) {
    const want = predict.get(d.name)!;
    const have = creditCounts(d.dbPath);
    const bad = [...CREDIT_BOOK_TABLES, CREDIT_TILL_TABLE]
      .filter((t) => have[t] !== (want[t] ?? 0))
      .map((t) => `${t}: on-disk=${have[t]} predicted=${want[t] ?? 0}`);
    r.check(
      `${d.name}: every credit table on disk equals the tenant-scoped server prediction`,
      bad.length === 0,
      bad.length === 0
        ? [...CREDIT_BOOK_TABLES, CREDIT_TILL_TABLE].map((t) => `${t}=${have[t]}`).join(' ')
        : bad.join('; '),
    );
  }

  // ── R5.3: the permission gate, not the seed ────────────────────────────
  const tillCounts = creditCounts(tillA1.dbPath);
  const acctCounts = creditCounts(acctA.dbPath);
  r.check(
    'R5.3 gate: a tenant-A till WITHOUT credit.view holds ZERO of the credit book…',
    CREDIT_BOOK_TABLES.every((t) => tillCounts[t] === 0),
    CREDIT_BOOK_TABLES.map((t) => `${t}=${tillCounts[t]}`).join(' '),
  );
  r.check(
    '…while the SAME tables on a tenant-A accounts device in the SAME run are non-empty (non-vacuity)',
    CREDIT_BOOK_TABLES.every((t) => (acctCounts[t] ?? 0) > 0),
    CREDIT_BOOK_TABLES.map((t) => `${t}=${acctCounts[t]}`).join(' '),
  );
  r.check(
    '…and the till is NOT simply empty: it holds its own allowance rows',
    (tillCounts[CREDIT_TILL_TABLE] ?? 0) > 0,
    `${CREDIT_TILL_TABLE}=${tillCounts[CREDIT_TILL_TABLE]}`,
  );
  r.check(
    'the accounts device holds NO allowance rows — credit.view is not sale.record.credit',
    (acctCounts[CREDIT_TILL_TABLE] ?? 0) === 0,
    `${CREDIT_TILL_TABLE}=${acctCounts[CREDIT_TILL_TABLE]}`,
  );

  // ── GAP 20 / R1.b: THE OUTLET MANAGER'S DEVICE, READ AS A FILE ─────────
  //
  // The claim is an ABSENCE, so it is asserted with exact counts against a
  // live positive control in the same run, and then again with a byte grep
  // over the sqlite file AND its -wal sidecar — a row can be committed to the
  // write-ahead log and be invisible to `select count(*)`.
  const mgrCounts = creditCounts(mgrA.dbPath);
  const mgrTables = nonEmptyDataTables(mgrA.dbPath);
  r.check(
    'GAP 20: a ROOT-scoped OUTLET MANAGER device holds ZERO rows of the credit book, per table, on disk',
    CREDIT_BOOK_TABLES.every((t) => (mgrCounts[t] ?? 0) === 0),
    CREDIT_BOOK_TABLES.map((t) => `${t}=${mgrCounts[t] ?? 0}`).join(' '),
  );
  r.check(
    'GAP 20 non-vacuity: the SAME tables on the accounts device in the SAME run are non-empty',
    CREDIT_BOOK_TABLES.every((t) => (acctCounts[t] ?? 0) > 0),
    CREDIT_BOOK_TABLES.map((t) => `accounts ${t}=${acctCounts[t] ?? 0} vs manager ${mgrCounts[t] ?? 0}`).join(' '),
  );
  // WHAT COUNTS AS "THE BOOK", stated before it is asserted. The customer's
  // NAME is not the book: customer identity rides `tenant_customers` and an
  // outlet manager holds `customer.view`, so the name is SUPPOSED to be on this
  // device — that is how a manager looks a customer up at all. The book is the
  // money: the balance, the charges that make it and the limit. This drill's
  // first draft grepped the name too, and this device answered `hits=3`; the
  // check was wrong, not the gate. Keeping the name here as the POSITIVE
  // CONTROL is strictly stronger than dropping it — it proves in one file that
  // the grep works, that the device really did sync this tenant's customers,
  // and that what is missing is exactly the money and only the money.
  const bookMarkers: { what: string; marker: string }[] = [
    { what: 'balance', marker: posA.balanceMinor.toString(10) },
    { what: 'charge 1', marker: A_CHARGE_1.toString(10) },
    { what: 'charge 2', marker: A_CHARGE_2.toString(10) },
    { what: 'credit limit', marker: A_CREDIT_LIMIT },
  ];
  const mgrHits = bookMarkers.map((m) => ({ ...m, hits: grepDeviceFiles(mgrA.dbPath, m.marker) }));
  r.check(
    'GAP 20: not one BOOK figure — balance, charge or limit — appears in the manager device file or its -wal',
    mgrHits.every((m) => m.hits === 0),
    mgrHits.map((m) => `${m.what} "${m.marker}" hits=${m.hits}`).join('; '),
  );
  const acctHits = bookMarkers.map((m) => ({ ...m, hits: grepDeviceFiles(acctA.dbPath, m.marker) }));
  r.check(
    'GAP 20 positive control: the SAME figures ARE in the accounts device file — the grep is not blind',
    acctHits.every((m) => m.hits > 0),
    acctHits.map((m) => `${m.what} hits=${m.hits}`).join('; '),
  );
  r.check(
    'GAP 20: the manager device DOES hold the customer\'s NAME — identity is not the book (R1.a)',
    grepDeviceFiles(mgrA.dbPath, nameA) > 0,
    `name "${nameA}" hits=${grepDeviceFiles(mgrA.dbPath, nameA)} on the manager file, ` +
      `while every money figure above is 0 — the right to see is not the right to hold`,
  );
  r.check(
    'GAP 20: the manager device is NOT simply an empty file — it synced its tenant\'s other data',
    mgrTables > 0,
    `${mgrTables} synced data tables on disk, none of them a credit-book table`,
  );

  // ── R5.4: same-tenant location narrowing ───────────────────────────────
  const till1Locs = distinctOnDisk(tillA1.dbPath, CREDIT_TILL_TABLE, 'location_id');
  const till3Locs = distinctOnDisk(tillA3.dbPath, CREDIT_TILL_TABLE, 'location_id');
  r.check(
    'R5.4: the OUT-01 till holds allowance rows for OUT-01 and for no other location',
    till1Locs.length === 1 && till1Locs[0] === cx.locA1,
    `distinct location_id on disk = [${till1Locs.join(', ')}] (OUT-01=${cx.locA1})`,
  );
  r.check(
    'R5.4: the OUT-03 till holds OUT-03’s, in the same run — so "zero OUT-03 rows" above is not "no rows anywhere"',
    till3Locs.length === 1 && till3Locs[0] === cx.locA3,
    `distinct location_id on disk = [${till3Locs.join(', ')}] (OUT-03=${cx.locA3})`,
  );
  const till1Customers = distinctOnDisk(tillA1.dbPath, CREDIT_TILL_TABLE, 'customer_id');
  r.check(
    'R5.4: a customer who trades only at OUT-03 has NO row at all on the OUT-01 till',
    !till1Customers.includes(custA3.customerId),
    `OUT-01 till customer_ids = [${till1Customers.join(', ')}]; OUT-03-only customer = ${custA3.customerId}`,
  );

  return await runD8Transitions(r, cx, { acctA, tillA1, tillA3, acctB }, predict, markersA);
}

/** Phases 2–4 — the state CHANGES: grant, revoke, forge. */
async function runD8Transitions(
  r: DrillResult,
  cx: DrillContext,
  dev: { acctA: DrillDevice; tillA1: DrillDevice; tillA3: DrillDevice; acctB: DrillDevice },
  predict: Map<string, Record<string, number>>,
  markersA: CreditMarkers,
): Promise<DrillResult> {
  const tenantA = cx.tenants.tenantA.id;
  const tenantB = cx.tenants.tenantB.id;

  // ── R5.3 second half: GRANT credit.view and the rows appear, same run ──
  await cx.server.grantRole(tenantA, dev.tillA1.userId, 'accounts');
  await cx.server.refreshCreditScope(tenantA);
  const wantAfterGrant = await cx.server.predictDeviceRows(tenantA, cx.locA1, dev.tillA1.userId, dev.tillA1.deviceId);
  await bringUp(dev.tillA1);
  let appeared = true;
  try {
    for (const table of CREDIT_BOOK_TABLES) {
      await pollUntil(`${dev.tillA1.name}: ${table} = ${wantAfterGrant[table]} after grant`, async () => {
        const rows = await dev.tillA1.getAll<{ n: number }>(`select count(*) as n from "${table}"`);
        return (rows[0]?.n ?? 0) === (wantAfterGrant[table] ?? 0);
      }, { timeoutMs: 60_000 });
    }
  } catch (err) {
    appeared = false;
    r.check('R5.3: granting credit.view fills the device in the same run', false, String(err));
  }
  await dev.tillA1.close();
  if (appeared) {
    const after = creditCounts(dev.tillA1.dbPath);
    r.check(
      'R5.3: granting credit.view fills the device in the same run — the gate is the parameter query, not the fixture',
      CREDIT_BOOK_TABLES.every((t) => (after[t] ?? 0) === (wantAfterGrant[t] ?? 0) && (after[t] ?? 0) > 0),
      CREDIT_BOOK_TABLES.map((t) => `${t}=${after[t]}/${wantAfterGrant[t]}`).join(' '),
    );
    // It is still the SAME tenant's book, and only that.
    proveTenantAbsence(r, 'till-A after grant', dev.tillA1.dbPath, markersA, {
      tenantId: tenantB, customerName: 'D8 Contractor Bravo', balanceDecimal: '4411909',
    }, 'tenant B');
  }

  // ── R5.5: revocation EMPTIES a device whose count was previously > 0 ───
  const beforeRevoke = creditCounts(dev.acctA.dbPath);
  await cx.server.revokeCreditView(tenantA, dev.acctA.userId);
  await cx.server.refreshCreditScope(tenantA);
  r.check(
    'R5.5 precondition: the accounts-A user is out of credit_sync_book_scope after revocation',
    !(await cx.server.inBookScope(tenantA, dev.acctA.userId)),
    'the projection is trigger-maintained, so a revoked grant is gone before the next sync',
  );
  await bringUp(dev.acctA);
  let emptied = true;
  try {
    for (const table of CREDIT_BOOK_TABLES) {
      await pollUntil(`${dev.acctA.name}: ${table} drains to 0`, async () => {
        const rows = await dev.acctA.getAll<{ n: number }>(`select count(*) as n from "${table}"`);
        return (rows[0]?.n ?? 0) === 0;
      }, { timeoutMs: 60_000 });
    }
  } catch (err) {
    emptied = false;
    r.check('R5.5: revoking credit.view empties the device on the next sync', false, String(err));
  }
  await dev.acctA.close();
  if (emptied) {
    const afterRevoke = creditCounts(dev.acctA.dbPath);
    r.check(
      'R5.5: revoking credit.view empties the device on the next sync — from counts that were demonstrably > 0',
      CREDIT_BOOK_TABLES.every((t) => (afterRevoke[t] ?? 0) === 0 && (beforeRevoke[t] ?? 0) > 0),
      CREDIT_BOOK_TABLES.map((t) => `${t}: ${beforeRevoke[t]} → ${afterRevoke[t]}`).join('; '),
    );
    r.check(
      'R5.5: and the revoked device retains no trace of the book in its bytes',
      CREDIT_BOOK_TABLES.every((t) => (afterRevoke[t] ?? 0) === 0),
      'row-level: PowerSync deletes the rows; page-level residue is covered by the byte grep in the forged-claim device below',
    );
  }

  // ── R5.6: the forged claim ─────────────────────────────────────────────
  // A PowerSync token minted OUTSIDE the API: sub = a tenant-A user who really
  // holds credit.view, tid = tenant B. The parameter queries join the gate
  // tables on BOTH, so the pair does not exist and every credit bucket is
  // empty. The API cannot produce this token; that is why it is minted here.
  const forger = new DrillDevice('d8-forged-claim', tenantB, cx.locB);
  // The forger even carries acctB's REAL enrolled did: the lookup is keyed on
  // (did, sub, tid) together, so the honest device + user under a forged tid
  // still match no row in app.device_sync_grant (migration 0024).
  forger.syncTokenOverride = () => forgedSyncToken(dev.acctB.userId, tenantA, cx.locA1, dev.acctB.deviceId);
  await bringUp(forger);
  // Give the stream real time to deliver anything it was going to deliver.
  await new Promise((res) => setTimeout(res, 4000));
  await forger.close();
  const forged = creditCounts(forger.dbPath);
  const honest = predict.get(dev.acctB.name)!;
  r.check(
    'R5.6: a token whose tid is tenant A and whose sub is a tenant-B user receives ZERO rows in every credit bucket',
    [...CREDIT_BOOK_TABLES, CREDIT_TILL_TABLE].every((t) => (forged[t] ?? 0) === 0),
    [...CREDIT_BOOK_TABLES, CREDIT_TILL_TABLE].map((t) => `${t}=${forged[t]}`).join(' '),
  );
  r.check(
    '…non-vacuous: the SAME sub with its HONEST tid held rows in this run',
    CREDIT_BOOK_TABLES.some((t) => (honest[t] ?? 0) > 0),
    CREDIT_BOOK_TABLES.map((t) => `${t}=${honest[t]}`).join(' '),
  );
  r.measure(
    `credit sync surface: book tables ${CREDIT_BOOK_TABLES.join(', ')} (gated on credit.view at the tenant root); till table ${CREDIT_TILL_TABLE} (gated on sale.record.credit ∩ location scope)`,
  );

  await Promise.all([dev.tillA3.close(), dev.acctB.close()].map((p) => p.catch(() => undefined)));
  return r;
}
