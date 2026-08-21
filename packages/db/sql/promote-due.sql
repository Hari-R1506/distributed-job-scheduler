-- ═══════════════════════════════════════════════════════════════════════════
--  PROMOTION — SCHEDULED | RETRYING  ->  QUEUED
--
--  Run by the scheduler leader once per tick (1s). Makes jobs whose clock has
--  come due eligible for claiming.
--
--  Parameters:
--    $1 batch_size  int   -- bounded so this never becomes a long transaction
--
--  Returns the affected queue_ids so the caller can emit one pg_notify per
--  distinct queue rather than one per job.
--
--  Why promote at all, rather than letting the claim query match
--  `status IN ('QUEUED','SCHEDULED','RETRYING') AND run_at <= now()` directly?
--  That alternative is simpler and was seriously considered (§29.11). Promotion
--  won because the partial claim index then covers ONLY truly-ready rows,
--  instead of every future-dated and backing-off job — which is the entire
--  performance argument for that index. It also makes `queued_count` a cheap
--  indexed count, and matches the lifecycle the brief specifies.
--
--  Failure mode if the scheduler is down: jobs sit in SCHEDULED and fire LATE.
--  Never lost. That is the correct failure mode for a scheduler.
-- ═══════════════════════════════════════════════════════════════════════════

WITH due AS (
  SELECT id
    FROM jobs
   WHERE status IN ('SCHEDULED', 'RETRYING')
     AND run_at <= now()
   ORDER BY run_at
   LIMIT $1::int
   -- SKIP LOCKED so a concurrent cancel or reaper touching one row cannot stall
   -- the whole batch. Leader election means there is only one promoter, but the
   -- UPDATE is idempotent anyway: a second promoter would match zero rows.
   FOR UPDATE SKIP LOCKED
)
UPDATE jobs j
   SET status     = 'QUEUED',
       updated_at = now()
  FROM due
 WHERE j.id = due.id
RETURNING j.queue_id, j.id;
