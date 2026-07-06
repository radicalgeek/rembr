-- Migration 029: LLM-backed memory evolution jobs
--
-- Adds a durable background job type for autonomous memory maintenance:
-- LLM-assisted rewrite, pruning, and supersession decisions.

ALTER TABLE memory_processing_jobs
  DROP CONSTRAINT IF EXISTS memory_processing_jobs_job_type_check;

ALTER TABLE memory_processing_jobs
  ADD CONSTRAINT memory_processing_jobs_job_type_check
  CHECK (job_type IN (
    'embedding',
    'stale_embedding',
    'relationship_inference',
    'contradiction_detection',
    'memory_evolution',
    'cleanup',
    'compaction'
  ));

ALTER TABLE memory_maintenance_runs
  DROP CONSTRAINT IF EXISTS memory_maintenance_runs_run_type_check;

ALTER TABLE memory_maintenance_runs
  ADD CONSTRAINT memory_maintenance_runs_run_type_check
  CHECK (run_type IN (
    'embedding_backfill',
    'stale_embedding_refresh',
    'relationship_inference',
    'contradiction_detection',
    'memory_evolution',
    'cleanup',
    'compaction',
    'full_cycle'
  ));

ALTER TABLE memory_cleanup_actions
  DROP CONSTRAINT IF EXISTS memory_cleanup_actions_action_type_check;

ALTER TABLE memory_cleanup_actions
  ADD CONSTRAINT memory_cleanup_actions_action_type_check
  CHECK (action_type IN (
    'archive_duplicate',
    'archive_superseded',
    'archive_stale',
    'merge_duplicate',
    'rewrite_memory',
    'delete_orphan_relationship',
    'repair_relationship',
    'review_candidate'
  ));

CREATE INDEX IF NOT EXISTS idx_memory_processing_jobs_evolution_due
  ON memory_processing_jobs (tenant_id, status, available_at ASC, priority ASC)
  WHERE job_type = 'memory_evolution';
