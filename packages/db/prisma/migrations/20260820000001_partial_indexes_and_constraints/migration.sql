-- ═══════════════════════════════════════════════════════════════════════════
--  The indexes and constraints that Prisma cannot express, and that decide
--  whether this system works. Applied after the generated baseline migration.
--
--  Full rationale: docs/ARCHITECTURE.md §4.2 and §4.4.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
--  CASE-INSENSITIVE IDENTITY COLUMNS
--
--  Prisma has no `citext` mapping, so these are widened here. Without it,
--  `Alice@example.com` and `alice@example.com` are two distinct users — a real
--  account-takeover vector, not a cosmetic issue. Normalising in application
--  code would work right up until one code path forgets; the database is the
--  only place the guarantee actually holds.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS citext;

ALTER TABLE users         ALTER COLUMN email TYPE citext;
ALTER TABLE organizations ALTER COLUMN slug  TYPE citext;
ALTER TABLE projects      ALTER COLUMN slug  TYPE citext;

-- ───────────────────────────────────────────────────────────────────────────
--  1. THE CLAIM INDEX
--
--  Every worker hits this many times per second. Four properties, all load-
--  bearing:
--
--   (a) PARTIAL — after a week of running, ~99% of `jobs` rows are COMPLETED.
--       A full index would carry all of them. This one carries only the tiny
--       working set of ready jobs, so claim cost depends on QUEUE DEPTH rather
--       than TABLE SIZE. It stays a few pages at 10M total jobs. This is the
--       entire reason "Postgres as a queue" scales acceptably.
--
--   (b) queue_id FIRST because it is the equality predicate — it selects the
--       sub-tree the scan walks.
--
--   (c) priority DESC, run_at ASC, id ASC next, in EXACTLY the ORDER BY order,
--       so Postgres walks the index in order and stops after LIMIT n. Without
--       this the planner adds a Sort node that must read every eligible row
--       before returning the first — turning an O(n) claim into O(N log N)
--       under load.
--
--   (d) id ASC as the final tiebreaker makes the ordering total and
--       deterministic, which makes the concurrency tests reproducible.
--
--  Verify with:
--    EXPLAIN (ANALYZE, BUFFERS)
--    SELECT id FROM jobs
--     WHERE queue_id = '...' AND status = 'QUEUED' AND run_at <= now()
--     ORDER BY priority DESC, run_at ASC, id ASC
--     LIMIT 10 FOR UPDATE SKIP LOCKED;
--  Expect: "Index Scan using idx_jobs_claim" with NO Sort node.
-- ───────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_claim
  ON jobs (queue_id, priority DESC, run_at ASC, id ASC)
  WHERE status = 'QUEUED';

-- ───────────────────────────────────────────────────────────────────────────
--  2. Promotion scan — the scheduler runs this every second.
--     Partial, so it covers only jobs actually waiting on a clock.
-- ───────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_promote
  ON jobs (run_at)
  WHERE status IN ('SCHEDULED', 'RETRYING');

-- ───────────────────────────────────────────────────────────────────────────
--  3. Reaper scan — in-flight jobs whose lease has expired. Every 5s.
--     Without this, dead-worker recovery becomes the slowest thing here.
-- ───────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_lease
  ON jobs (lease_expires_at)
  WHERE status IN ('CLAIMED', 'RUNNING');

-- ───────────────────────────────────────────────────────────────────────────
--  4. Idempotent creation — at most one live job per key per queue.
--     Scoped per queue: the same logical key may legitimately exist on two.
--     Partial, because the overwhelming majority of jobs carry no key.
-- ───────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idem
  ON jobs (queue_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
--  5. Cron exactly-once materialisation.
--
--     This is the SECOND of two independent guards against a cron schedule
--     firing twice (the first is the optimistic CAS on scheduled_jobs.next_run_at).
--     Belt and braces is right here: the failure is silent and the consequence
--     — a nightly billing job running twice — is unrecoverable.
--     Layer 1 avoids the error; layer 2 makes it structurally impossible.
-- ───────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_sched_slot
  ON jobs (scheduled_job_id, scheduled_for)
  WHERE scheduled_job_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
--  6. Scheduler's due-schedule scan, partial on is_enabled.
-- ───────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_scheduled_due;
CREATE INDEX IF NOT EXISTS idx_scheduled_due
  ON scheduled_jobs (next_run_at)
  WHERE is_enabled;

-- ───────────────────────────────────────────────────────────────────────────
--  7. DLQ inbox — only unresolved entries, so a growing archive of resolved
--     ones never bloats the triage view.
-- ───────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_dlq_inbox;
CREATE INDEX IF NOT EXISTS idx_dlq_inbox
  ON dead_letter_jobs (project_id, dead_lettered_at DESC)
  WHERE resolved_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
--  8. Payload search (optional, used by the job explorer's `search` filter).
-- ───────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_payload_gin
  ON jobs USING GIN (payload jsonb_path_ops);


-- ═══════════════════════════════════════════════════════════════════════════
--  CHECK CONSTRAINTS
--
--  These make invalid states UNREPRESENTABLE rather than merely discouraged.
--  A bug that would otherwise produce a silently stranded job now produces a
--  loud constraint violation in the test suite.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE jobs
  ADD CONSTRAINT chk_jobs_priority
  CHECK (priority BETWEEN 0 AND 255);

ALTER TABLE jobs
  ADD CONSTRAINT chk_jobs_attempts
  CHECK (attempt_count >= 0 AND attempt_count <= max_attempts + 1);

-- A CLAIMED or RUNNING job MUST hold a lease. Without this, a job could be
-- stranded in-flight forever with nothing to expire and no way to recover it.
ALTER TABLE jobs
  ADD CONSTRAINT chk_jobs_lease_present
  CHECK (status NOT IN ('CLAIMED', 'RUNNING') OR lease_expires_at IS NOT NULL);

-- ...and MUST name the worker holding it. This is what every conditional write
-- (`... AND worker_id = $me`) depends on.
ALTER TABLE jobs
  ADD CONSTRAINT chk_jobs_worker_present
  CHECK (status NOT IN ('CLAIMED', 'RUNNING') OR worker_id IS NOT NULL);

-- Bound payload size. The database is not a blob store.
ALTER TABLE jobs
  ADD CONSTRAINT chk_jobs_payload_size
  CHECK (pg_column_size(payload) <= 262144);

ALTER TABLE jobs
  ADD CONSTRAINT chk_jobs_timeout
  CHECK (timeout_ms > 0 AND timeout_ms <= 3600000);

ALTER TABLE queues
  ADD CONSTRAINT chk_queues_concurrency
  CHECK (max_concurrency IS NULL OR max_concurrency > 0);

ALTER TABLE queues
  ADD CONSTRAINT chk_queues_priority
  CHECK (default_priority BETWEEN 0 AND 255);

-- The lease must outlive the worker-death timeout, or the reaper would reclaim
-- jobs from a worker that is merely a few seconds slow — causing exactly the
-- duplicate execution this whole design prevents. 30s is WORKER_TIMEOUT_MS's
-- default; the boot-time config check enforces the live value (§14.1).
ALTER TABLE queues
  ADD CONSTRAINT chk_queues_visibility_timeout
  CHECK (visibility_timeout_ms >= 30000 AND visibility_timeout_ms <= 3600000);

ALTER TABLE retry_policies
  ADD CONSTRAINT chk_retry_attempts
  CHECK (max_attempts BETWEEN 1 AND 50);

ALTER TABLE retry_policies
  ADD CONSTRAINT chk_retry_delays
  CHECK (base_delay_ms >= 0 AND max_delay_ms >= base_delay_ms);

ALTER TABLE retry_policies
  ADD CONSTRAINT chk_retry_jitter
  CHECK (jitter_pct BETWEEN 0 AND 100);

ALTER TABLE job_executions
  ADD CONSTRAINT chk_executions_attempt
  CHECK (attempt >= 1);

ALTER TABLE workers
  ADD CONSTRAINT chk_workers_concurrency
  CHECK (concurrency > 0 AND concurrency <= 1000);

-- At most one default retry policy per project — enforced by the database
-- rather than by application vigilance.
CREATE UNIQUE INDEX IF NOT EXISTS uq_retry_policy_default
  ON retry_policies (project_id)
  WHERE is_default;


-- ═══════════════════════════════════════════════════════════════════════════
--  updated_at triggers
--
--  Prisma's @updatedAt only fires on writes that go through the client. The
--  claim query, the promotion loop and the reaper are all raw SQL, so the
--  guarantee has to live in the database.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','users','projects','retry_policies','queues','jobs','scheduled_jobs'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$s
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;
