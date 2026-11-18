/**
 * Request logging that cannot carry tenant data.
 *
 * Fastify's default request serializer logs the full URL — and a tRPC query
 * puts its INPUT in the query string (`/trpc/credit.search?input=…`), which
 * for this API is customer names, receipt numbers, amounts. So the path is
 * logged without its query string, headers are not logged at all (the
 * Authorization header is a bearer credential), bodies are never logged, and
 * the remote address is left to the edge proxy's own logs.
 *
 * What a line DOES carry: method, path, status, timing, a request id, and —
 * on errors — the tRPC path, error code and the tenant id from the verified
 * token. Ids at most (CLAUDE.md §2.1; the work-package rule).
 */
import type { FastifyServerOptions } from 'fastify';

export function pathOnly(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

export function productionLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    // Belt and braces: even if a future log call passes a request object or
    // headers explicitly, these paths are censored.
    redact: {
      paths: [
        'req.headers',
        'headers',
        'authorization',
        '*.authorization',
        'body',
        '*.body',
        'input',
        '*.input',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(request: { method?: string; url?: string; id?: string }) {
        return { method: request.method, path: pathOnly(request.url), reqId: request.id };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode };
      },
    },
  } as LoggerOptions;
}
