/**
 * RAW device-file inspection for D5 — deliberately NOT through the PowerSync
 * client. We open the device's sqlite file with node's built-in sqlite
 * driver and read the physical storage tables (ps_data__<type>, plus
 * ps_untyped if the service ever delivered a type outside the schema), so
 * the isolation assertion is against what is actually ON DISK, not against
 * a view a schema might be hiding rows from.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';

export interface RawTableCount {
  clientTable: string;
  rows: number;
}

export class RawDeviceDb {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  /** Every physical PowerSync data table in the file. */
  dataTables(): string[] {
    const rows = this.db
      .prepare(
        `select name from sqlite_master
          where type = 'table' and (name like 'ps_data__%' or name like 'ps_data_local__%' or name = 'ps_untyped')
          order by name`,
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  countRows(physicalTable: string): number {
    const r = this.db.prepare(`select count(*) as n from "${physicalTable}"`).get() as { n: number };
    return r.n;
  }

  /** Rows in a synced data table whose JSON tenant_id equals `tenantId`. */
  countTenantRows(physicalTable: string, tenantId: string): number {
    const r = this.db
      .prepare(
        `select count(*) as n from "${physicalTable}"
          where json_extract(data, '$.tenant_id') = ?`,
      )
      .get(tenantId) as { n: number };
    return r.n;
  }

  /** The bluntest possible leak check: ANY occurrence of the other tenant's
   *  uuid anywhere in any stored row (data blob or id), any table. */
  countUuidMentions(physicalTable: string, uuid: string): number {
    const r = this.db
      .prepare(
        `select count(*) as n from "${physicalTable}"
          where (data like '%' || ? || '%') or (id like '%' || ? || '%')`,
      )
      .get(uuid, uuid) as { n: number };
    return r.n;
  }

  /** Any occurrence of an arbitrary marker string in a stored row. Used for
   *  a customer NAME and for the decimal string of a BALANCE — the two things
   *  a leak would carry that a tenant_id column would not. */
  countTextMentions(physicalTable: string, needle: string): number {
    const r = this.db
      .prepare(
        `select count(*) as n from "${physicalTable}"
          where (data like '%' || ? || '%') or (id like '%' || ? || '%')`,
      )
      .get(needle, needle) as { n: number };
    return r.n;
  }

  /** Every distinct value of a JSON field across a table — so an assertion can
   *  name exactly WHICH locations/tenants a device holds, not merely how many. */
  distinctJson(physicalTable: string, field: string): string[] {
    const rows = this.db
      .prepare(
        `select distinct json_extract(data, '$.' || ?) as v from "${physicalTable}"
          where json_extract(data, '$.' || ?) is not null order by 1`,
      )
      .all(field, field) as { v: string }[];
    return rows.map((r) => r.v);
  }

  jsonValues(physicalTable: string, field: string): string[] {
    const rows = this.db
      .prepare(`select json_extract(data, '$.' || ?) as v from "${physicalTable}"`)
      .all(field) as { v: string | null }[];
    return rows.map((r) => r.v ?? '');
  }

  close(): void {
    this.db.close();
  }
}

/**
 * THE FILE, NOT THE TABLE (credit-offline-plan R5.2).
 *
 * A row deleted from a sqlite table can still sit in a freed page, and the
 * `-wal` sidecar holds frames the main file has not checkpointed. Reading the
 * bytes of every file the device owns is the only check that covers both, and
 * it is deliberately blunt: no SQL, no schema, no chance of a view hiding it.
 *
 * Returns the number of BYTE occurrences of `marker` across all of them.
 */
export function grepDeviceFiles(dbPath: string, marker: string): number {
  const needle = Buffer.from(marker, 'utf8');
  let hits = 0;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `${dbPath}${suffix}`;
    if (!existsSync(path)) continue;
    const buf = readFileSync(path);
    let from = 0;
    for (;;) {
      const at = buf.indexOf(needle, from);
      if (at === -1) break;
      hits += 1;
      from = at + 1;
    }
  }
  return hits;
}

/** ps_data__product → product */
export function clientTableOf(physical: string): string {
  return physical.replace(/^ps_data_local__/, '').replace(/^ps_data__/, '');
}
