/// <reference types="vite/client" />

/** Stamped by the build (vite.config.ts `define`). 'dev' outside CI. */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /**
   * API dev server base URL (fixed dev contract: http://localhost:3001).
   * GET /sync/token mints the short-lived PowerSync client token;
   * POST /sync/upload is the ONE write path into app.write_log.
   */
  readonly VITE_API_URL?: string;
  /**
   * PowerSync service URL (fixed dev contract: http://localhost:8080).
   * Downloads ONLY — sync_rules.yaml buckets, scoped by the token's tid.
   */
  readonly VITE_POWERSYNC_URL?: string;
  /**
   * Development-only API bearer JWT (HS256, DEV_JWT_SECRET). Real credential
   * exchange is an online-only login flow (§8.2). Never commit a real token.
   */
  readonly VITE_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
