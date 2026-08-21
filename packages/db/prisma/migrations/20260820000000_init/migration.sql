-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('SCHEDULED', 'QUEUED', 'CLAIMED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'DEAD_LETTER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "execution_status" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABANDONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "backoff_strategy" AS ENUM ('FIXED', 'LINEAR', 'EXPONENTIAL');

-- CreateEnum
CREATE TYPE "worker_status" AS ENUM ('STARTING', 'ACTIVE', 'DRAINING', 'STOPPED', 'DEAD');

-- CreateEnum
CREATE TYPE "log_level" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "member_role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "dlq_reason" AS ENUM ('MAX_ATTEMPTS_EXCEEDED', 'NON_RETRYABLE_ERROR', 'TIMEOUT', 'LEASE_EXPIRED', 'CANCELLED_BY_SYSTEM');

-- CreateEnum
CREATE TYPE "dlq_resolution" AS ENUM ('REPLAYED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "misfire_policy" AS ENUM ('SKIP', 'FIRE_ONCE', 'BACKFILL');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "member_role" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_by" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['jobs:read', 'jobs:write']::TEXT[],
    "last_used_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retry_policies" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "strategy" "backoff_strategy" NOT NULL,
    "max_attempts" INTEGER NOT NULL,
    "base_delay_ms" INTEGER NOT NULL,
    "max_delay_ms" INTEGER NOT NULL,
    "jitter_pct" SMALLINT NOT NULL DEFAULT 10,
    "retry_on_error_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "retry_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queues" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default_priority" SMALLINT NOT NULL DEFAULT 100,
    "max_concurrency" INTEGER,
    "retry_policy_id" UUID NOT NULL,
    "visibility_timeout_ms" INTEGER NOT NULL DEFAULT 60000,
    "default_job_timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "rate_limit_per_sec" INTEGER,
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "paused_at" TIMESTAMPTZ(3),
    "paused_by" UUID,
    "pause_reason" TEXT,
    "dlq_enabled" BOOLEAN NOT NULL DEFAULT true,
    "retention_days" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scheduled_job_id" UUID,
    "parent_job_id" UUID,
    "batch_id" UUID,
    "handler" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB,
    "idempotency_key" TEXT,
    "priority" SMALLINT NOT NULL DEFAULT 100,
    "status" "job_status" NOT NULL DEFAULT 'QUEUED',
    "run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduled_for" TIMESTAMPTZ(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "backoff_strategy" "backoff_strategy" NOT NULL,
    "backoff_base_ms" INTEGER NOT NULL,
    "backoff_max_ms" INTEGER NOT NULL,
    "backoff_jitter_pct" SMALLINT NOT NULL DEFAULT 10,
    "retry_policy_id" UUID,
    "timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "worker_id" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "claimed_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "result" JSONB,
    "request_id" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_executions" (
    "id" BIGSERIAL NOT NULL,
    "job_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "worker_id" UUID,
    "status" "execution_status" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "error_stack" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_logs" (
    "id" BIGSERIAL NOT NULL,
    "execution_id" BIGINT NOT NULL,
    "job_id" UUID NOT NULL,
    "level" "log_level" NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "logged_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "status" "worker_status" NOT NULL DEFAULT 'STARTING',
    "concurrency" INTEGER NOT NULL,
    "active_job_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stopped_at" TIMESTAMPTZ(3),
    "metadata" JSONB,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_subscriptions" (
    "worker_id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "weight" SMALLINT NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_subscriptions_pkey" PRIMARY KEY ("worker_id","queue_id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "id" BIGSERIAL NOT NULL,
    "worker_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active_job_count" INTEGER NOT NULL,
    "jobs_processed_delta" INTEGER NOT NULL DEFAULT 0,
    "cpu_pct" DOUBLE PRECISION,
    "mem_mb" INTEGER,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cron_expression" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "handler" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "priority" SMALLINT NOT NULL DEFAULT 100,
    "max_attempts" INTEGER,
    "timeout_ms" INTEGER,
    "retry_policy_id" UUID,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "misfire_policy" "misfire_policy" NOT NULL DEFAULT 'SKIP',
    "catchup_limit" INTEGER NOT NULL DEFAULT 10,
    "start_at" TIMESTAMPTZ(3),
    "end_at" TIMESTAMPTZ(3),
    "next_run_at" TIMESTAMPTZ(3) NOT NULL,
    "last_run_at" TIMESTAMPTZ(3),
    "last_job_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter_jobs" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "reason" "dlq_reason" NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "total_attempts" INTEGER NOT NULL,
    "payload_snapshot" JSONB NOT NULL,
    "first_failed_at" TIMESTAMPTZ(3) NOT NULL,
    "dead_lettered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_signature" TEXT,
    "ai_summary" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "resolution" "dlq_resolution",
    "resolution_note" TEXT,
    "replay_job_id" UUID,

    CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_metrics_minute" (
    "id" BIGSERIAL NOT NULL,
    "queue_id" UUID NOT NULL,
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "completed_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "dlq_count" INTEGER NOT NULL DEFAULT 0,
    "total_duration_ms" BIGINT NOT NULL DEFAULT 0,
    "avg_duration_ms" INTEGER NOT NULL DEFAULT 0,
    "p95_duration_ms" INTEGER NOT NULL DEFAULT 0,
    "max_duration_ms" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "queue_metrics_minute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_org_id_user_id_key" ON "memberships"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_org_id_slug_key" ON "projects"("org_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_project_id_idx" ON "api_keys"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "retry_policies_project_id_name_key" ON "retry_policies"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "queues_project_id_name_key" ON "queues"("project_id", "name");

-- CreateIndex
CREATE INDEX "idx_jobs_explorer" ON "jobs"("project_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_jobs_queue_created" ON "jobs"("queue_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_jobs_batch" ON "jobs"("batch_id");

-- CreateIndex
CREATE INDEX "idx_jobs_parent" ON "jobs"("parent_job_id");

-- CreateIndex
CREATE INDEX "idx_executions_worker" ON "job_executions"("worker_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "idx_executions_rollup" ON "job_executions"("status", "finished_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_executions_job_attempt" ON "job_executions"("job_id", "attempt");

-- CreateIndex
CREATE INDEX "idx_logs_execution" ON "job_logs"("execution_id", "logged_at");

-- CreateIndex
CREATE INDEX "idx_logs_job" ON "job_logs"("job_id", "logged_at");

-- CreateIndex
CREATE INDEX "idx_workers_liveness" ON "workers"("status", "last_heartbeat_at");

-- CreateIndex
CREATE INDEX "workers_org_id_idx" ON "workers"("org_id");

-- CreateIndex
CREATE INDEX "worker_subscriptions_queue_id_idx" ON "worker_subscriptions"("queue_id");

-- CreateIndex
CREATE INDEX "idx_heartbeats_worker" ON "worker_heartbeats"("worker_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "idx_scheduled_due" ON "scheduled_jobs"("next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_jobs_project_id_name_key" ON "scheduled_jobs"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "dead_letter_jobs_job_id_key" ON "dead_letter_jobs"("job_id");

-- CreateIndex
CREATE INDEX "idx_dlq_inbox" ON "dead_letter_jobs"("project_id", "dead_lettered_at" DESC);

-- CreateIndex
CREATE INDEX "idx_dlq_signature" ON "dead_letter_jobs"("error_signature");

-- CreateIndex
CREATE INDEX "idx_metrics_bucket" ON "queue_metrics_minute"("bucket" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_metrics_queue_bucket" ON "queue_metrics_minute"("queue_id", "bucket");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retry_policies" ADD CONSTRAINT "retry_policies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_retry_policy_id_fkey" FOREIGN KEY ("retry_policy_id") REFERENCES "retry_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_paused_by_fkey" FOREIGN KEY ("paused_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_scheduled_job_id_fkey" FOREIGN KEY ("scheduled_job_id") REFERENCES "scheduled_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_job_id_fkey" FOREIGN KEY ("parent_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_retry_policy_id_fkey" FOREIGN KEY ("retry_policy_id") REFERENCES "retry_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "job_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workers" ADD CONSTRAINT "workers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_subscriptions" ADD CONSTRAINT "worker_subscriptions_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_subscriptions" ADD CONSTRAINT "worker_subscriptions_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_heartbeats" ADD CONSTRAINT "worker_heartbeats_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_retry_policy_id_fkey" FOREIGN KEY ("retry_policy_id") REFERENCES "retry_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_last_job_id_fkey" FOREIGN KEY ("last_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_replay_job_id_fkey" FOREIGN KEY ("replay_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_metrics_minute" ADD CONSTRAINT "queue_metrics_minute_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

