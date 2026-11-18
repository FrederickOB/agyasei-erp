/**
 * Structured logs for operations code: one JSON object per line.
 *
 * The rule the shape enforces: a log line carries a message and SCALAR
 * fields — ids, counts, durations, codes. There is no field for an object, so
 * there is no way to log a row, a payload or a request body by accident.
 */
export type LogScalar = string | number | boolean | null | undefined | bigint;
export type LogFields = Record<string, LogScalar>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function clean(fields: LogFields): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'bigint' ? v.toString(10) : v;
  }
  return out;
}

export function jsonLogger(
  base: LogFields = {},
  write: (line: string, level: 'info' | 'warn' | 'error') => void = (line, level) =>
    (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`),
): Logger {
  const emit = (level: 'info' | 'warn' | 'error', msg: string, fields?: LogFields) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...clean(base), ...clean(fields ?? {}) }), level);
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => jsonLogger({ ...base, ...fields }, write),
  };
}

/**
 * The parts of an error that are safe to record: its SQLSTATE and its primary
 * message, truncated. NEVER `detail`, `where`, `hint` or a stack — Postgres
 * puts row VALUES in `detail` ("Key (receipt_no)=(…) already exists"), and a
 * row value is tenant data.
 */
export function safeError(err: unknown): { code: string | null; message: string } {
  const code =
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
      ? ((err as { code: string }).code)
      : null;
  const raw = err instanceof Error ? err.message : String(err);
  return { code, message: raw.split('\n')[0]!.slice(0, 300) };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
