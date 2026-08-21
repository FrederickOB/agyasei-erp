/// <reference types="vite/client" />

/** Stamped by the build (vite.config.ts `define`). 'dev' outside CI. */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /**
   * PowerSync sync-service endpoint. When ABSENT the app runs in local-only
   * mode: the same local schema, no backend, fully usable in dev.
   */
  readonly VITE_SYNC_ENDPOINT?: string;
  /** Development-only sync token. Real credential exchange is an online-only login flow (§8.2). */
  readonly VITE_SYNC_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
