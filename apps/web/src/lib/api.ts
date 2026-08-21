const BASE = import.meta.env['VITE_API_URL'] ?? '/api/v1';

/**
 * The access token lives in a module variable — deliberately NOT localStorage.
 *
 * localStorage is readable by any injected script, so an XSS becomes a
 * permanent account takeover. In memory it dies with the tab, and the refresh
 * token (httpOnly cookie) is unreachable from JavaScript entirely.
 * See ARCHITECTURE.md §29.6.
 */
let accessToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: { field?: string; issue: string }[];
  request_id: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
  /** Switch on the stable code, never on the human-readable message. */
  get code(): string {
    return this.body.code;
  }
}

/**
 * A single in-flight refresh, shared by every request that 401s.
 *
 * Without this, a dashboard page firing six parallel queries on a stale token
 * triggers six refreshes. Because refresh tokens ROTATE, five of those six
 * would present an already-consumed token and fail — logging the user out
 * during an ordinary page load.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { access_token: string };
      accessToken = json.access_token;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so concurrent callers all observe the result.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Internal: prevents an infinite refresh loop. */
  _retried?: boolean;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...opts.headers,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  // Try exactly one silent refresh, then give up and surface the 401.
  if (res.status === 401 && !opts._retried) {
    if (await refreshAccessToken()) {
      return request<T>(path, { ...opts, _retried: true });
    }
    accessToken = null;
    onUnauthenticated?.();
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const body = (json as { error?: ApiErrorBody } | null)?.error ?? {
      code: 'UNKNOWN',
      message: res.statusText,
      request_id: '',
    };
    throw new ApiError(res.status, body);
  }

  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body, ...(headers ? { headers } : {}) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ── Response shapes ─────────────────────────────────────────────────────────
// Hand-written rather than imported from @djs/core: the SPA is built and
// deployed separately from the API and may briefly run against an older
// version, so pretending the types are shared would assert a coupling that
// does not hold at runtime.

export interface Job {
  id: string;
  queue_id: string;
  status: JobStatus;
  handler: string | null;
  priority: number;
  attempt_count: number;
  max_attempts: number | null;
  run_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string | null;
}

export type JobStatus =
  | 'SCHEDULED'
  | 'QUEUED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'RETRYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'DEAD_LETTER'
  | 'CANCELLED';

export interface Execution {
  id: string;
  attempt: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  worker: { id: string; name: string } | null;
}

export interface JobDetail extends Job {
  queue_name: string | null;
  payload: unknown;
  result: unknown;
  parent_job_id: string | null;
  timeout_ms: number;
  retry_policy: {
    strategy: string;
    base_delay_ms: number;
    max_delay_ms: number;
    jitter_pct: number;
  };
  executions: Execution[];
  dead_letter: { id: string; reason: string; resolved_at: string | null } | null;
}

export interface QueueStats {
  queued: number;
  scheduled: number;
  retrying: number;
  running: number;
  completed_24h: number;
  failed_24h: number;
  dlq_open: number;
  success_rate_24h: number | null;
  avg_duration_ms: number;
  p95_duration_ms: number;
  throughput_per_min: number;
  oldest_queued_age_s: number | null;
  capacity_used: string;
  health: 'healthy' | 'degraded' | 'unhealthy' | 'paused';
}

export interface Queue {
  id: string;
  name: string;
  description: string | null;
  max_concurrency: number | null;
  is_paused: boolean;
  dlq_enabled: boolean;
  default_priority: number;
  retry_policy: { id: string; name: string; strategy: string } | null;
  stats?: QueueStats;
}

export interface Worker {
  id: string;
  name: string;
  status: string;
  hostname: string;
  concurrency: number;
  active_job_count: number;
  started_at: string;
  seconds_since_heartbeat: number;
  health: 'healthy' | 'lagging' | 'dead';
  queues: { id: string; name: string }[];
}

export interface Overview {
  queued: number;
  scheduled: number;
  retrying: number;
  running: number;
  completed_total: number;
  completed_24h: number;
  failed_attempts_24h: number;
  dead_lettered_24h: number;
  dlq_open: number;
  success_rate_24h: number | null;
  avg_duration_ms: number;
  p95_duration_ms_approx: number;
  throughput_per_min: number;
  workers_active: number;
  workers_dead: number;
  capacity_used: string;
  oldest_queued_age_s: number | null;
}

export interface DlqEntry {
  id: string;
  job_id: string;
  queue: { id: string; name: string };
  handler: string | null;
  reason: string;
  error_code: string | null;
  error_message: string | null;
  total_attempts: number;
  dead_lettered_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

export interface Page<T> {
  data: T[];
  page: { next_cursor: string | null; has_more: boolean; limit: number };
}
