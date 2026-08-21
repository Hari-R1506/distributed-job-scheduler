/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Overrides the API base URL.
   *
   * Left unset in development so requests go to `/api/v1` on the SPA's own
   * origin and Vite proxies them — which means no CORS preflight, and the
   * refresh cookie stays same-site. Set at build time for deployments where the
   * API lives on a different host.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
