/**
 * Test adapter: the LocalDb seam over real SQLite (node:sqlite), built from
 * the SAME schema definition the device uses (src/data/schema.ts), so the SQL
 * and the transaction semantics under test are the real ones.
 *
 * `failOn` injects a fault into a matching statement, which is how the tests
 * prove checkout is a single ACID transaction: a failure mid-checkout must
 * roll back BOTH the outbox insert and the cart clear.
 */
import { DatabaseSync } from 'node:sqlite';
import { DataBus, type DbExecutor, type DbRow, type LocalDb, type SqlValue } from '../../src/data/db';
import { localSchemaDdl } from '../../src/data/schema';

export interface TestDbOptions {
  readonly failOn?: (sql: string) => boolean;
}

export function openTestDb(options: TestDbOptions = {}): LocalDb {
  const raw = new DatabaseSync(':memory:');
  for (const stmt of localSchemaDdl()) raw.exec(stmt);

  const guard = (sql: string): void => {
    if (options.failOn !== undefined && options.failOn(sql)) {
      throw new Error(`injected fault on: ${sql.slice(0, 60)}`);
    }
  };

  const executor: DbExecutor = {
    async execute(sql: string, params: readonly SqlValue[] = []): Promise<void> {
      guard(sql);
      raw.prepare(sql).run(...(params as SqlValue[]));
    },
    async getAll(sql: string, params: readonly SqlValue[] = []): Promise<DbRow[]> {
      guard(sql);
      return raw.prepare(sql).all(...(params as SqlValue[])) as unknown as DbRow[];
    },
  };

  return {
    execute: executor.execute,
    getAll: executor.getAll,
    async writeTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(executor);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    changes: new DataBus(),
  };
}
