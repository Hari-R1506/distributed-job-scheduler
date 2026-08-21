# API Reference

Distributed Job Scheduler · **v1** · 56 operations across 9 resource groups.

- **Interactive:** http://localhost:3000/docs (Swagger UI — "Try it out" works)
- **Machine-readable:** [`docs/api/openapi.json`](api/openapi.json) — OpenAPI 3.0, generated from the running server
- **Base URL:** `http://localhost:3000/api/v1`

Health and metrics endpoints deliberately sit **outside** the version prefix — an
orchestrator should never need to know which API version is deployed in order to
health-check it.

---

## Contents

1. [Authentication](#1-authentication)
2. [Conventions](#2-conventions) — pagination, errors, idempotency
3. [Auth endpoints](#3-auth-endpoints)
4. [Organizations, projects, policies, API keys](#4-organizations-projects-policies-api-keys)
5. [Queues](#5-queues)
6. [Jobs](#6-jobs)
7. [Scheduled (cron) jobs](#7-scheduled-cron-jobs)
8. [Workers](#8-workers)
9. [Dead letter queue](#9-dead-letter-queue)
10. [Metrics and health](#10-metrics-and-health)
11. [Error codes](#11-error-codes)
12. [Worked example](#12-worked-example-end-to-end)

---

## 1. Authentication

Two schemes. Both resolve to the same internal principal, so nothing downstream
cares which was used.

### Bearer token — for the dashboard

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

Obtained from `POST /auth/login`. **Expires in 15 minutes.** A rotating refresh
token is set as an httpOnly cookie; call `POST /auth/refresh` to mint a new
access token.

> The access token is deliberately short-lived and the refresh token is
> unreachable from JavaScript. Storing a long-lived token in `localStorage` is
> the common shortcut and it turns any XSS into a permanent account takeover.

### API key — for services

```http
X-API-Key: sk_live_a1b2c3...
```

Created with `POST /projects/{id}/api-keys`. **The plaintext is returned once
and never again** — only its SHA-256 is stored, so a database leak does not hand
an attacker working credentials.

An API key is scoped to exactly **one project**. Holding a valid key for project
A does not grant access to project B, even in the same organization.

### Every endpoint requires auth

...except `/health`, `/ready`, `/metrics`, `POST /auth/register`,
`POST /auth/login` and `POST /auth/refresh`.

Authentication is **deny-by-default**: routes must explicitly opt out. Opt-in
auth is how endpoints ship unprotected.

---

## 2. Conventions

### 2.1 Tenant isolation

Every request resolves the caller's memberships and scopes the query to them. A
path parameter is never trusted on its own.

**Resources belonging to another tenant return `404`, not `403`.** Returning
`403` would confirm the id exists, turning the API into an oracle for probing
another tenant's data.

### 2.2 Pagination — cursor, not offset

```http
GET /api/v1/projects/{id}/jobs?limit=50&cursor=eyJ2IjoiMjAyNi0wOC0yMFQxMDowMDowMFoiLCJpIjoiYWJjIn0
```

```jsonc
{
  "data": [ /* … */ ],
  "page": {
    "next_cursor": "eyJ2IjoiMjAyNi0wOC0yMFQwOTo1OTowMFoiLCJpIjoiZGVmIn0",
    "has_more": true,
    "limit": 50
  }
}
```

Pass `next_cursor` back as `cursor` for the following page. `next_cursor: null`
means you have reached the end.

> **Why not `?page=3`.** The `jobs` table takes thousands of inserts a minute.
> Between a request for page 1 and page 2, rows shift — so `OFFSET 50` skips
> records the caller never saw and repeats ones they did. That is *incorrect*,
> not merely slow. A keyset cursor encodes `(created_at, id)` and is stable
> under concurrent inserts, at O(log n) regardless of depth.
>
> The trade: there is no "jump to page 7". In practice nobody jumps to page 7 of
> a job list — they filter.

`limit` defaults to 50, maximum 200.

### 2.3 Errors — one envelope, always

Every non-2xx response has exactly this shape:

```jsonc
{
  "error": {
    "code": "QUEUE_PAUSED",
    "message": "This queue is paused and is not accepting new jobs.",
    "details": [{ "field": "payload", "issue": "must have required property 'url'" }],
    "request_id": "req_01J8XYZ...",
    "timestamp": "2026-08-20T10:00:00.000Z"
  }
}
```

| Field | Contract |
|---|---|
| `code` | **Stable.** Switch on this. Never changes for a given condition |
| `message` | Human-readable. **May be reworded at any time** — do not match on it |
| `details` | Present on validation failures; one entry per offending field |
| `request_id` | Also returned as the `X-Request-Id` header. Quote it in bug reports — it correlates to the server log line, and to every job the request created |

### 2.4 Idempotency

Send an `Idempotency-Key` header on job creation:

```http
POST /api/v1/queues/{queueId}/jobs
Idempotency-Key: order-4711-confirmation
```

| Outcome | Status | Header |
|---|---|---|
| Job created | `201 Created` | — |
| Key already used | `200 OK` | `X-Idempotent-Replay: true` |

The key is unique **per queue**, so the same logical key may legitimately exist
on two queues.

> This solves the case where your `POST` succeeded but the response was lost to
> a timeout: retrying with the same key returns the *original* job rather than
> creating a second one.
>
> Idempotency is **opt-in via an explicit key**, never inferred from a payload
> hash. Two identical jobs submitted deliberately — "send the daily report",
> twice — must both run. Content-hash deduplication would silently swallow the
> second and be maddening to debug.

### 2.5 Status codes

| Code | Meaning |
|---|---|
| `200` | OK |
| `201` | Created |
| `202` | Accepted — cancellation requested on a running job |
| `204` | No content |
| `207` | Multi-status — batch creation, per-item results |
| `400` | Malformed request |
| `401` | Missing or invalid credentials |
| `403` | Authenticated, but not permitted |
| `404` | Not found **or not yours** |
| `409` | State conflict — paused queue, already-resolved DLQ entry, illegal transition |
| `422` | Semantically invalid — unknown handler, payload fails its schema, bad cron |
| `429` | Rate limited |
| `500` | Unexpected — the `request_id` is your handle for it |

### 2.6 Rate limits

300 requests/minute globally; **10/minute on auth endpoints**, where an
attacker's cost per attempt is the entire defence.

`X-RateLimit-Limit`, `-Remaining` and `-Reset` are returned on every response.

---

## 3. Auth endpoints

### `POST /auth/register` 🔓

Creates a user, their first organization, and an OWNER membership — atomically.
A user without an org, or an org without an owner, is a half-created account
somebody has to clean up by hand.

```jsonc
// Request
{
  "email": "you@example.com",
  "password": "at-least-12-characters",
  "name": "Your Name",
  "org_name": "Acme Inc"
}
```
```jsonc
// 201 Created  (+ Set-Cookie: djs_refresh=…; HttpOnly)
{
  "user": { "id": "uuid", "email": "you@example.com", "name": "Your Name" },
  "org":  { "id": "uuid", "name": "Acme Inc", "slug": "acme-inc" },
  "access_token": "eyJ…",
  "expires_in": 900
}
```

**Validation** · `email` RFC-valid, lowercased, unique (case-insensitively — the
column is `citext`, so `Alice@x.com` and `alice@x.com` cannot both exist).
`password` ≥ 12 characters. `org_name` 2–64.

**Errors** · `400` validation · `409` email already registered

---

### `POST /auth/login` 🔓

```jsonc
// Request
{ "email": "you@example.com", "password": "…" }
```
```jsonc
// 200 OK  (+ refresh cookie)
{ "user": { … }, "access_token": "eyJ…", "expires_in": 900 }
```

**Errors** · `401` — *identical* response and timing for "no such user" and
"wrong password". A verification runs even when the user does not exist, so the
endpoint cannot be used to enumerate registered emails.

---

### `POST /auth/refresh` 🔓

Reads the refresh cookie, returns a new access token, and **rotates** the
refresh token.

```jsonc
// 200 OK
{ "access_token": "eyJ…", "expires_in": 900 }
```

> Rotation means a stolen refresh token is usable at most once before the
> legitimate client's next refresh invalidates the thief's copy.
>
> ⚠️ Clients must collapse concurrent refreshes into one in-flight request.
> Six parallel queries on a stale token would otherwise trigger six refreshes,
> five of which present an already-consumed token and fail.

**Errors** · `401` no cookie, expired, or the account is deactivated

---

### `POST /auth/logout` → `204`

Clears the refresh cookie.

### `GET /auth/me` → `200`

Returns the current principal. For a bearer token, the user plus their
memberships and roles. For an API key, the project id and scopes.

---

## 4. Organizations, projects, policies, API keys

| Method | Path | Notes |
|---|---|---|
| `GET` | `/orgs` | Organizations the caller belongs to, with project counts |
| `GET` | `/projects` | Scoped to the caller's memberships — never to a supplied org id |
| `POST` | `/projects` | `{org_id, name, slug, description?}` · requires `OWNER` or `ADMIN` |
| `GET` | `/projects/{id}` | Detail with queue/job/schedule counts |
| `PATCH` | `/projects/{id}` | `{name?, description?}` |
| `DELETE` | `/projects/{id}` | **Archives** (soft delete) → `204` |

> `DELETE` archives rather than hard-deletes. A hard delete would cascade to
> every job, execution and log — precisely the audit trail you want *after*
> deciding a project was a mistake.

### Retry policies

| Method | Path |
|---|---|
| `GET` | `/projects/{id}/retry-policies` |
| `POST` | `/projects/{id}/retry-policies` |
| `DELETE` | `/retry-policies/{policyId}` |

```jsonc
// POST body
{
  "name": "exponential-standard",
  "strategy": "EXPONENTIAL",        // FIXED | LINEAR | EXPONENTIAL
  "max_attempts": 5,                // 1–50
  "base_delay_ms": 5000,
  "max_delay_ms": 300000,
  "jitter_pct": 10,                 // 0–100, default 10
  "retry_on_error_codes": []        // empty = retry anything retryable
}
```

**Delete errors** · `409 IN_USE` if any queue still references it. The foreign
key is `ON DELETE RESTRICT`, so this fails loudly rather than leaving queues in
an undefined state.

### API keys

| Method | Path | Notes |
|---|---|---|
| `GET` | `/projects/{id}/api-keys` | Prefixes only — the plaintext is unrecoverable |
| `POST` | `/projects/{id}/api-keys` | `{name, scopes?}` → **returns the key once** |
| `DELETE` | `/api-keys/{keyId}` | Revokes (keeps the audit trail) → `204` |

```jsonc
// 201 Created — store `key` now, it is never shown again
{
  "id": "uuid",
  "name": "ci-pipeline",
  "key": "sk_live_a1b2c3d4e5f6…",
  "key_prefix": "sk_live_a1b",
  "scopes": ["jobs:read", "jobs:write"]
}
```

An API key cannot be used to mint further API keys.

---

## 5. Queues

A queue is not just a list — it is a configured execution domain: concurrency
cap, retry contract, pause state, lease duration.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects/{id}/queues` | List, each with live `stats` |
| `POST` | `/projects/{id}/queues` | Create → `201` |
| `GET` | `/queues/{id}` | Detail + subscribed workers |
| `PATCH` | `/queues/{id}` | Update config |
| `POST` | `/queues/{id}/pause` | → `200` |
| `POST` | `/queues/{id}/resume` | → `200` |
| `GET` | `/queues/{id}/stats` | `?window=1h\|24h\|7d` |
| `DELETE` | `/queues/{id}` | `409` if it holds jobs, unless `?force=true` |

### Create

```jsonc
{
  "name": "email-notifications",        // lowercase, [a-z0-9-_], unique per project
  "description": "Outbound email.",
  "default_priority": 100,              // 0–255, higher runs sooner
  "max_concurrency": 3,                 // null = unlimited
  "retry_policy_id": "uuid",            // required, must be in this project
  "visibility_timeout_ms": 60000,       // lease duration, minimum 45000
  "default_job_timeout_ms": 30000,
  "dlq_enabled": true,
  "retention_days": null                // auto-purge terminal jobs
}
```

> **`visibility_timeout_ms` has a 45-second floor, enforced by a database CHECK.**
> The lease must outlive the worker-death timeout, or the reaper would reclaim
> jobs from a worker that is merely a few seconds slow — causing exactly the
> duplicate execution the system exists to prevent.

### The `stats` block

```jsonc
{
  "queued": 42, "scheduled": 7, "retrying": 3, "running": 3,
  "completed_24h": 18430,
  "failed_24h": 212,                    // failed ATTEMPTS, not failed jobs
  "dlq_open": 14,
  "success_rate_24h": 0.9886,           // over jobs reaching a TERMINAL state
  "avg_duration_ms": 842,
  "p95_duration_ms": 3120,
  "throughput_per_min": 12.8,
  "oldest_queued_age_s": 4,
  "capacity_used": "3/3",
  "health": "healthy"                   // healthy | degraded | unhealthy | paused
}
```

> **`oldest_queued_age_s` is the single best health signal.** A queue draining
> 10,000 jobs quickly is healthy; one with 5 jobs stuck for an hour is not.
> Depth alone tells you neither, which is why `health` is derived from age,
> success rate and DLQ depth rather than raw counts.
>
> **`success_rate_24h` is computed over jobs, not attempts.** A job that
> succeeds on attempt 3 is a success — not 67% failure.

### `PATCH` — changes apply to **new jobs only**

Each job snapshots its retry contract at creation. Editing a queue's policy
cannot rewrite the behaviour of jobs already in flight, including ones currently
mid-backoff. The response echoes `"applies_to": "new jobs only"`.

### Pause semantics

Pausing stops **claiming**. Running jobs are **not** killed — aborting them
would leave side effects half-applied. Jobs continue to accumulate in `QUEUED`.

Resuming emits a `NOTIFY`, so workers wake within milliseconds rather than
waiting out a poll interval.

---

## 6. Jobs

### `GET /handlers` → `200`

Every registered handler with its JSON Schema and an example payload. The Create
Job form is driven by this, so the UI never hardcodes a handler list.

| Handler | Purpose |
|---|---|
| `http_request` | Sends an HTTP request. Retries 5xx/408/429 and network errors; 4xx is permanent. Sends `Idempotency-Key: <job_id>` downstream |
| `send_email` | Mock delivery — logs rather than sends |
| `simulate` | `{duration_ms, fail_probability, permanent_failure_probability}` — demonstrates retries, backoff and the DLQ |

---

### `POST /queues/{queueId}/jobs`

The core endpoint. Covers all four timing modes.

```jsonc
{
  "handler": "http_request",
  "payload": { "url": "https://example.com/hook", "method": "POST", "body": {} },
  "priority": 150,                  // 0–255, or "CRITICAL"|"HIGH"|"NORMAL"|"LOW"|"BULK"
  "run_at": "2026-08-21T09:00:00Z", // XOR delay_seconds; omit both = immediate
  "delay_seconds": null,
  "max_attempts": 5,                // overrides the queue policy for this job
  "timeout_ms": 30000,
  "idempotency_key": "order-4711",  // or send the Idempotency-Key header
  "metadata": { "order_id": "4711" },
  "allow_when_paused": false
}
```

```jsonc
// 201 Created
{
  "id": "uuid",
  "queue_id": "uuid",
  "status": "QUEUED",               // or SCHEDULED when run_at is in the future
  "handler": "http_request",
  "priority": 150,
  "attempt_count": 0,
  "max_attempts": 5,
  "run_at": "2026-08-21T09:00:00.000Z",
  "started_at": null,
  "finished_at": null,
  "last_error_code": null,
  "last_error_message": null,
  "created_at": "2026-08-20T10:00:00.000Z"
}
```

**The four timing modes:**

| Mode | How |
|---|---|
| Immediate | omit both `run_at` and `delay_seconds` |
| Delayed | `"delay_seconds": 30` |
| Scheduled | `"run_at": "2026-08-21T09:00:00Z"` |
| Recurring | use [scheduled jobs](#7-scheduled-cron-jobs) instead |

> For **immediate** jobs the server lets the database stamp `run_at` rather than
> sending its own clock. The API and the database can sit on machines whose
> clocks differ by milliseconds, and the claim query compares against the
> *database's* `now()` — so a self-stamped "immediate" job can be briefly
> not-yet-due.

**Validation** · `handler` must be registered → `422 UNKNOWN_HANDLER` ·
payload validated against the handler's JSON Schema → `422 VALIDATION_ERROR`
with per-field detail · payload ≤ 256 KB · `run_at` and `delay_seconds` are
mutually exclusive → `400` · `run_at` at most one year ahead.

> Payloads are validated **at submission**, not on a worker. A job that cannot
> possibly succeed is rejected while the caller still holds the request —
> rather than being accepted, queued, claimed, executed, failed, retried four
> times and finally dead-lettered twenty minutes later.

**Errors** · `409 QUEUE_PAUSED` (override with `allow_when_paused`) · `422` ·
`404` unknown or foreign queue

---

### `POST /queues/{queueId}/jobs/batch` → `207 Multi-Status`

```jsonc
{ "jobs": [ /* up to 1000 CreateJob objects */ ], "stop_on_error": false }
```
```jsonc
{
  "batchId": "uuid",
  "created": 998,
  "failed": 2,
  "failures": [
    { "index": 7, "error": { "code": "VALIDATION_ERROR", "message": "payload too large" } }
  ]
}
```

With `stop_on_error: true` the batch is all-or-nothing. Otherwise valid rows
commit and invalid ones are reported **by index**, so the caller knows exactly
which of their 1,000 items to fix.

---

### `GET /projects/{projectId}/jobs`

The job explorer. Every filter is index-backed.

| Parameter | Example |
|---|---|
| `queue_id` | uuid |
| `status` | `DEAD_LETTER,RETRYING` (comma-separated or repeated) |
| `handler` | `http_request` |
| `priority_gte` / `priority_lte` | `150` |
| `created_after` / `created_before` | ISO-8601 |
| `batch_id`, `scheduled_job_id` | uuid |
| `search` | a full job uuid, else matched against `handler` |
| `limit`, `cursor` | see [pagination](#22-pagination--cursor-not-offset) |

Every row carries `last_error_code`, denormalised onto the job, so the list
renders failure reasons without an extra query per row.

---

### `GET /jobs/{jobId}`

Full detail: payload, result, retry contract, and the **attempt history**
inlined (capped at 20).

```jsonc
{
  "id": "uuid", "status": "DEAD_LETTER", "queue_name": "webhooks",
  "attempt_count": 3, "max_attempts": 3,
  "payload": { … },
  "retry_policy": { "strategy": "EXPONENTIAL", "base_delay_ms": 5000, "max_delay_ms": 300000, "jitter_pct": 10 },
  "executions": [
    { "attempt": 3, "status": "FAILED", "duration_ms": 20, "error_code": "HTTP_5XX",
      "error_message": "POST https://… returned 503", "worker": { "id": "uuid", "name": "worker-2" } },
    { "attempt": 2, "status": "ABANDONED", "error_code": "LEASE_EXPIRED", … },
    { "attempt": 1, "status": "FAILED", … }
  ],
  "dead_letter": { "id": "uuid", "reason": "MAX_ATTEMPTS_EXCEEDED", "resolved_at": null },
  "parent_job_id": null
}
```

> One row per **attempt**, each with its own worker, timing and error. "It timed
> out, then got a 503" is diagnostically different from "it failed twice", and
> that distinction is only available because attempts are separate records.
>
> `ABANDONED` means the worker died mid-attempt and the reaper recovered the job.

**Related** · `GET /jobs/{id}/executions` (full history) ·
`GET /jobs/{id}/logs?execution_id=&level=` (handler log lines)

---

### `POST /jobs/{jobId}/cancel`

| Job state | Result |
|---|---|
| `SCHEDULED`, `QUEUED`, `RETRYING` | `200` — cancelled immediately |
| `RUNNING` | `202` — **cooperative**: a flag is set and the handler aborts at its next await point |
| terminal | `409` |

Killing a running job outright would leave a side effect half-applied, which is
worse than letting it finish.

### `POST /jobs/{jobId}/retry` → `201`

Allowed from any terminal state. **Creates a NEW job** with `parent_job_id` set
— it never resurrects the original.

> Resetting `attempt_count` on the original would erase the execution history
> the whole `job_executions` table exists to preserve. The chain also lets you
> see a job replayed three times, each with a different payload.

---

## 7. Scheduled (cron) jobs

A scheduled job is a **template plus a cursor**. It never executes anything
itself — the scheduler materialises concrete jobs from it.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/cron/validate` | → `200`. Validate + preview, no side effects |
| `GET/POST` | `/projects/{id}/scheduled-jobs` | List / create |
| `PATCH` | `/scheduled-jobs/{id}` | Cron or timezone change recomputes the cursor **from now** |
| `POST` | `/scheduled-jobs/{id}/pause` · `/resume` | → `200` |
| `POST` | `/scheduled-jobs/{id}/trigger` | → `201`. Fire once **without** disturbing the cursor |
| `GET` | `/scheduled-jobs/{id}/runs` | Materialised jobs, with `lateness_ms` |
| `DELETE` | `/scheduled-jobs/{id}` | `204` |

### `POST /cron/validate`

```jsonc
// Request
{ "cron_expression": "0 9 * * *", "timezone": "Asia/Kolkata" }
```
```jsonc
// 200 OK
{
  "valid": true,
  "error": null,
  "description": "every day at 09:00 Asia/Kolkata",
  "next_runs": ["2026-08-21T03:30:00.000Z", "2026-08-22T03:30:00.000Z", …]
}
```

Nobody reads `0 9 * * *` correctly under time pressure. An invalid expression
returns `valid: false` with a reason rather than an error status — the endpoint
exists to be called on every keystroke.

### Create

```jsonc
{
  "queue_id": "uuid",
  "name": "daily-digest-email",
  "cron_expression": "0 9 * * *",
  "timezone": "Asia/Kolkata",       // IANA name — never a fixed offset
  "handler": "send_email",
  "payload": { … },
  "priority": 100,
  "misfire_policy": "SKIP",         // SKIP | FIRE_ONCE | BACKFILL
  "start_at": null, "end_at": null
}
```

**Timezones** · Stored as an IANA name, not an offset — offsets are wrong twice
a year. "09:00 Europe/London" is 09:00Z in winter and 08:00Z in summer, and the
stored UTC instant shifts accordingly. Both DST edge cases are handled: a 02:30
daily job fires **once** on the spring-forward day (when 02:30 does not exist)
and **once** on the fall-back day (when it happens twice).

**Misfire policy** — what happens after a scheduler outage:

| Policy | Behaviour |
|---|---|
| `SKIP` *(default)* | Fire once for the most recent missed slot, fast-forward past the rest |
| `FIRE_ONCE` | Fire once for the oldest missed slot, advance one step |
| `BACKFILL` | Materialise every missed slot, capped by `catchup_limit` |

> `SKIP` is the default because silent backfill turns a scheduler outage into a
> downstream one: recovery generates a thundering herd of catch-up jobs against
> a system that just came back up.

**Validation** · Expression parsed server-side · schedules firing more than once
a minute are rejected with `422 CRON_TOO_FREQUENT` · `timezone` must be a valid
IANA name.

### `trigger` vs the schedule

`POST /scheduled-jobs/{id}/trigger` creates a job **without** a
`scheduled_for` slot, so it does not occupy a real cron slot — the normal
schedule for that minute still fires. Invaluable for demos and on-call.

---

## 8. Workers

**Read-only. There is deliberately no `POST /workers`.**

Workers register themselves through the *database*, not over HTTP. A worker that
can only reach Postgres is still fully functional, which keeps the API entirely
off the critical path of job execution. That is a real availability property,
not an implementation detail.

| Method | Path |
|---|---|
| `GET` | `/orgs/{orgId}/workers` — the fleet, with derived health |
| `GET` | `/workers/{workerId}` — detail + currently running jobs |
| `GET` | `/workers/{workerId}/heartbeats?window=1h\|6h\|24h` — chart data |

```jsonc
{
  "id": "uuid", "name": "worker-2", "status": "ACTIVE",
  "hostname": "de85cf796ebf", "concurrency": 10, "active_job_count": 3,
  "seconds_since_heartbeat": 2,
  "health": "healthy",                // healthy | lagging | dead
  "queues": [{ "id": "uuid", "name": "webhooks" }]
}
```

> `health` has three states, not two. **`lagging`** (heartbeat older than 2
> intervals but under the death timeout) is where an operator catches a
> degrading worker *before* it takes jobs down with it.

---

## 9. Dead letter queue

The DLQ is an **inbox**, not an error log. Every entry is a work item needing a
human decision: fix the input and replay, or accept the loss.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/projects/{id}/dlq` | `?resolved=false` (default), `queue_id`, `reason` |
| `GET` | `/projects/{id}/dlq/groups` | **Grouped by error signature** |
| `GET` | `/dlq/{id}` | Full entry with every execution |
| `POST` | `/dlq/{id}/replay` | → `201` |
| `POST` | `/dlq/{id}/discard` | → `200` |

### Groups

```jsonc
{
  "data": [{
    "error_signature": "HTTP_5XX:post <url> returned <n>",
    "error_code": "HTTP_5XX",
    "sample_message": "POST https://api.internal/hook returned 503",
    "count": 412,
    "first_seen": "2026-08-20T14:02:00Z",
    "last_seen": "2026-08-20T14:19:00Z",
    "queues": ["webhooks"]
  }]
}
```

> 400 dead-lettered jobs are usually 3 problems. The signature normalises ids,
> timestamps, URLs and numbers so identical failures collapse into one group —
> turning a table dump into a triage list.

### Replay

```jsonc
// POST /dlq/{id}/replay
{ "payload": { /* optional corrected payload */ }, "queue_id": "optional" }
```
```jsonc
// 201 Created
{ "id": "new-job-uuid", "status": "QUEUED", "parent_job_id": "original-uuid", "dlq_id": "uuid" }
```

Creates a **new** job from `payload_snapshot` (a copy taken at dead-letter time,
so replay still works after retention purges the original). The entry is marked
`REPLAYED` under a `WHERE resolved_at IS NULL` guard, so a double-clicked Replay
button produces exactly one job — the second call gets `409 ALREADY_RESOLVED`
naming the existing replay.

**Reasons** · `MAX_ATTEMPTS_EXCEEDED` · `NON_RETRYABLE_ERROR` · `TIMEOUT` ·
`LEASE_EXPIRED` · `CANCELLED_BY_SYSTEM`

---

## 10. Metrics and health

| Method | Path | Notes |
|---|---|---|
| `GET` | `/projects/{id}/metrics/overview` | Dashboard stat cards |
| `GET` | `/projects/{id}/metrics/throughput` | `?window=1h\|24h\|7d&bucket=1m\|5m\|1h&queue_id=` |
| `GET` | `/projects/{id}/metrics/latency` | p50/p95/p99 queue-wait and execution time |
| 🔓 `GET` | `/health` | Liveness. **Never touches the database** |
| 🔓 `GET` | `/ready` | Readiness — DB reachable and migrations current |
| 🔓 `GET` | `/metrics` | Prometheus exposition |

> `/health` deliberately does not check Postgres. If it did, a brief database
> blip would get every healthy API process restarted by the orchestrator —
> turning a short outage into a long one. Liveness answers "is this process
> wedged", nothing else. `/ready` is where dependency checks belong: failing it
> removes the instance from the load balancer without killing it.

Throughput is served from pre-aggregated per-minute rollups, not from
`job_executions`. Answering it from raw executions would aggregate millions of
rows on every dashboard poll. **Cost: metrics lag by up to 60 seconds** — a
deliberate trade to keep job completion off a contended counter row.

---

## 11. Error codes

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 / 422 | Request or payload failed validation — see `details` |
| `UNAUTHENTICATED` | 401 | Missing, invalid or expired credentials |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `NOT_FOUND` | 404 | Does not exist, **or belongs to another tenant** |
| `CONFLICT` | 409 | Duplicate — e.g. email already registered |
| `QUEUE_PAUSED` | 409 | Queue is paused; pass `allow_when_paused` to override |
| `ILLEGAL_STATE_TRANSITION` | 409 | e.g. cancelling an already-completed job |
| `ALREADY_RESOLVED` | 409 | DLQ entry already replayed or discarded |
| `IN_USE` | 409 | Still referenced — e.g. a retry policy a queue depends on |
| `UNKNOWN_HANDLER` | 422 | No such handler; the message lists the valid ones |
| `INVALID_CRON` | 422 | Expression does not parse |
| `CRON_TOO_FREQUENT` | 422 | Would fire more than once a minute |
| `PAYLOAD_TOO_LARGE` | 413 | Payload exceeds 256 KB |
| `RATE_LIMITED` | 429 | Slow down |
| `INTERNAL_ERROR` | 500 | Unexpected. Quote the `request_id` |

`INTERNAL_ERROR` never echoes the underlying message — it may contain SQL,
column names or connection strings. The `request_id` is the bridge to the log
line that has the detail.

---

## 12. Worked example, end to end

```bash
BASE=http://localhost:3000/api/v1

# 1. Register (or log in) and capture the token
TOKEN=$(curl -s -X POST $BASE/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-enough-password","name":"You","org_name":"Acme"}' \
  | jq -r .access_token)

# 2. Find your project and a queue
PROJ=$(curl -s $BASE/projects -H "authorization: Bearer $TOKEN" | jq -r '.data[0].id')
QUEUE=$(curl -s $BASE/projects/$PROJ/queues -H "authorization: Bearer $TOKEN" | jq -r '.data[0].id')

# 3. Create a job — idempotently
curl -s -X POST $BASE/queues/$QUEUE/jobs \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-4711-confirmation' \
  -d '{"handler":"simulate","payload":{"duration_ms":500},"priority":"HIGH"}' | jq

# 4. Same key again → 200 and the SAME job, not a second one
curl -s -i -X POST $BASE/queues/$QUEUE/jobs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-4711-confirmation' \
  -d '{"handler":"simulate","payload":{"duration_ms":500},"priority":"HIGH"}' \
  | grep -E '^HTTP|X-Idempotent-Replay'

# 5. Watch it run
JOB=$(curl -s "$BASE/projects/$PROJ/jobs?limit=1" -H "authorization: Bearer $TOKEN" | jq -r '.data[0].id')
curl -s $BASE/jobs/$JOB -H "authorization: Bearer $TOKEN" | jq '{status, attempt_count, executions}'

# 6. Triage failures
curl -s $BASE/projects/$PROJ/dlq/groups -H "authorization: Bearer $TOKEN" | jq
```

---

**See also** · [ARCHITECTURE.md](ARCHITECTURE.md) — why the API is shaped this
way · [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) — the trade-offs behind each
choice · [DATABASE.md](DATABASE.md) — the schema these endpoints sit on.
