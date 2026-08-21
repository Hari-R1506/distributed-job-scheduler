-- ═══════════════════════════════════════════════════════════════════════════
--  ATOMIC JOB CLAIM
--
--  The most important query in the system. It guarantees that when N workers
--  poll the same queue in the same millisecond, every job is handed to exactly
--  one of them — with no blocking, no serialisation failures, and no duplicate
--  execution.
--
--  Runs inside ONE transaction lasting 1-3ms. The transaction is closed before
--  the handler runs. Execution NEVER happens inside a transaction.
--
--  Parameters:
--    $1 queue_id             uuid
--    $2 worker_id            uuid
--    $3 worker_free_slots    int   -- this process's remaining local capacity
--    $4 visibility_timeout_ms int  -- lease duration, from the queue config
--
--  Full reasoning: docs/ARCHITECTURE.md §7.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
--  STEP 1 — serialise the claim DECISION for this queue.
--
--  Why this is needed even though SKIP LOCKED already prevents two workers from
--  taking the same ROW: the per-queue concurrency limit is a constraint over an
--  AGGREGATE, and aggregates are not lockable. Under READ COMMITTED two workers
--  both read `count(running) = 0` from snapshots taken before either commits,
--  both compute "3 slots free", and both claim 3 — six jobs running on a queue
--  limited to three. SKIP LOCKED cannot help: they locked DIFFERENT rows, so
--  there is no row-level conflict to detect.
--
--  pg_advisory_xact_lock is transaction-scoped, so it releases automatically on
--  COMMIT or ROLLBACK and cannot be leaked. It is keyed PER QUEUE, so the
--  `email` queue's claims never block the `reports` queue's. It is held for the
--  duration of the claim only — microseconds — never during execution.
--
--  Cost: claims on one queue serialise, capping that queue at roughly
--  300-1000 claim transactions/second. Each claim takes a BATCH, so effective
--  throughput is many multiples of that. Documented ceiling; the escape hatch
--  at real scale is a slot-lease table (§8.2).
-- ───────────────────────────────────────────────────────────────────────────
SELECT pg_advisory_xact_lock(hashtextextended('queue_claim:' || $1::text, 0));

-- ───────────────────────────────────────────────────────────────────────────
--  STEP 2-4 — capacity, selection, claim. One statement.
-- ───────────────────────────────────────────────────────────────────────────
WITH capacity AS (
  -- How many jobs may this worker take from this queue right now?
  -- Exact, because step 1 guarantees no other claimer is inside this section.
  SELECT CASE
           -- A paused queue yields zero capacity regardless of backlog or
           -- priority. Note that RUNNING jobs are NOT killed: pause means
           -- "stop starting", not "abort" (§21 case 5).
           WHEN q.is_paused THEN 0
           WHEN q.max_concurrency IS NULL THEN $3::int
           ELSE GREATEST(0, LEAST(
                  $3::int,
                  q.max_concurrency - (
                    SELECT count(*)
                      FROM jobs r
                     WHERE r.queue_id = q.id
                       AND r.status IN ('CLAIMED', 'RUNNING')
                  )
                ))
         END AS n,
         q.visibility_timeout_ms
    FROM queues q
   WHERE q.id = $1::uuid
),
eligible AS (
  SELECT j.id
    FROM jobs j
   WHERE j.queue_id = $1::uuid
     AND j.status   = 'QUEUED'
     -- ELIGIBILITY is a WHERE clause; PRIORITY is an ORDER BY clause. They must
     -- never be mixed. Because this filters BEFORE the sort, a CRITICAL job
     -- scheduled for tomorrow is not in the candidate set at all and cannot
     -- outrank a LOW job that is ready now (§9.2).
     AND j.run_at  <= now()
   ORDER BY j.priority DESC,  -- the user's explicit intent, honoured first
            j.run_at   ASC,   -- FIFO within a priority band; `run_at`, not
                              -- `created_at`, so a retry whose backoff expired
                              -- an hour ago beats one that just became ready
            j.id       ASC    -- total, deterministic order -> reproducible tests
   -- Row locks, with locked rows made INVISIBLE rather than blocking. Worker A
   -- locks jobs 1-5; worker B scanning the same index at the same instant
   -- simply does not see them and takes 6-10. Nobody waits, nobody retries,
   -- and throughput grows with worker count instead of shrinking.
   --
   -- Retained even though step 1 already excludes other claimers, because it
   -- also protects against non-claimer writers touching a row at that instant:
   -- a user cancelling a job, or the reaper.
   FOR UPDATE SKIP LOCKED
   LIMIT (SELECT n FROM capacity)
),
claimed AS (
  UPDATE jobs j
     SET status           = 'CLAIMED',
         worker_id        = $2::uuid,
         claimed_at       = now(),
         lease_expires_at = now() + make_interval(secs => $4::int / 1000.0),
         -- Incremented AT CLAIM, not at completion. Counting DELIVERIES (as SQS
         -- does) bounds the blast radius of a job that crashes its worker: it
         -- exhausts its attempts and dead-letters, instead of being reclaimed
         -- forever and killing the fleet one process at a time (§29.10).
         attempt_count    = j.attempt_count + 1,
         updated_at       = now()
    FROM eligible e
   WHERE j.id = e.id
  -- The worker gets full rows in the same round trip: one network hop per claim.
  RETURNING j.*
)
-- ───────────────────────────────────────────────────────────────────────────
--  STEP 5 — re-sort the returned batch.
--
--  `UPDATE ... RETURNING` makes NO guarantee about row order: the ORDER BY in
--  `eligible` decides WHICH rows are claimed, not the order they come back in.
--  Postgres is free to return them in whatever order it wrote them.
--
--  Correctness does not depend on this — a worker dispatches the whole batch
--  into its pool concurrently, so intra-batch order is irrelevant to execution.
--  It is re-sorted anyway because an unordered batch makes logs, traces and
--  tests read as though priority were being ignored, and debugging a scheduler
--  is hard enough without that. The sort is over at most `freeSlots` rows.
-- ───────────────────────────────────────────────────────────────────────────
SELECT * FROM claimed
 ORDER BY priority DESC, run_at ASC, id ASC;
