-- ═══════════════════════════════════════════════════════════════════════════
--  REAPER — recover jobs whose lease expired
--
--  This is the safety net that makes worker crashes a non-event. Graceful
--  shutdown is an OPTIMISATION; the lease is the GUARANTEE. Test with
--  `docker kill` (SIGKILL), not `docker stop` (SIGTERM), or you are only
--  testing the happy path.
--
--  Keyed on `lease_expires_at`, NOT on `workers.status = 'DEAD'`. The lease is
--  the authoritative per-job fact; worker status is a derived summary. A worker
--  can be alive but wedged on one specific job — lease expiry catches that,
--  worker status does not.
--
--  Parameters:
--    $1 batch_size  int
--
--  Returns each recovered job with the decision the caller must act on, so the
--  scheduler can close the open execution row and write DLQ entries in the same
--  transaction.
-- ═══════════════════════════════════════════════════════════════════════════

WITH expired AS (
  SELECT j.id,
         j.attempt_count,
         j.max_attempts,
         j.backoff_strategy,
         j.backoff_base_ms,
         j.backoff_max_ms,
         j.backoff_jitter_pct,
         j.queue_id,
         j.project_id,
         j.payload,
         j.worker_id,
         q.dlq_enabled
    FROM jobs j
    JOIN queues q ON q.id = j.queue_id
   WHERE j.status IN ('CLAIMED', 'RUNNING')
     AND j.lease_expires_at < now()
   ORDER BY j.lease_expires_at
   LIMIT $1::int
   FOR UPDATE OF j SKIP LOCKED
),
decided AS (
  SELECT e.*,
         (e.attempt_count < e.max_attempts) AS can_retry,
         -- Backoff is computed in SQL here (rather than in the worker's
         -- packages/core) so the whole recovery is one round trip. The two
         -- implementations are pinned together by a unit test that asserts
         -- identical output across the full parameter space.
         LEAST(
           e.backoff_max_ms,
           CASE e.backoff_strategy
             WHEN 'FIXED'       THEN e.backoff_base_ms
             WHEN 'LINEAR'      THEN e.backoff_base_ms * e.attempt_count
             WHEN 'EXPONENTIAL' THEN e.backoff_base_ms * POWER(2, e.attempt_count - 1)
           END
         )::numeric
         -- Jitter. Without it, 500 jobs that failed in the same second all
         -- retry in the SAME millisecond, re-DDoSing a service the instant it
         -- recovers. Two lines; the difference between a self-healing system
         -- and a self-perpetuating outage (§11.2).
         * (1 + (random() * 2 - 1) * (e.backoff_jitter_pct / 100.0)) AS delay_ms
    FROM expired e
)
UPDATE jobs j
   SET status = CASE
                  WHEN d.can_retry           THEN 'RETRYING'::job_status
                  WHEN d.dlq_enabled         THEN 'DEAD_LETTER'::job_status
                  ELSE                            'FAILED'::job_status
                END,
       run_at = CASE
                  WHEN d.can_retry THEN now() + make_interval(secs => d.delay_ms / 1000.0)
                  ELSE j.run_at
                END,
       finished_at        = CASE WHEN d.can_retry THEN NULL ELSE now() END,
       -- Cleared so the CHECK constraints (a CLAIMED/RUNNING job must hold a
       -- lease and name a worker) stay satisfied in the new state.
       worker_id          = NULL,
       lease_expires_at   = NULL,
       last_error_code    = 'LEASE_EXPIRED',
       last_error_message = 'Worker stopped responding; lease expired and the job was recovered.',
       updated_at         = now()
  FROM decided d
 WHERE j.id = d.id
RETURNING j.id,
          j.status,
          j.attempt_count,
          j.queue_id,
          j.project_id,
          d.worker_id AS previous_worker_id,
          d.can_retry,
          d.dlq_enabled,
          d.payload;
