# Design decisions

The major architectural choices, each with the alternative that was rejected and
**what the choice costs**. A trade-off with no stated cost is not a trade-off.

Deeper reasoning for any of these lives in
[ARCHITECTURE.md](ARCHITECTURE.md); measured evidence lives in
[VERIFICATION.md](VERIFICATION.md).

---

## The one decision everything else follows from

> **The database is the queue. Workers hold *short* transactions to *claim*
> work, and hold *no* transaction while *doing* work.**

Every reliability property in this system is a consequence of that rule, and
most of the decisions below are it applied to a specific problem.

---

### 1 Queue substrate — PostgreSQL vs. Redis/broker

| | |
|---|---|
| **A** | Postgres as the queue (`SKIP LOCKED`) |
| **B** | Redis (Streams / BullMQ) or RabbitMQ, with Postgres for history |
| **Chosen** | **A** |

Option B is faster — tens of thousands of jobs/second — but it splits the system in two. Creating a job now means writing to Postgres *and* pushing to Redis, and there is no transaction spanning both. Crash in between and you get a job that exists in the UI but never runs (or runs but was never recorded). The standard fixes — transactional outbox, or CDC — are more machinery than this entire assignment. Meanwhile Postgres gives us atomic creation, atomic claiming, transactional cron materialisation, and one backup. `SKIP LOCKED` exists precisely for this pattern.

**Cost, stated plainly:** a ceiling around 1,000–5,000 jobs/s and more write amplification than a purpose-built broker. Four orders of magnitude above what this project needs. Documented in Part 23.

### 2 Job discovery — polling vs. push

| | |
|---|---|
| **A** | Polling only |
| **B** | `LISTEN/NOTIFY` only |
| **C** | **Both: NOTIFY for latency, polling for correctness** |
| **Chosen** | **C** |

A wastes queries and adds latency. B is elegant and *unsafe*: a notification delivered while a worker is reconnecting is gone forever, and the job waits until something else happens to wake the worker. C makes push an optimisation over a correct baseline — if every notification were lost, the system would still be correct, just slower. That property is what makes it the right answer, and it is worth stating in exactly those terms.

**Cost:** two code paths, and a dedicated non-pooled connection per worker for `LISTEN`.

### 3 Worker topology — in-process vs. separate

| | |
|---|---|
| **A** | Workers as threads/promises inside the API |
| **B** | **Separate worker processes** |
| **Chosen** | **B** |

Different scaling axis (add workers, not API capacity), different failure domain (a handler that OOMs must not take down the dashboard), different lifecycle (graceful 30s drain vs. instant restart). It is also the only way to *demonstrate* distributed behaviour, which the brief explicitly asks for.

**Cost:** more moving parts in Compose, and shared code must live in `packages/core` rather than being casually imported.

### 4 Scheduler placement — dedicated deployable vs. leader election

| | |
|---|---|
| **A** | A separate service you must run exactly one of |
| **B** | **Leader election via `pg_try_advisory_lock`** |
| **Chosen** | **B** |

A works until someone scales it to 2 and every cron fires twice. B makes correctness structural rather than procedural, gives automatic failover when the leader's session dies, and *is* the distributed-locking bonus.

**Cost:** ~40 lines of election logic, and one leadership-failover test.

### 5 Concurrency enforcement — lock-free vs. advisory lock

| | |
|---|---|
| **A** | Count running jobs inside the claim CTE, no lock (soft limit) |
| **B** | **`pg_advisory_xact_lock(queue_id)` around the claim decision** |
| **Chosen** | **B** |

A is lock-free and *wrong*: two workers reading the same MVCC snapshot both see 0 running and both claim the full capacity. `SKIP LOCKED` cannot help, because the conflict is over an aggregate, not over rows. B makes the count exact by serialising the claim *decision* — for 1–3 ms, per queue, never across queues, and never during execution.

**Cost:** claims on a single queue serialise, capping that queue at roughly 300–1,000 claim transactions/second. Each claim takes a batch, so effective throughput is far higher. Escape hatch documented (a slot-lease table).

### 6 Sessions vs. JWT

| | |
|---|---|
| **A** | Server sessions in Postgres |
| **B** | Long-lived JWT in `localStorage` |
| **C** | **Short JWT in memory + rotating refresh token in an httpOnly cookie** |
| **Chosen** | **C** |

B is the common shortcut and it is XSS-exposed — any injected script reads the token. A requires a DB hit per request and complicates API-key auth. C keeps the access token out of any persistent store, keeps the refresh token unreachable from JavaScript, and gives 15-minute revocation granularity. API keys take a separate path with their own hashed lookup.

**Cost:** refresh-rotation logic in the API client, including collapsing concurrent 401s into a single refresh.

### 7 Retry policy — referenced vs. snapshotted

| | |
|---|---|
| **A** | Jobs read `queue.retry_policy_id` live at failure time |
| **B** | **Copy the policy values onto the job at creation** |
| **Chosen** | **B** |

A means editing a queue's policy silently rewrites the contract of thousands of in-flight jobs, including ones already mid-backoff — and makes historical behaviour unexplainable ("why did this job stop at 3 attempts when the policy says 5?"). B makes every job self-describing and its history reproducible.

**Cost:** five denormalised columns on `jobs`, and a policy edit does not apply retroactively — which is the intended behaviour, surfaced in the UI.

### 8 Live updates — polling vs. WebSockets

| | |
|---|---|
| **A** | **Polling via TanStack Query** |
| **B** | WebSockets only |
| **C** | Polling, with WS as a progressive enhancement |
| **Chosen** | **A**, then **C** if time allows |

Polling at a per-view cadence is ~20 lines, degrades gracefully, survives reconnects, and needs no server-side fan-out or sticky sessions. WS is genuinely better UX and is worth adding — but as an *invalidation signal* into the same query cache, so there is one data path either way and a dropped socket silently falls back to the timer.

**Cost:** up to 5s of staleness before the WS upgrade lands.

### 9 Pagination — offset vs. cursor

| | |
|---|---|
| **A** | `LIMIT/OFFSET` |
| **B** | **Keyset (cursor) on `(created_at, id)`** |
| **Chosen** | **B** |

On a table taking thousands of inserts a minute, offset pagination is *incorrect*, not merely slow: rows shift between requests, so users see duplicates and miss records. Deep offsets also force Postgres to scan and discard everything before the window. Keyset is O(log n) at any depth and stable under concurrent inserts.

**Cost:** no "jump to page 7". Acceptable — nobody jumps to page 7 of a job list; they filter.

### 10 Attempt counting — at claim vs. at completion

| | |
|---|---|
| **A** | Increment when an attempt *finishes* |
| **B** | **Increment at claim** |
| **Chosen** | **B** |

Under A, a job that crashes its worker before recording anything is reclaimed forever — a poison pill that kills the fleet one process at a time. B counts *deliveries*, as SQS does, so any crash-inducing job exhausts its attempts and dead-letters.

**Cost:** a job whose worker died before it ever ran still burns an attempt. Surfaced honestly in the UI as *"Attempt 1 — never started (worker lost)"*.

### 11 Promotion loop vs. a smarter claim query

| | |
|---|---|
| **A** | Claim with `status IN ('QUEUED','SCHEDULED','RETRYING') AND run_at <= now()` — no promotion loop |
| **B** | **A scheduler that promotes due jobs to `QUEUED`** |
| **Chosen** | **B** |

A is simpler and removes a moving part — a genuinely reasonable choice. B was chosen because the partial claim index then covers only truly-ready jobs rather than every future-dated and backing-off row (the entire performance argument for that index), because the brief names `Scheduled → Queued` as a lifecycle transition, and because `queued_count` becomes a cheap indexed count.

**Cost:** up to 1s of promotion latency, and the scheduler becomes necessary for timely execution (though never for correctness — jobs promote late, never never).

### 12 DLQ replay — new job vs. reset

| | |
|---|---|
| **A** | Reset the original job to `QUEUED`, `attempt_count = 0` |
| **B** | **Create a new job with `parent_job_id`** |
| **Chosen** | **B** |

A destroys the history you built an entire table to capture, and makes "replayed with a corrected payload" unrepresentable. B preserves the full chain and makes replay naturally idempotent via the `resolved_at IS NULL` guard.

**Cost:** an extra row per replay, and the UI must render the parent/child chain.

---
