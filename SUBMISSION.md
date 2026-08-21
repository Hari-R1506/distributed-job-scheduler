# Submission — Distributed Job Scheduler

**Codity.AI · Intern Technical Assignment**

| | |
|---|---|
| **Candidate** | Hari R |
| **Repository** | **https://github.com/Hari-R1506/distributed-job-scheduler** |
| **Submitted** | 21 August 2026 |
| **Stack** | TypeScript · NestJS · PostgreSQL 16 · React · Docker |

---

## What was built

A distributed job scheduling platform where **multiple worker processes claim
from the same queues concurrently and never execute the same job twice**, and
where any worker can be killed at any moment without losing work or requiring
human intervention.

Seven containers start with one command: PostgreSQL, a REST API, a
leader-elected scheduler, three independent workers, and a React dashboard.

The governing design decision, from which every reliability property follows:

> **The database is the queue. Workers hold short transactions to *claim* work,
> and hold no transaction while *doing* work.**

---

## Deliverables

| # | Required | Where |
|---|---|---|
| 1 | Source code + setup instructions | [repository](https://github.com/Hari-R1506/distributed-job-scheduler) · [README.md](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/README.md) · [docs/SETUP.md](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/docs/SETUP.md) |
| 2 | Architecture diagram | [docs/ARCHITECTURE.md](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/docs/ARCHITECTURE.md) — 6 diagrams |
| 3 | ER diagram | [docs/DATABASE.md](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/docs/DATABASE.md) — 16 tables |
| 4 | API documentation | [docs/API.md](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/docs/API.md) · live Swagger at `/docs` · [openapi.json](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/docs/api/openapi.json) |
| 5 | Design decisions | [docs/DESIGN-DECISIONS.md](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/docs/DESIGN-DECISIONS.md) — 12 trade-offs |
| 6 | Automated tests | [`tests/`](https://github.com/Hari-R1506/distributed-job-scheduler/tree/main/tests) — unit · integration · concurrency |

**Consolidated technical design document (Word):**
[docs/Distributed-Job-Scheduler-Technical-Design.docx](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/docs/Distributed-Job-Scheduler-Technical-Design.docx) — 26 pages

**Measured evidence for every claim below:**
[docs/VERIFICATION.md](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/docs/VERIFICATION.md)

---

## Evaluating it in five minutes

```bash
git clone https://github.com/Hari-R1506/distributed-job-scheduler.git
cd distributed-job-scheduler
cp .env.example .env
npm install && npm run db:generate
docker compose up -d --build
```

Register an account at **http://localhost:5173**, then `npm run seed`.

### The demonstration

Open the **Workers** page, then:

```bash
docker kill djs-worker-2
```

SIGKILL — instant termination, no drain, no lease release. Equivalent to a
server losing power mid-job.

- **~30 s** — the scheduler marks the worker `DEAD` after six missed heartbeats
- **~60 s** — the reaper finds its expired leases, closes those attempts as `ABANDONED`, and requeues the jobs
- surviving workers claim and complete them

Nothing is lost, and nobody intervenes. Contrast with `docker stop`, which sends
SIGTERM: the worker drains its in-flight jobs and exits cleanly in ~3 seconds,
with no job retried.

---

## Where the engineering is

The rubric weights architecture, database and backend at 60 of 100 marks.
Effort was allocated accordingly.

### Atomic claiming — the core

`FOR UPDATE SKIP LOCKED` inside a **per-queue advisory lock**. The lock is not
decorative: `SKIP LOCKED` alone cannot enforce a per-queue concurrency limit,
because that limit is a constraint over an *aggregate*, and aggregates are not
lockable. Two workers reading the same MVCC snapshot both see zero running and
both claim full capacity. The lock is held for 1–3 ms — the duration of the
claim decision, never of execution.

`READ COMMITTED` is used deliberately: the locking is explicit, so the database
need not infer conflicts, and `SERIALIZABLE`'s serialisation failures are
avoided entirely.

### The database

**16 tables · 36 foreign keys · 14 CHECK constraints · 8 partial indexes.**

Two decisions carry the design:

- **`jobs` holds the unit of work; `job_executions` holds one row per *attempt*.** Attempts fail; jobs die. That split is what makes retry history, per-attempt timings and per-attempt errors queryable rather than squashed into an unindexable blob.
- **The claim index is partial, and its column order *is* the `ORDER BY`.** Measured at 50,000 rows: an Index Scan with **no Sort node**, 12 buffer hits, **0.098 ms**. Claim cost depends on queue depth, not table size.

Cascade rules are chosen per relationship — 21 CASCADE for ownership chains, 13
SET NULL for attribution, and one deliberate RESTRICT so deleting a retry policy
a queue depends on fails loudly rather than silently.

There are deliberately **no counter columns on `queues`**: incrementing one per
completion would take a row lock on a single row per queue, making it the
serialisation point for the entire queue.

### Reliability

Renewable leases, heartbeats, and a reaper. Attempts are counted **at claim, not
at completion** — otherwise a job that crashes its worker is reclaimed forever,
a poison pill that kills the fleet one process at a time.

Graceful shutdown **keeps heartbeating while draining**. Stop, and the reaper
reclaims your in-flight jobs while you are still running them — causing the
duplicate execution the design exists to prevent, on every deploy.

Cron materialisation is guarded **twice**: an optimistic CAS on the cursor, and a
unique index on `(scheduled_job_id, scheduled_for)`. Belt and braces is right
there and nowhere else — a nightly billing job firing twice is silent and
unrecoverable.

---

## Verification

Claims in the documentation are measured, not asserted.

| Check | Result |
|---|---|
| Backend + frontend type checking | 0 errors |
| Unit tests | 85 / 85 passing |
| Migrations against PostgreSQL 16 | Applied clean, first attempt |
| Claim query plan | Index Scan, **no Sort node**, 0.098 ms over 50k rows |
| Exactly-once claiming | 20 concurrent claimers, 500 jobs → 500 claims, **0 duplicates** |
| Per-queue concurrency | Never exceeded — *and* demonstrably saturated |
| Cron under two schedulers | Exactly one job materialised |
| Containerised SIGTERM drain | All in-flight jobs `COMPLETED`, exit 0 in 3.5 s |
| Containerised SIGKILL recovery | All jobs recovered by surviving workers |

Testcontainers is used rather than a mock, deliberately: an in-memory database
cannot exhibit `SKIP LOCKED` semantics, row locks or MVCC snapshots, so a mocked
concurrency test proves nothing about the property it claims to verify.

---

## Scope decisions

**Built from the bonus list** — distributed locking (leader election, which the
scheduler needs anyway) and event-driven execution (`LISTEN/NOTIFY`, with
polling underneath as the correctness guarantee).

**Deliberately not built** — queue sharding, workflow DAGs, and multi-region.
Each is documented in [DESIGN-DECISIONS.md](https://github.com/Hari-R1506/distributed-job-scheduler/blob/main/docs/DESIGN-DECISIONS.md#911-deliberately-not-built)
with what it would take and why it did not earn its place. A half-working DAG
engine reads worse than none.

**One guarantee stated honestly:** exactly-once execution is impossible when
side effects are external to the database — the worker cannot atomically "send
the email" and "record that it sent the email". The system guarantees
**at-least-once** and pushes idempotency to the boundary, giving handlers a
stable token to deduplicate with. Claiming exactly-once would be false.

---

## Repository

**https://github.com/Hari-R1506/distributed-job-scheduler**

```
packages/core       pure domain logic — no I/O, imported by every service
packages/db         Prisma schema, migrations, and the hot-path SQL
apps/api            NestJS REST API — 56 operations
apps/worker         claim loop, executor pool, heartbeat, handler registry
apps/scheduler      promotion, cron, reaper, metrics rollup, leader election
apps/web            React dashboard, served by nginx
tests/              unit · integration · concurrency
```

`packages/db/sql/claim-jobs.sql` is the most important file in the project.
