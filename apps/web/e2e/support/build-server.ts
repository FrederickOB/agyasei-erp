/**
 * A static server for `dist-e2e/` whose service worker and release gate a test
 * can change — the shape of a deploy, without touching the build on disk.
 *
 *   bumpServiceWorker()  serves a byte-different sw.js: the browser's update
 *                        check installs it and, with skipWaiting off, it WAITS.
 *   setRelease(info)     what /release.json says (the §8.11 version gate);
 *                        `null` answers 404 — an unreachable gate.
 *
 * Listens on 127.0.0.1 with an OS-assigned port, so it never contends with
 * `vite preview` or anything else on the machine. `no-cache` everywhere, as
 * the production nginx config serves sw.js and release.json.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-e2e');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

export interface ReleaseInfo {
  readonly build_id: string;
  readonly min_client_schema: number;
  readonly max_client_schema: number;
}

export class BuildServer {
  private server: Server | null = null;
  private generation = 0;
  private release: ReleaseInfo | null = { build_id: 'e2e', min_client_schema: 1, max_client_schema: 1 };
  url = '';

  static async start(): Promise<BuildServer> {
    if (!existsSync(path.join(root, 'index.html'))) throw new Error('dist-e2e/ is not built (node e2e/build.mjs)');
    const s = new BuildServer();
    await s.listen();
    return s;
  }

  bumpServiceWorker(): void {
    this.generation += 1;
  }

  setRelease(info: ReleaseInfo | null): void {
    this.release = info;
  }

  private listen(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const headers = { 'cache-control': 'no-cache' };
      if (url.pathname === '/release.json') {
        if (this.release === null) {
          res.writeHead(404, headers).end();
          return;
        }
        res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(this.release));
        return;
      }
      let file = path.join(root, decodeURIComponent(url.pathname));
      if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(file) || statSync(file).isDirectory()) {
        // SPA fallback, as the production server does for navigations.
        if (path.extname(url.pathname) !== '') {
          res.writeHead(404, headers).end();
          return;
        }
        file = path.join(root, 'index.html');
      }
      let body: Buffer = readFileSync(file);
      if (url.pathname === '/sw.js' && this.generation > 0) {
        body = Buffer.concat([body, Buffer.from(`\n// e2e deploy generation ${this.generation}\n`)]);
      }
      res
        .writeHead(200, { ...headers, 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
        .end(body);
    });
    return new Promise((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr === null || typeof addr === 'string') throw new Error('no address');
        this.url = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server === null) {
        resolve();
        return;
      }
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}
