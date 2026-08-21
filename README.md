# Distributed Job Scheduler

Reliable background job execution across multiple workers, built on PostgreSQL.

Multiple workers claim from the same queue simultaneously and **never** run the
same job twice. Any worker can be killed at any moment and its work is recovered
automatically. Nothing is lost — the worst failure mode is *late*.

### Submission document

The complete technical design document — 27 pages, covering every assignment
deliverable with rendered architecture and ER diagrams.

- **[PDF](Hari-R_127156127_Distributed-Job-Scheduler.pdf)** — opens anywhere, no Word needed
- **[Word](Hari-R_127156127_Distributed-Job-Scheduler.docx)** — same content, editable

### Documentation

| | |
|---|---|
| **[DELIVERABLES.md](docs/DELIVERABLES.md)** | index of everything, mapped to the assignment |
| [SETUP.md](docs/SETUP.md) | step-by-step setup for a first-time Docker user |
| [API.md](docs/API.md) | API reference · live Swagger at `/docs` |
| [DATABASE.md](docs/DATABASE.md) | ER diagram and schema reference |
| [DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md) | 12 trade-offs, each with its cost |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | the full design, 30 sections |
| [VERIFICATION.md](docs/VERIFICATION.md) | measured evidence for every claim |

---

## Quick start

**Prerequisites:** Docker Desktop (running), Node 22+, npm 11+.

```bash
cp .env.example .env
npm install
npm run db:generate
docker compose up -d --build
npm run seed
```

Then open:

| | |
|---|---|
| **Dashboard** | http://localhost:5173 |
| **API docs (Swagger)** | http://localhost:3000/docs |
| **Metrics** | http://localhost:3000/metrics |
| **Health** | http://localhost:3000/health |

That starts **Postgres, the API, the scheduler, three independent worker
containers, and the dashboard**. The seed creates a demo org, 4 queues, 2 cron schedules and ~58
jobs, which the workers begin draining immediately.

> **New to Docker, or hitting errors?** Follow **[docs/SETUP.md](docs/SETUP.md)**
> instead — it explains each step and covers the Windows `com.docker.service`
> issue that causes `dockerDesktopLinuxEngine` errors.

---

## Verify it works

```bash
docker compose ps
```

All five containers should be `Up`, with `djs-postgres` healthy.

```bash
docker exec -it djs-postgres psql -U djs -d job_scheduler -c "SELECT status, count(*) FROM jobs GROUP BY status ORDER BY 2 DESC;"
```

Within ~15 seconds of seeding you should see most jobs `COMPLETED`, a few
`SCHEDULED` (delayed ones, correctly waiting), and exactly 3 `DEAD_LETTER` —
the three seeded to fail permanently.

### The demo worth watching

```bash
docker kill djs-worker-2
```

SIGKILL — no drain, no lease release. Watch the recovery:

- **~30s** the scheduler marks the worker `DEAD` (6 missed heartbeats)
- **~60s** the reaper finds its expired leases, closes those attempts as
  `ABANDONED`, and requeues the jobs
- surviving workers pick them up and finish them

Open the **Workers** page while you do this. The card turns amber, then red,
then the count of recovered jobs appears — and the Jobs page shows those jobs
picked up again by the survivors.

Nothing is lost and nobody intervenes. Compare with a graceful stop:

```bash
docker compose start worker-2
docker stop djs-worker-1     # SIGTERM — drains in-flight jobs, then exits 0
```

---

## Running the tests

```bash
npm run test:unit
```

85 tests, no database, ~700ms. Covers the backoff maths, the state machine
(all 81 transition pairs), error classification, and cron/DST handling.

```bash
npm run test:race
```

**The gate.** Real Postgres via Testcontainers, real parallel workers. Proves
exactly-once claiming under 20 concurrent claimers, per-queue concurrency
limits, priority ordering, crash recovery, and cron exactly-once under two
schedulers.

```bash
npm run test:race:repeat
```

Runs the concurrency suite 20 times. Race conditions are probabilistic — a
single green run is not evidence.

> Testcontainers starts its own throwaway Postgres. To reuse the running one
> instead (much faster), set
> `TEST_DATABASE_URL=postgresql://djs:djs_dev_password@localhost:5432/job_scheduler?schema=public`.

---

## Developing outside Docker

Run Postgres in a container and the services on the host, for fast reloads:

```bash
docker compose up -d postgres
npm run db:migrate
npm run seed
```

Then in separate terminals:

```bash
npm run dev:api
```

```bash
npm run dev:worker
```

```bash
npm run dev:scheduler
```

⚠️ **Graceful shutdown cannot be tested this way on Windows.** Node does not
support `SIGTERM` on Windows at all, and `npx`/`npm` wrappers do not forward
signals to the child process. Test draining in the container, with
`docker stop`.

---

## Using the API

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-enough-password","name":"You","org_name":"Acme"}'
```

That returns an `access_token`. Use it as `Authorization: Bearer <token>`, or
create an API key for service-to-service calls (`X-API-Key`).

Creating a job — note the `Idempotency-Key`, which makes a retried request
return the *original* job with `200` instead of creating a duplicate:

```bash
curl -s -X POST http://localhost:3000/api/v1/queues/$QUEUE_ID/jobs \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-4711-confirmation' \
  -d '{"handler":"simulate","payload":{"duration_ms":500},"priority":"HIGH"}'
```

Full reference at `/docs`. Highlights:

| Endpoint | Purpose |
|---|---|
| `POST /queues/:id/jobs` | Immediate, delayed (`delay_seconds`) or scheduled (`run_at`) |
| `POST /queues/:id/jobs/batch` | Up to 1,000 jobs, `207 Multi-Status` |
| `GET /projects/:id/jobs` | Job explorer — filtered, cursor-paginated |
| `POST /projects/:id/scheduled-jobs` | Cron schedules, IANA timezone aware |
| `POST /cron/validate` | Preview the next 5 runs of an expression |
| `GET /projects/:id/dlq/groups` | Failures grouped by error signature |
| `POST /dlq/:id/replay` | Replay with an optionally corrected payload |
| `GET /projects/:id/metrics/overview` | Dashboard stat cards |

---

## Layout

```
packages/core       pure domain logic — no I/O, imported by every service
packages/db         Prisma schema, migrations, and the hot-path SQL
apps/api            NestJS REST API (57 routes)
apps/worker         claim loop, executor pool, heartbeat, handlers
apps/scheduler      promotion, cron, reaper, metrics rollup, leader election
apps/web            React dashboard (Vite + TanStack Query), served by nginx
tests/              unit · integration · concurrency
```

`packages/db/sql/claim-jobs.sql` is the most important file in the project.

---

## Common commands

```bash
make help
```

| Command | Does |
|---|---|
| `make up` | Build and start everything |
| `make seed` | Demo org, queues, schedules, sample jobs |
| `make logs` | Tail all services |
| `make kill-worker` | SIGKILL worker-2 to demo crash recovery |
| `make test-race` | The concurrency suite |
| `make down` | Stop (keeps data) |
| `make reset` | Stop and **delete** the database volume |

---

## Troubleshooting

**`P1001: Can't reach database server`** — Postgres isn't up. Run
`docker compose up -d postgres` and wait for `docker compose ps` to show
`(healthy)`.

**`@prisma/client did not initialize yet`** — run `npm run db:generate`.

**Worker exits with "No organization exists yet"** — run `npm run seed` first.
Workers register against an existing org; they don't create one.

**`docker compose` can't reach the daemon** — Docker Desktop's Linux engine
isn't running. Open the app and wait for "Engine running".

**Ports already in use** — change `API_PORT` / `POSTGRES_PORT` in `.env`.
