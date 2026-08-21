/**
 * RAW device-file inspection for D5 — deliberately NOT through the PowerSync
 * client. We open the device's sqlite file with node's built-in sqlite
 * driver and read the physical storage tables (ps_data__<type>, plus
 * ps_untyped if the service ever delivered a type outside the schema), so
 * the isolation assertion is against what is actually ON DISK, not against
 * a view a schema might be hiding rows from.
 */
import { DatabaseSync } from 'node:sqlite';

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

  close(): void {
    this.db.close();
  }
}

/** ps_data__product → product */
export function clientTableOf(physical: string): string {
  return physical.replace(/^ps_data_local__/, '').replace(/^ps_data__/, '');
}
