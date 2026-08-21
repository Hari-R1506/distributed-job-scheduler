# Deliverables

Every item the assignment asks for, and where it is.

| # | Required | Delivered as | Status |
|---|---|---|---|
| 1 | Source code with setup instructions | the repository · [README.md](../README.md) · [SETUP.md](SETUP.md) | ✅ |
| 2 | Architecture diagram | [ARCHITECTURE.md §3](ARCHITECTURE.md) and [§24](ARCHITECTURE.md) — 6 diagrams | ✅ |
| 3 | ER diagram | [DATABASE.md](DATABASE.md) — Mermaid, 16 tables | ✅ |
| 4 | API documentation | [API.md](API.md) · live Swagger at `/docs` · [openapi.json](api/openapi.json) | ✅ |
| 5 | Design decisions document | [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) — 12 trade-offs | ✅ |
| 6 | Automated tests for critical functionality | `tests/` — unit · integration · concurrency | ✅ |

Plus, not asked for but load-bearing: [VERIFICATION.md](VERIFICATION.md) —
measured evidence for every claim made in the architecture, including the query
plan for the claim path and the containerised crash-recovery runs.

---

## 1 · Source code and setup

```
packages/core       pure domain logic — no I/O, imported by every service
packages/db         Prisma schema, migrations, and the hot-path SQL
apps/api            NestJS REST API — 56 operations
apps/worker         claim loop, executor pool, heartbeat, handler registry
apps/scheduler      promotion, cron, reaper, metrics rollup, leader election
apps/web            React dashboard (Vite + TanStack Query), served by nginx
tools/              seed script, load generator
tests/              unit · integration · concurrency
```

**Run it:**

```bash
docker compose up -d --build
```

Then register at http://localhost:5173 and run `npm run seed`.

- [README.md](../README.md) — quick start for someone who knows Docker
- [SETUP.md](SETUP.md) — step-by-step for someone who does not, including the
  Windows `com.docker.service` issue

One `docker compose up` starts **seven containers**: Postgres, the API, the
scheduler, three independent workers, and the dashboard.

`packages/db/sql/claim-jobs.sql` is the most important file in the project.

---

## 2 · Architecture diagram

[ARCHITECTURE.md](ARCHITECTURE.md) contains six:

| Diagram | Section |
|---|---|
| High-level system architecture | §3.1 (ASCII) and §24.1 (Mermaid) |
| Component diagram | §24.2 |
| Job lifecycle state machine | §6.1 |
| Worker flow | §24.4 |
| Retry flow | §11.6 |
| ER diagram | §24.6 |

The shape in one line: **a modular NestJS monolith for the API, a fleet of
independent worker processes, and one leader-elected scheduler — all three
sharing a single PostgreSQL database that is simultaneously the system of record
and the queue.**

---

## 3 · ER diagram and database design

[DATABASE.md](DATABASE.md) — the diagram plus a table-by-table reference
covering columns, keys, indexes, constraints, cascade behaviour and the
normalisation decisions.

**16 tables · 9 enums · 36 foreign keys · 14 CHECK constraints.**

Cascade rules are chosen per relationship, not applied uniformly:

- **21 × CASCADE** — ownership chains only (`org → project → queue → job → execution → log`)
- **13 × SET NULL** — attribution (`created_by`, `worker_id`), so deleting a user never blocks and execution history survives a worker being purged
- **1 × RESTRICT** — `queues.retry_policy_id`, so deleting a policy a queue depends on fails loudly instead of leaving queues undefined

The two decisions worth defending: the **`jobs` / `job_executions` split**, and
the **partial claim index** whose column order is its `ORDER BY`.

---

## 4 · API documentation

Three forms, all generated from or checked against the running server:

| Form | Where |
|---|---|
| Written reference | [API.md](API.md) |
| Interactive | http://localhost:3000/docs — Swagger UI, "Try it out" works |
| Machine-readable | [`docs/api/openapi.json`](api/openapi.json) — OpenAPI 3.0 |

**56 operations across 9 groups:** auth (5), projects (12), queues (8), jobs
(9), schedules (9), workers (3), DLQ (5), metrics (3), health (2).

Covered in the written reference: both auth schemes, cursor pagination and why
offset is *incorrect* here, the error envelope, idempotency keys, every endpoint
with request/response bodies and status codes, the full error-code table, and a
worked end-to-end example.

---

## 5 · Design decisions

[DESIGN-DECISIONS.md](DESIGN-DECISIONS.md) — 12 decisions, each stating the
alternative rejected **and what the choice costs**.

| | Decision |
|---|---|
| 1 | PostgreSQL as the queue vs. Redis/RabbitMQ |
| 2 | Polling vs. `LISTEN/NOTIFY` — and why we use both |
| 3 | Separate worker processes vs. in-process threads |
| 4 | Leader election vs. a dedicated scheduler deployable |
| 5 | Advisory lock vs. lock-free concurrency counting |
| 6 | JWT-in-memory + rotating refresh cookie vs. sessions or `localStorage` |
| 7 | Snapshotting the retry policy onto each job vs. referencing it |
| 8 | Polling vs. WebSockets for live updates |
| 9 | Cursor vs. offset pagination |
| 10 | Counting attempts at claim vs. at completion |
| 11 | A promotion loop vs. a smarter claim query |
| 12 | DLQ replay creating a new job vs. resetting the original |

Also there: **what was deliberately not built** — queue sharding, workflow DAGs,
multi-region — each with what it would take and why it did not earn its place.

---

## 6 · Automated tests

```bash
npm run test:unit         # 85 tests, no database, ~700ms
npm run test:race         # the concurrency suite, real Postgres
npm run test:race:repeat  # the same suite 20x — races are probabilistic
```

**Unit (85)** — backoff maths for all three strategies including jitter bounds
over 1,000 samples; the job state machine asserted across **all 81 (from, to)
pairs**; error classification; cron with both DST edge cases and all three
misfire policies.

**Concurrency** — the gate. Real PostgreSQL via Testcontainers, real parallel
workers:

- **Exactly-once claiming** — 20 concurrent claimers over 500 jobs: 500 claims, 0 duplicates
- **End-to-end exactly-once** — 10 workers × 5 slots over 300 jobs: exactly 300 execution rows
- **Per-queue concurrency** — never exceeded, *and* demonstrably saturated
- **Priority** — a future-dated `CRITICAL` job never preempts a ready `BULK` one
- **Crash recovery** — SIGKILL mid-job, reaper recovers, another worker finishes
- **The zombie worker** — a revived worker's write affects zero rows
- **Cron exactly-once** — two schedulers, one job
- **Leader failover** — within 5s

An in-memory or mocked database cannot exhibit `FOR UPDATE SKIP LOCKED`
semantics, row locks or MVCC snapshots — so Testcontainers is mandatory here,
not a preference. A mocked concurrency test proves nothing about the property it
claims to verify.

---

## Reading order

If you have **5 minutes** — [README.md](../README.md), then run it and
`docker kill djs-worker-2`.

If you have **20 minutes** — [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md), then
[VERIFICATION.md](VERIFICATION.md).

If you want the **full reasoning** — [ARCHITECTURE.md](ARCHITECTURE.md), 30
sections. §7 (atomic claiming) and §21 (failure scenarios) are the heart of it.
