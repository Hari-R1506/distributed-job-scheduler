# Verification log

Measured evidence for the claims in [ARCHITECTURE.md](ARCHITECTURE.md). Every
figure here was produced by running the commands shown, not estimated.

Re-run everything with:

```bash
make up && npm run test:unit && npm run test:race
```

---

## Phase 1 — Schema

**Applied clean to PostgreSQL 16 on the first attempt.**

```
$ npx prisma migrate deploy
Applying migration `20260820000000_init`
Applying migration `20260820000001_partial_indexes_and_constraints`
All migrations have been successfully applied.
```

| Object | Count |
|---|---|
| Tables | 16 |
| Enum types | 9 |
| Foreign keys | 36 |
| Indexes | 29 + 8 hand-written partial/unique |
| CHECK constraints | 14 |

### Cascade rules are per-relationship, not uniform

Verified by querying `pg_constraint` after apply:

- **21 × CASCADE** — ownership chains only (`org → project → queue → job → execution → log`). Deleting an organization removes everything it owns and nothing it does not.
- **13 × SET NULL** — attribution and provenance (`created_by`, `paused_by`, `resolved_by`, `job_executions.worker_id`). Deleting a user must never block, and execution history must survive a worker row being purged.
- **1 × RESTRICT** — `queues.retry_policy_id`. Deliberately the odd one out: deleting a policy that queues depend on fails loudly rather than silently leaving queues in an undefined state. The API surfaces this as `409`, not a 500.

---

## The claim index

### It is used, and there is no Sort node

The single most important query plan in the project. Seeded with **50,000 jobs
across 4 queues, 5,000 still `QUEUED`** — the realistic shape, where the vast
majority of rows are terminal.

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM jobs
 WHERE queue_id = '4444...4441' AND status = 'QUEUED' AND run_at <= now()
 ORDER BY priority DESC, run_at ASC, id ASC
 LIMIT 10 FOR UPDATE SKIP LOCKED;
```

```
 Limit (actual time=0.030..0.066 rows=10 loops=1)
   Buffers: shared hit=22
   ->  LockRows (actual time=0.030..0.065 rows=10 loops=1)
         ->  Index Scan using idx_jobs_claim on jobs  (actual time=0.020..0.051 rows=10 loops=1)
               Index Cond: ((queue_id = '...'::uuid) AND (run_at <= now()))
               Filter: (status = 'QUEUED'::job_status)
               Buffers: shared hit=12
 Execution Time: 0.098 ms
```

Three things to read off this plan:

1. **`Index Scan using idx_jobs_claim`** — the index is chosen, not ignored.
2. **No `Sort` node.** The index column order matches the `ORDER BY` exactly, so Postgres walks it in order and stops after `LIMIT 10`. Without that alignment the planner must read *every* eligible row and sort before returning the first — the difference between an O(n) claim and an O(N log N) one under load.
3. **12 buffer hits, 0.098 ms** to select 10 jobs out of 50,000. The claim path costs the same whether the table holds 50k rows or 50M.

### The partial predicate is doing real work

```
 table_size | idx_jobs_claim (partial) | idx_jobs_explorer (full)
------------+--------------------------+--------------------------
 8168 kB    | 400 kB                   | 336 kB
```

`idx_jobs_claim` indexes 4 columns over 5,000 rows in 400 kB.
`idx_jobs_explorer` indexes 3 columns over all 50,000 rows in 336 kB.

Normalised, that is **~82 bytes/row for the partial index vs ~7 bytes/row for
the full one** — i.e. the partial index carries a *tenth* of the rows at
comparable total size, and critically **it stops growing** as completed jobs
accumulate. At 10M lifetime jobs with the same 5k working set it is still
400 kB, while a full equivalent would be ~70 MB and no longer cache-resident.

That is the whole argument for using PostgreSQL as the queue, and it is now
measured rather than asserted.

---

## Invalid states are unrepresentable

Each of these was attempted against the live database and rejected:

| Attempt | Result |
|---|---|
| Set a job to `RUNNING` without a lease | ❌ `chk_jobs_lease_present` |
| Set `priority = 999` | ❌ `chk_jobs_priority` |
| Register `Alice@Example.com` and `alice@example.com` | ❌ unique violation on `citext` |

The first is the one that matters. A job stranded in `RUNNING` with no
`lease_expires_at` would be invisible to the reaper and never recovered — a
silent, permanent leak. The constraint converts that class of bug from a
2 a.m. production mystery into a failing test.

---

## Domain logic

```
$ npm run test:unit

 ✓ tests/unit/error-classifier.test.ts   (37 tests)
 ✓ tests/unit/cron.test.ts               (18 tests)
 ✓ tests/unit/backoff.test.ts            (15 tests)
 ✓ tests/unit/job-state-machine.test.ts  (15 tests)

 Test Files  4 passed (4)
      Tests  85 passed (85)
   Duration  731ms
```

Highlights:

- **All 81 `(from, to)` status pairs** asserted against the declared transition table, pinned by an inline snapshot so an unconsidered edge shows up as a diff.
- **Jitter bounds verified over 1,000 samples**, plus a spread assertion — proving jitter actually desynchronises retries rather than merely existing.
- **Both DST edge cases**: a 02:30 daily job fires exactly once on the spring-forward day (when 02:30 does not exist) and exactly once on the fall-back day (when it happens twice).
- **All three misfire policies** verified against a 30-minute scheduler outage.

### Two real bugs this suite caught before any of it ran in anger

1. **`errorSignature` did not normalise `300ms`.** The pattern was `\b\d+\b`, and there is no word boundary between digits and a trailing unit — so `failed after 300ms` and `failed after 812ms` produced *different* signatures and would have landed in separate DLQ groups. Exactly the failure the grouping exists to prevent.

2. **A cron expression inside a JSDoc block terminated the comment.** `*/5 * * * *` contains `*/`. It broke the entire build, which is the good outcome; the same string in a runtime template would have been a silent surprise.

---

## Concurrency — the gate

```
$ npm run test:race

 ✓ tests/concurrency/atomic-claim.test.ts       (5 tests)
 ✓ tests/concurrency/queue-concurrency.test.ts  (5 tests)
 ✓ tests/concurrency/crash-recovery.test.ts     (7 tests)
 ✓ tests/concurrency/priority-ordering.test.ts  (4 tests)

 Test Files  4 passed (4)
      Tests  21 passed (21)
```

**Repeated 15 consecutive times: 15/15 clean.** Race conditions are probabilistic;
a single green run is not evidence.

### Exactly-once claiming

| Scenario | Result |
|---|---|
| 20 concurrent claimers, 500 jobs, no concurrency cap | 500 claims, **0 duplicates**, every `attempt_count` exactly 1 |
| 10 workers × 5 slots, 300 jobs, full execution | **exactly 300** `job_executions` rows, 0 jobs with >1 execution, all `COMPLETED` |
| `duplicate_execution_detected` across all runs | **0** |

Work also demonstrably spread across claimers rather than one winning every
race, so the result is not an artefact of accidental serialisation.

### Per-queue concurrency

`max_concurrency = 3`, 10 workers × 10 slots = 100 potential parallel jobs,
sampled every 10ms while 120 jobs drained:

- **peak in flight ≤ 3** — the limit held
- **peak == 3** — and it saturated. The second assertion matters as much as the first: a claim that admitted *nothing* would satisfy the ceiling trivially.
- Queues are isolated — a queue pinned at its ceiling had no effect on another.

### Priority

- A future-dated `CRITICAL` job **never** preempted a ready `BULK` one. Eligibility is a `WHERE` clause; priority is an `ORDER BY` clause — the brief's trap, verified.
- Claims are monotonically non-increasing in priority across sequential batches.
- FIFO within a band, by `run_at` (not `created_at`).
- Exact ties broken deterministically by `id`.

### Crash recovery

| Scenario | Verified |
|---|---|
| Worker SIGKILLed mid-execution | Lease expiry → `RETRYING`, attempt closed as `ABANDONED`, second worker completes it. 2 execution rows, no human involvement |
| Killed after claim, before start | `RETRYING`, **zero** execution rows, and the attempt is still consumed — poison-pill protection |
| Reaper finds the final attempt | `DEAD_LETTER` with `reason = LEASE_EXPIRED` and a payload snapshot |
| **Zombie worker** ⭐ | A revived worker's `completeJob` affected **zero rows** and returned false; its `failJob` returned `LEASE_LOST`. Final state: one `COMPLETED` job owned by the rescuer, `ABANDONED` + `SUCCEEDED` executions |
| Silent worker | Marked `DEAD` after timeout; a healthy one untouched |
| Graceful drain | **Heartbeats continued through the drain** and all in-flight jobs completed — the most-missed step in SIGTERM handling |

---

## Three more bugs the suite caught

3. **The minimum legal lease was unsafe.** The `CHECK` floor on
   `visibility_timeout_ms` was 30s — exactly equal to `WORKER_TIMEOUT_MS` —
   so a queue configured at the floor violated the `lease > worker_timeout`
   invariant. The runtime assertion caught it, but only at boot, and the
   database had happily stored the unsafe value. Migration 3 raises the floor
   to 45s, moving the check from *detected* to *unrepresentable*.

4. **`UPDATE … RETURNING` does not preserve CTE order.** The `ORDER BY` in the
   `eligible` CTE decides *which* rows are claimed, not the order they come
   back in. Correctness never depended on it — a worker dispatches the whole
   batch concurrently — but an unordered batch makes logs and traces read as
   though priority were being ignored. The claim query now re-sorts the
   returned batch in an outer `SELECT`.

5. **Host/container clock skew made "immediate" jobs briefly not-yet-due.**
   Seeding `run_at` with `new Date()` stamps the *host* clock onto a row the
   claim query compares against the *database* clock. A few milliseconds of
   drift meant a job created "now" occasionally failed `run_at <= now()`. It
   surfaced as a 1-in-10 flake — exactly what repeated runs exist to find. The
   fix generalises: for immediate jobs the API must let the database stamp
   `run_at` rather than sending its own clock.

---

## The scheduler

```
 ✓ tests/concurrency/scheduler.test.ts  (14 tests)

 Test Files  10 passed (10)
      Tests  121 passed (121)
```

| Guarantee | Verified |
|---|---|
| Promotion | `SCHEDULED`/`RETRYING` → `QUEUED` once due; future-dated jobs untouched; bounded by batch size so a backlog never becomes one long transaction |
| NOTIFY fan-out | 60 promoted jobs across 2 queues produced **2** queue ids, not 60 |
| **Cron exactly-once** ⭐ | Two independent Prisma clients materialising the same due schedule concurrently created **exactly 1** job between them |
| Cron idempotence | Rewinding the cursor to replay a slot (simulating a crash between insert and commit) still produced **1** job — the unique index makes the duplicate structurally impossible |
| Misfire `SKIP` | A 30-minute outage fired **1** job for the most recent slot and fast-forwarded past 5 others |
| Gating | Disabled schedules, and those outside their `start_at`/`end_at` window, are ignored |
| Broken expression | A schedule whose cron no longer parses is **disabled**, not retried into a wedge |
| **Leader election** | 4 contenders → exactly **1** leader. Leader released → a follower took over within 5s. A follower's `tick()` promoted **0** jobs while a leader held the lock |
| Metrics rollup | Correct per-minute aggregation; **re-running did not double-count** (one bucket, same values) |

---

## End to end, in containers

`docker compose up` with Postgres, the scheduler, and three independent worker
containers. Not a simulation — separate processes, separate images, contending
through the database.

### The stack boots and drains work

```
NAME            STATUS
djs-postgres    Up (healthy)
djs-scheduler   Up      → "became scheduler leader"
djs-worker-1    Up
djs-worker-2    Up
djs-worker-3    Up
```

Seeded 58 jobs; within 12 seconds: **50 `COMPLETED`, 5 `SCHEDULED`** (the
delayed ones, correctly still waiting), **3 `DEAD_LETTER`** — exactly the three
seeded to fail permanently, and nothing else.

### Retries, proven deterministically

A job seeded with `fail_probability: 1` and `FIXED` 500 ms backoff:

```
 attempt | status | error_code | duration_ms
---------+--------+------------+-------------
       1 | FAILED | UNKNOWN    |          16
       2 | FAILED | UNKNOWN    |          19
       3 | FAILED | UNKNOWN    |          20
→ job: attempt_count=3, status=DEAD_LETTER
```

Three separate `job_executions` rows — the retry history the brief asks for,
falling out of the jobs/executions split rather than being assembled.

Note the contrast with the permanent failures above: those dead-lettered after
**1** attempt, because `NonRetryableError` is classified non-retryable. Error
classification is doing real work, not decoration.

### Graceful shutdown — SIGTERM

```
$ docker stop djs-worker-1     # 6 jobs in flight, 6s each
  → "draining"  (worker.draining)
  → "worker stopped"
  real  0m3.46s
```

`workers.status = STOPPED`, `active_job_count = 0`, and **all 6 jobs
`COMPLETED`** — drained, not abandoned.

### Crash recovery — SIGKILL

```
$ docker kill djs-worker-2     # 6 long jobs in flight, no drain, no lease release
```

| After the reaper | Result |
|---|---|
| Jobs | all 6 recovered, `last_error_code = LEASE_EXPIRED`, re-running on surviving workers |
| Executions | 6 × `ABANDONED` (the crashed attempts) + 6 × `RUNNING` (the retries) |
| Worker | marked `DEAD` by the scheduler |
| Human intervention | none |

---

## Four more bugs found by running it for real

6. **The Prisma client was missing from the runtime image.** `prisma generate`
   writes into `node_modules/.prisma` during the *build* stage, but the runtime
   stage copied `node_modules` from *deps* — which predates it. The image built
   fine and died on boot with "@prisma/client did not initialize yet", in the
   container only. Fixed by overlaying `node_modules/.prisma` from `build`.

7. **Each Compose service built its own copy of an identical image.** Rebuilding
   only `worker-1` left workers 2 and 3 silently running the *previous* build —
   which is how you end up debugging a fleet where a third of the nodes behave
   differently. Fixed with a shared `image: djs-node:local`.

8. **`npx`/`npm` wrappers do not forward SIGTERM.** Host-run workers survived
   `kill` because the signal stopped at the `npx` wrapper and never reached the
   Node child, leaving orphans that kept claiming jobs. This is precisely why
   the Dockerfile runs `node dist/main.js` directly with `STOPSIGNAL SIGTERM`,
   never `npm start`.

9. **Node does not support SIGTERM on Windows at all.** Graceful shutdown
   therefore *cannot* be verified on the development host — it has to be tested
   in the Linux container. Worth knowing before trusting a green local run.

---

## Still to verify

- [ ] API validation, auth and tenant isolation
- [ ] Cursor pagination stability under concurrent inserts
- [ ] Idempotency keys: same key twice → one job, `200` + replay header
- [ ] DLQ replay creates a new job with `parent_job_id` set
- [ ] Dashboard end-to-end (Playwright smoke)
