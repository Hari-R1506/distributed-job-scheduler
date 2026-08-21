-- ═══════════════════════════════════════════════════════════════════════════
--  Raise the visibility-timeout floor above WORKER_TIMEOUT_MS.
--
--  Found by the concurrency suite, which is exactly where it should have been
--  found.
--
--  The safety invariant is:
--
--      lease (visibility_timeout_ms)  >  worker death timeout (30s default)
--
--  A worker must be declared DEAD before its jobs are reclaimed. If the lease
--  expired first, the reaper would take jobs from a worker that is merely a few
--  seconds slow — causing precisely the duplicate execution this design exists
--  to prevent.
--
--  The original CHECK allowed `>= 30000`, so the MINIMUM legal lease was
--  exactly equal to the worker timeout and therefore violated the invariant.
--  A queue configured at the floor produced workers that refused to boot: the
--  runtime assertion caught it, but only after deployment, and the database had
--  happily stored an unsafe value.
--
--  Now the floor is 45s — 1.5x the worker timeout — so every value the database
--  will accept satisfies the invariant with margin. The check moves from
--  "detected at boot" to "unrepresentable", which is where it belongs.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE queues
   SET visibility_timeout_ms = 45000
 WHERE visibility_timeout_ms < 45000;

ALTER TABLE queues DROP CONSTRAINT IF EXISTS chk_queues_visibility_timeout;

ALTER TABLE queues
  ADD CONSTRAINT chk_queues_visibility_timeout
  CHECK (visibility_timeout_ms >= 45000 AND visibility_timeout_ms <= 3600000);

COMMENT ON COLUMN queues.visibility_timeout_ms IS
  'Lease duration for a claimed job. MUST exceed WORKER_TIMEOUT_MS (default 30s) '
  'so a worker is declared dead before its jobs are reclaimed. Floor of 45s is '
  'enforced here; the exact live invariant is re-checked at worker boot.';
