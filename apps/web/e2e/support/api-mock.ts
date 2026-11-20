/**
 * The API, as far as the browser tests are concerned: Playwright routes on the
 * reserved `.invalid` origin the e2e build names. Nothing listens there, so an
 * unrouted request fails like a dead radio — which is exactly what
 * `context.setOffline(true)` and `upload: 'unreachable'` rely on.
 *
 * It speaks the real wire: tRPC v11 + superjson envelopes
 * (`{result:{data:{json}}}` / `{error:{json:{message,data:{code}}}}`, see
 * src/data/api/client.ts), `GET /sync/token` per `syncTokenResponse`, and
 * `POST /sync/upload` acking per idempotency key per `UploadResponseBody`
 * (packages/contracts). Every procedure a page calls that has no handler is
 * answered NOT_FOUND and RECORDED, so a spec can assert it rendered from real
 * answers rather than from a wall of failures.
 *
 * It authorises nothing and scopes nothing — it is a fixture, not a server.
 * The authorisation and tenant boundaries are the server's and the sync
 * rules' (CLAUDE.md §2.1, §2.6) and are tested there, not here.
 */
import type { BrowserContext, Request, Route } from '@playwright/test';
import identity from './identity.json' with { type: 'json' };

export type ProcedureHandler = (input: unknown) => unknown;

export interface UploadOpSeen {
  readonly idempotency_key: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

export type UploadMode =
  /** Every upload fails at the network layer: the sync stack is down. */
  | 'unreachable'
  /** Every op is acked `applied`, as the API does for an accepted write. */
  | 'ack';

export class ApiMock {
  readonly calls: { readonly path: string; readonly input: unknown }[] = [];
  readonly unhandled: string[] = [];
  readonly uploads: UploadOpSeen[] = [];
  uploadMode: UploadMode;
  /**
   * Playwright still runs route handlers for a context that is
   * `setOffline(true)` — a fulfilled route never touches the network. So the
   * device's radio is mirrored here (Device.setOffline) and every request
   * fails at the network layer while it is down, exactly as a dead link does.
   */
  offline = false;
  private readonly handlers: Map<string, ProcedureHandler>;

  constructor(handlers: Readonly<Record<string, ProcedureHandler>>, uploadMode: UploadMode = 'unreachable') {
    this.handlers = new Map(Object.entries(handlers));
    this.uploadMode = uploadMode;
  }

  /** Replace or add one procedure's answer mid-test. */
  answer(path: string, handler: ProcedureHandler): void {
    this.handlers.set(path, handler);
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route(`${identity.apiOrigin}/**`, (route, request) => this.handle(route, request));
  }

  private cors(request: Request): Record<string, string> {
    return {
      'access-control-allow-origin': request.headers()['origin'] ?? '*',
      'access-control-allow-headers': 'authorization, content-type, dpop',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      vary: 'origin',
    };
  }

  private async json(route: Route, request: Request, status: number, body: unknown): Promise<void> {
    await route.fulfill({
      status,
      headers: { ...this.cors(request), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async handle(route: Route, request: Request): Promise<void> {
    if (this.offline) {
      await route.abort('internetdisconnected');
      return;
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: this.cors(request) });
      return;
    }
    const url = new URL(request.url());

    if (url.pathname === '/sync/token') {
      await this.json(route, request, 200, {
        token: 'e2e-powersync-client-token',
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
      return;
    }

    if (url.pathname === '/sync/upload') {
      if (this.uploadMode === 'unreachable') {
        await route.abort('connectionrefused');
        return;
      }
      const body = request.postDataJSON() as { ops?: UploadOpSeen[] };
      const ops = body.ops ?? [];
      this.uploads.push(...ops);
      await this.json(route, request, 200, {
        acks: ops.map((op) => ({ key: op.idempotency_key, status: 'applied' })),
      });
      return;
    }

    if (url.pathname.startsWith('/trpc/')) {
      const path = url.pathname.slice('/trpc/'.length);
      let input: unknown;
      try {
        const raw =
          request.method() === 'GET' ? url.searchParams.get('input') : (request.postData() ?? null);
        input = raw === null ? undefined : (JSON.parse(raw) as { json?: unknown }).json;
      } catch {
        input = undefined;
      }
      this.calls.push({ path, input });
      const handler = this.handlers.get(path);
      if (handler === undefined) {
        this.unhandled.push(path);
        await this.json(route, request, 404, {
          error: { json: { message: `no e2e fixture for ${path}`, code: -32004, data: { code: 'NOT_FOUND', httpStatus: 404, path } } },
        });
        return;
      }
      await this.json(route, request, 200, { result: { data: { json: handler(input) } } });
      return;
    }

    await this.json(route, request, 404, { error: 'not part of the e2e API fixture' });
  }
}
