/**
 * Running pg_dump / pg_restore without putting a password on a command line.
 *
 * libpq reads credentials and TLS settings from the environment, so the URL
 * handed to the child carries no password (it would be visible in `ps`) and
 * no ssl parameters (one place decides TLS, as in ../db.ts). A CA certificate
 * is written to a 0600 temp file for the child's lifetime only.
 */
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SslMode } from '../db.js';

export interface PgTarget {
  readonly url: string;
  readonly sslMode: SslMode;
  readonly caCert?: string | undefined;
}

export async function withLibpqEnv<T>(
  target: PgTarget,
  fn: (dbUrl: string, env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const u = new URL(target.url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl', 'uselibpqcompat']) u.searchParams.delete(k);
  const env: NodeJS.ProcessEnv = { ...process.env, PGSSLMODE: target.sslMode === 'require' ? 'require' : target.sslMode };
  if (password) env['PGPASSWORD'] = password;
  let dir: string | null = null;
  try {
    if (target.sslMode === 'verify-full' && target.caCert) {
      dir = await mkdtemp(join(tmpdir(), 'erp-pg-'));
      const ca = join(dir, 'ca.pem');
      await writeFile(ca, target.caCert, { mode: 0o600 });
      env['PGSSLROOTCERT'] = ca;
    }
    return await fn(u.toString(), env);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run a binary; resolve on exit 0, reject with its (credential-free) stderr
 * tail otherwise. Archive data flows through stdout/stdin rather than a
 * `--file` path, so the same call works with a native binary or a wrapper
 * that runs the tool in a container of the server's major version.
 */
export function run(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stdoutFile?: string; stdinFile?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], {
      env,
      stdio: [io.stdinFile ? 'pipe' : 'ignore', io.stdoutFile ? 'pipe' : 'inherit', 'pipe'],
    });
    let err = '';
    child.stderr!.on('data', (d: Buffer) => {
      err = (err + d.toString('utf8')).slice(-4000);
      process.stderr.write(d);
    });
    const piping: Promise<void>[] = [];
    if (io.stdoutFile) {
      const out = createWriteStream(io.stdoutFile, { mode: 0o600 });
      piping.push(pipeline(child.stdout!, out));
    }
    if (io.stdinFile) {
      piping.push(pipeline(createReadStream(io.stdinFile), child.stdin!));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      Promise.all(piping)
        .then(() => {
          if (code === 0) resolve();
          else reject(new Error(`${bin} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
        })
        .catch(reject);
    });
  });
}

/** `pg_dump` / `pg_restore` from PG_BIN_DIR when set (match the server's major version). */
export function pgBin(name: 'pg_dump' | 'pg_restore'): string {
  const dir = process.env['PG_BIN_DIR'];
  return dir ? join(dir, name) : name;
}
