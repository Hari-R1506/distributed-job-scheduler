-- ═══════════════════════════════════════════════════════════════════════════
--  METRICS ROLLUP — one row per queue per minute
--
--  Run by the scheduler leader once a minute, for the minute that just closed.
--
--  Deliberately NOT written by the job-completion transaction. Incrementing a
--  counter there would take a row lock on one row per queue, making that single
--  row the serialisation point for every completion on the queue — a global
--  mutex by accident. Cost of this choice: dashboard metrics lag by up to 60s.
--  That is the correct trade (§4.2, §19.2).
--
--  ON CONFLICT DO UPDATE makes the aggregator safely re-runnable, so a
--  scheduler restart mid-minute cannot corrupt or duplicate a bucket.
--
--  Parameters:
--    $1 from  timestamptz   -- inclusive
--    $2 to    timestamptz   -- exclusive
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO queue_metrics_minute
  (queue_id, bucket, completed_count, failed_count, dlq_count,
   total_duration_ms, avg_duration_ms, p95_duration_ms, max_duration_ms)
SELECT
  j.queue_id,
  date_trunc('minute', e.finished_at)                                   AS bucket,
  count(*) FILTER (WHERE e.status = 'SUCCEEDED')                        AS completed_count,
  -- "failed ATTEMPTS", not "failed jobs". A job that succeeds on attempt 3
  -- contributes 2 here and 1 to completed_count. The dashboard labels this
  -- explicitly, because conflating the two is a confusing and common bug.
  count(*) FILTER (WHERE e.status IN ('FAILED','TIMED_OUT','ABANDONED')) AS failed_count,
  count(*) FILTER (WHERE j.status = 'DEAD_LETTER'
                     AND j.finished_at >= $1::timestamptz
                     AND j.finished_at <  $2::timestamptz)              AS dlq_count,
  -- Stored so averages stay MERGEABLE when minute buckets are rolled into
  -- hours: you cannot average a set of averages, but you can sum totals.
  coalesce(sum(e.duration_ms), 0)                                       AS total_duration_ms,
  coalesce(avg(e.duration_ms), 0)::int                                  AS avg_duration_ms,
  coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY e.duration_ms), 0)::int AS p95_duration_ms,
  coalesce(max(e.duration_ms), 0)                                       AS max_duration_ms
FROM job_executions e
JOIN jobs j ON j.id = e.job_id
WHERE e.finished_at >= $1::timestamptz
  AND e.finished_at <  $2::timestamptz
GROUP BY j.queue_id, date_trunc('minute', e.finished_at)
ON CONFLICT (queue_id, bucket) DO UPDATE SET
  completed_count   = EXCLUDED.completed_count,
  failed_count      = EXCLUDED.failed_count,
  dlq_count         = EXCLUDED.dlq_count,
  total_duration_ms = EXCLUDED.total_duration_ms,
  avg_duration_ms   = EXCLUDED.avg_duration_ms,
  p95_duration_ms   = EXCLUDED.p95_duration_ms,
  max_duration_ms   = EXCLUDED.max_duration_ms;
