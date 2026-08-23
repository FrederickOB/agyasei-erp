/**
 * Prove a request against the SHARED `@erp/contracts` declaration before it
 * leaves the device.
 *
 * ONE implementation, because there is one rule: a request that would be a
 * BAD_REQUEST is refused here, where the person who typed it is still
 * standing there, rather than hours later in a district town with nobody to
 * ask. It is the same discipline `data/sync/transport.ts` applies to an
 * upload envelope and `data/mutations/adjustStock.ts` applies to a movement.
 *
 * A failure comes back as an ordinary `ApiResult` so every caller handles it
 * through the same switch as every other kind of "no" — there is no separate
 * throw path for one to forget about.
 *
 * The zod schema is taken structurally (`{safeParse}`) rather than as
 * `ZodType`, so this module carries no zod version in its own import graph
 * and the callers keep the contract package as their single source of the
 * shape.
 */
import { invalidRequest, type ApiResult } from './client';

export interface SafeParseLike {
  readonly success: boolean;
  readonly error?: unknown;
}

export interface SchemaLike {
  safeParse(value: unknown): SafeParseLike;
}

export function issuesOf(error: unknown): string[] {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return ['the request did not satisfy the shared contract'];
  return issues.map((raw) => {
    const issue = raw as { path?: unknown; message?: unknown };
    const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
    const message = typeof issue.message === 'string' ? issue.message : 'invalid';
    return `${path.length > 0 ? path : '(root)'}: ${message}`;
  });
}

/** `null` when the payload satisfies the contract; a failure when it does not. */
export function guard(
  schema: SchemaLike,
  path: string,
  input: unknown,
): ApiResult<never> | null {
  const parsed = schema.safeParse(input);
  return parsed.success ? null : invalidRequest(path, issuesOf(parsed.error));
}
