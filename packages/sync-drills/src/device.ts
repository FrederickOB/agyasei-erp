/**
 * One drill "device": a real @powersync/node client with its OWN sqlite file
 * and its OWN tokens — nothing shared in-process with any other device.
 *
 *   - Downloads: PowerSync stream from the real self-hosted service. The
 *     client token comes from GET /sync/token (API JWT → short-lived
 *     PowerSync token; tid from the VERIFIED session, never from any input).
 *   - Uploads: NEVER through PowerSync. Writes are queued in the local-only
 *     outbox table and flushed to POST /sync/upload — the API's one
 *     idempotent pipeline over app.write_log (CLAUDE.md §2.2, §3.3).
 *   - Partition: disconnect() closes the sync stream; while partitioned the
 *     device only touches its local sqlite. flushOutbox() is only called on
 *     reconnect.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { SignJWT } from 'jose';
import { PowerSyncDatabase } from '@powersync/node';
import type { PowerSyncBackendConnector } from '@powersync/node';
import { uuidv7 } from '@erp/db';
import { blockEnd, nextNumber, renderNumber } from '@erp/sequence';
import { API_URL, DEV_JWT_SECRET, DRILL_DATA_DIR } from './env.js';
import { buildDrillSchema } from './schema.js';

const encoder = new TextEncoder();

export interface UploadAck {
  key: string;
  status: 'applied' | 'duplicate' | 'rejected';
  reason?: string;
  /** Present for RESULT_OPS (api/src/sync.ts) — today, the block report. */
  result?: unknown;
}

export interface OutboxOp {
  idempotency_key: string;
  claimed_hlc: string;
  client_wall_at: string;
  kind: string;
  payload: Record<string, unknown>;
}

export class DrillDevice {
  readonly name: string;
  readonly tenantId: string;
  readonly locationId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly dbPath: string;
  /** Every batch body this device has sent, verbatim, for replay drills. */
  readonly sentBatches: { body: string; acks: UploadAck[] }[] = [];

  private db: PowerSyncDatabase | null = null;
  private apiToken: string | null = null;
  private hlcCounter = 0;

  constructor(name: string, tenantId: string, locationId: string) {
    this.name = name;
    this.tenantId = tenantId;
    this.locationId = locationId;
    this.userId = uuidv7();
    this.deviceId = uuidv7();
    this.dbPath = `${DRILL_DATA_DIR}${name}.sqlite`;
  }

  /** Dev-grade API JWT for this device's user — the same claim shape the
   *  API's auth.ts verifies ({tid, uid, role, locs, dev}). */
  private async getApiToken(): Promise<string> {
    if (this.apiToken) return this.apiToken;
    this.apiToken = await new SignJWT({
      tid: this.tenantId,
      uid: this.userId,
      role: 'outlet_manager',
      locs: [this.locationId],
      dev: this.deviceId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(encoder.encode(DEV_JWT_SECRET));
    return this.apiToken;
  }

  /** The device's own clock assertion — stored server-side as claimed_hlc,
   *  UNTRUSTED (the server stamps the authoritative HLC). */
  private claimHlc(): string {
    const ms = String(Date.now()).padStart(13, '0');
    const ctr = String(this.hlcCounter++ % 100000).padStart(5, '0');
    const node = this.deviceId.replaceAll('-', '');
    return `${ms}-${ctr}-${node}`;
  }

  async open(): Promise<void> {
    mkdirSync(DRILL_DATA_DIR, { recursive: true });
    this.db = new PowerSyncDatabase({
      schema: buildDrillSchema(),
      database: { dbFilename: `${this.name}.sqlite`, dbLocation: DRILL_DATA_DIR },
    });
    await this.db.init();
  }

  private connector(): PowerSyncBackendConnector {
    return {
      fetchCredentials: async () => {
        const apiToken = await this.getApiToken();
        const res = await fetch(`${API_URL}/sync/token`, {
          headers: { authorization: `Bearer ${apiToken}` },
        });
        if (!res.ok) throw new Error(`/sync/token ${res.status}: ${await res.text()}`);
        const body = (await res.json()) as { token: string; endpoint: string };
        return { endpoint: body.endpoint, token: body.token };
      },
      // The PowerSync service is download-only; synced tables are read-only
      // on the device so no crud batch ever exists. Uploads are the explicit
      // outbox flush to the API. If a crud batch DID appear it would be a
      // drill bug — fail loudly rather than complete (completing loses writes).
      uploadData: async (database) => {
        const batch = await database.getCrudBatch();
        if (batch !== null) {
          throw new Error(`${this.name}: unexpected PowerSync crud batch — synced tables must be read-only`);
        }
      },
    };
  }

  get powersync(): PowerSyncDatabase {
    if (!this.db) throw new Error(`${this.name}: not opened`);
    return this.db;
  }

  async connect(): Promise<void> {
    await this.powersync.connect(this.connector());
  }

  async waitForFirstSync(timeoutMs = 60_000): Promise<void> {
    await withTimeout(this.powersync.waitForFirstSync(), timeoutMs, `${this.name} first sync`);
  }

  /** Sever the sync stream — the device is now partitioned. */
  async disconnect(): Promise<void> {
    await this.powersync.disconnect();
  }

  async close(): Promise<void> {
    if (this.db) await this.db.close();
    this.db = null;
  }

  /**
   * Destroy this device's local database and come back with a fresh one —
   * the OPFS-eviction / PWA-reinstall case (03 §3.7.5, conflict class #14).
   *
   * The sqlite file is genuinely deleted, not truncated in memory: the device
   * returns holding no outbox, no synced rows and — the part that matters — no
   * `consumed_upto`, while the server still shows its block live. Its identity
   * (device_id, user_id, tokens) survives, because a reinstall on the SAME
   * enrolled device is the whole point.
   */
  async wipeLocalDatabase(): Promise<void> {
    await this.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${this.dbPath}${suffix}`, { force: true });
    }
    await this.open();
  }

  // ---- receipt numbers: consumed locally, allocated by the server ---------

  /** The block this device is consuming, or null (a wipe leaves null). */
  async currentBlock(locationId = this.locationId, sequenceKey = 'RECEIPT') {
    const rows = await this.powersync.getAll<{
      block_start: string;
      block_size: number;
      consumed_upto: string | null;
      number_format: string;
      number_prefix: string;
      location_code: string;
    }>(
      `select block_start, block_size, consumed_upto, number_format, number_prefix, location_code
         from sequence_block where sequence_key = ? and location_id = ? limit 1`,
      [sequenceKey, locationId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      blockStart: BigInt(row.block_start),
      blockSize: row.block_size,
      consumedUpto: row.consumed_upto === null ? null : BigInt(row.consumed_upto),
      format: {
        format: row.number_format,
        prefix: row.number_prefix,
        locationCode: row.location_code,
      },
    };
  }

  /** Adopt the block the server issued, replacing whatever was here. */
  async adoptBlock(
    block: { blockStart: string; blockSize: number },
    format: { format: string; prefix: string; locationCode: string },
    sequenceKey = 'RECEIPT',
  ): Promise<void> {
    await this.powersync.execute(
      `delete from sequence_block where sequence_key = ? and location_id = ?`,
      [sequenceKey, this.locationId],
    );
    await this.powersync.execute(
      `insert into sequence_block
         (id, sequence_key, location_id, block_start, block_size, consumed_upto,
          number_format, number_prefix, location_code)
       values (?, ?, ?, ?, ?, null, ?, ?, ?)`,
      [
        uuidv7(),
        sequenceKey,
        this.locationId,
        block.blockStart,
        block.blockSize,
        format.format,
        format.prefix,
        format.locationCode,
      ],
    );
  }

  /** Issue the next receipt number locally. No network on this path. */
  async takeReceiptNumber(sequenceKey = 'RECEIPT'): Promise<string> {
    const block = await this.currentBlock(this.locationId, sequenceKey);
    if (!block) throw new Error(`${this.name}: no receipt-number block — blocks are never self-issued`);
    const n = nextNumber(block, block.consumedUpto);
    if (n === null) throw new Error(`${this.name}: block spent (emergency form is covered elsewhere)`);
    await this.powersync.execute(
      `update sequence_block set consumed_upto = ? where sequence_key = ? and location_id = ?`,
      [n.toString(10), sequenceKey, this.locationId],
    );
    return renderNumber(block.format, n);
  }

  /** The last number in this device's current block (for burn assertions). */
  async currentBlockEnd(): Promise<bigint | null> {
    const block = await this.currentBlock();
    return block === null ? null : blockEnd(block);
  }

  /**
   * Queue the reconnect report into the ORDERED outbox — the same queue the
   * sales use, so it lands ahead of anything queued after it (§3.3).
   */
  async queueBlockReport(sequenceKey = 'RECEIPT'): Promise<string> {
    const block = await this.currentBlock(this.locationId, sequenceKey);
    return this.recordToOutbox('sequence.sync_block', {
      locationId: this.locationId,
      sequenceKey,
      report:
        block === null
          ? null
          : {
              blockStart: block.blockStart.toString(10),
              consumedUpto: block.consumedUpto?.toString(10) ?? null,
            },
      wantBlock: true,
    });
  }

  // ---- offline writes: the outbox ---------------------------------------

  /** Queue one op locally (device partitioned or not — the outbox is the
   *  only write path). Returns the minted idempotency key. */
  async recordToOutbox(kind: string, payload: Record<string, unknown>): Promise<string> {
    const key = uuidv7();
    await this.powersync.execute(
      `insert into outbox (id, idempotency_key, kind, payload, claimed_hlc, client_wall_at, created_at, status)
       values (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [key, key, kind, JSON.stringify(payload), this.claimHlc(), new Date().toISOString(), new Date().toISOString()],
    );
    return key;
  }

  async pendingOutbox(): Promise<OutboxOp[]> {
    const rows = await this.powersync.getAll<{
      idempotency_key: string; kind: string; payload: string;
      claimed_hlc: string; client_wall_at: string;
    }>(`select idempotency_key, kind, payload, claimed_hlc, client_wall_at
          from outbox where status = 'pending' order by created_at, idempotency_key`);
    return rows.map((r) => ({
      idempotency_key: r.idempotency_key,
      claimed_hlc: r.claimed_hlc,
      client_wall_at: r.client_wall_at,
      kind: r.kind,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  /** POST the pending outbox to /sync/upload in order; mark acked rows.
   *  Returns the acks. Throws on transport/envelope failure (nothing acked,
   *  outbox intact — the retry-safe failure mode). */
  async flushOutbox(): Promise<UploadAck[]> {
    const ops = await this.pendingOutbox();
    if (ops.length === 0) return [];
    const body = JSON.stringify({ ops });
    const acks = await this.postUpload(body);
    this.sentBatches.push({ body, acks });
    for (const ack of acks) {
      if (ack.status === 'applied' || ack.status === 'duplicate') {
        await this.powersync.execute(`update outbox set status = 'acked' where idempotency_key = ?`, [ack.key]);
      }
    }
    return acks;
  }

  /** Send a raw batch body verbatim (D4: byte-identical replay). */
  async postUpload(body: string): Promise<UploadAck[]> {
    const apiToken = await this.getApiToken();
    const res = await fetch(`${API_URL}/sync/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(`/sync/upload ${res.status}: ${await res.text()}`);
    const parsed = (await res.json()) as { acks: UploadAck[] };
    return parsed.acks;
  }

  // ---- local reads --------------------------------------------------------

  async getAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.powersync.getAll<T>(sql, params);
  }

  async localOnHand(productId: string): Promise<bigint> {
    const r = await this.getAll<{ s: string | null }>(
      `select cast(coalesce(sum(cast(qty_delta as integer)), 0) as text) as s
         from stock_movement where product_id = ? and location_id = ?`,
      [productId, this.locationId],
    );
    return BigInt(r[0]?.s ?? '0');
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Poll until predicate is true; prints a dot every ~2s so a stall is visible. */
export async function pollUntil(
  what: string,
  predicate: () => Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 200;
  const t0 = performance.now();
  let lastDot = t0;
  for (;;) {
    if (await predicate()) return performance.now() - t0;
    const now = performance.now();
    if (now - t0 > timeoutMs) throw new Error(`timeout after ${Math.round(now - t0)}ms waiting for ${what}`);
    if (now - lastDot > 2000) {
      process.stdout.write('.');
      lastDot = now;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
