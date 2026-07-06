-- Migration 027: Durable memory maintenance jobs
--
-- Tracks background maintenance work that must survive MCP pod restarts:
-- embeddings, stale embedding refreshes, relationship inference,
-- contradiction detection, cleanup, and compaction.

CREATE TABLE IF NOT EXISTS memory_processing_jobs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL,
  project_id     UUID,
  memory_id      UUID,
  job_type       TEXT        NOT NULL
                            CHECK (job_type IN (
                              'embedding',
                              'stale_embedding',
                              'relationship_inference',
                              'contradiction_detection',
                              'memory_evolution',
                              'cleanup',
                              'compaction'
                            )),
  status         TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN (
                              'pending',
                              'leased',
                              'succeeded',
                              'failed',
                              'cancelled'
                            )),
  priority       INTEGER     NOT NULL DEFAULT 100,
  attempt_count  INTEGER     NOT NULL DEFAULT 0,
  max_attempts   INTEGER     NOT NULL DEFAULT 5,
  available_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  leased_until   TIMESTAMPTZ,
  lease_owner    TEXT,
  last_error     TEXT,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memory_processing_jobs_claim
  ON memory_processing_jobs (job_type, status, priority ASC, available_at ASC, created_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_memory_processing_jobs_tenant_status
  ON memory_processing_jobs (tenant_id, status, job_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_processing_jobs_memory
  ON memory_processing_jobs (tenant_id, memory_id, job_type)
  WHERE memory_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_processing_jobs_active_unique
  ON memory_processing_jobs (tenant_id, memory_id, job_type)
  WHERE memory_id IS NOT NULL
    AND status IN ('pending', 'leased');

CREATE TABLE IF NOT EXISTS memory_processing_failures (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID        REFERENCES memory_processing_jobs(id) ON DELETE SET NULL,
  tenant_id       UUID        NOT NULL,
  project_id      UUID,
  memory_id       UUID,
  job_type        TEXT        NOT NULL,
  failure_reason  TEXT        NOT NULL,
  error_message   TEXT        NOT NULL,
  attempt_count   INTEGER     NOT NULL DEFAULT 0,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_processing_failures_tenant
  ON memory_processing_failures (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_processing_failures_type
  ON memory_processing_failures (job_type, failure_reason, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id             TEXT        NOT NULL,
  run_type              TEXT        NOT NULL
                                      CHECK (run_type IN (
                                        'embedding_backfill',
                                        'stale_embedding_refresh',
                                        'relationship_inference',
                                        'contradiction_detection',
                                        'memory_evolution',
                                        'cleanup',
                                        'compaction',
                                        'full_cycle'
                                      )),
  status                TEXT        NOT NULL DEFAULT 'running'
                                      CHECK (status IN ('running','succeeded','failed','cancelled')),
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  duration_ms           INTEGER,
  tenants_processed     INTEGER     NOT NULL DEFAULT 0,
  memories_processed    INTEGER     NOT NULL DEFAULT 0,
  jobs_created          INTEGER     NOT NULL DEFAULT 0,
  jobs_succeeded        INTEGER     NOT NULL DEFAULT 0,
  jobs_failed           INTEGER     NOT NULL DEFAULT 0,
  cleanup_actions       INTEGER     NOT NULL DEFAULT 0,
  error_message         TEXT,
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs_type_status
  ON memory_maintenance_runs (run_type, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs_started_at
  ON memory_maintenance_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS memory_cleanup_actions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL,
  project_id         UUID,
  action_type        TEXT        NOT NULL
                                   CHECK (action_type IN (
                                     'archive_duplicate',
                                     'archive_superseded',
                                     'archive_stale',
                                     'merge_duplicate',
                                     'rewrite_memory',
                                     'delete_orphan_relationship',
                                     'repair_relationship',
                                     'review_candidate'
                                   )),
  status             TEXT        NOT NULL DEFAULT 'proposed'
                                   CHECK (status IN (
                                     'proposed',
                                     'approved',
                                     'applied',
                                     'skipped',
                                     'reverted',
                                     'failed'
                                   )),
  confidence         NUMERIC(4,3) NOT NULL DEFAULT 0,
  source_memory_id   UUID,
  target_memory_id   UUID,
  reason             TEXT        NOT NULL,
  dry_run            BOOLEAN     NOT NULL DEFAULT TRUE,
  reversible         BOOLEAN     NOT NULL DEFAULT TRUE,
  audit_payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  applied_at         TIMESTAMPTZ,
  reverted_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_cleanup_actions_tenant_status
  ON memory_cleanup_actions (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_cleanup_actions_source
  ON memory_cleanup_actions (tenant_id, source_memory_id)
  WHERE source_memory_id IS NOT NULL;

CREATE OR REPLACE FUNCTION update_memory_maintenance_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memory_processing_jobs_updated_at ON memory_processing_jobs;
CREATE TRIGGER memory_processing_jobs_updated_at
  BEFORE UPDATE ON memory_processing_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_memory_maintenance_updated_at();

DROP TRIGGER IF EXISTS memory_cleanup_actions_updated_at ON memory_cleanup_actions;
CREATE TRIGGER memory_cleanup_actions_updated_at
  BEFORE UPDATE ON memory_cleanup_actions
  FOR EACH ROW
  EXECUTE FUNCTION update_memory_maintenance_updated_at();

ALTER TABLE memory_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_processing_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_cleanup_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_processing_jobs_tenant_isolation ON memory_processing_jobs;
CREATE POLICY memory_processing_jobs_tenant_isolation ON memory_processing_jobs
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

DROP POLICY IF EXISTS memory_processing_failures_tenant_isolation ON memory_processing_failures;
CREATE POLICY memory_processing_failures_tenant_isolation ON memory_processing_failures
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

DROP POLICY IF EXISTS memory_cleanup_actions_tenant_isolation ON memory_cleanup_actions;
CREATE POLICY memory_cleanup_actions_tenant_isolation ON memory_cleanup_actions
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rembr_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON memory_processing_jobs TO rembr_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON memory_processing_failures TO rembr_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON memory_maintenance_runs TO rembr_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON memory_cleanup_actions TO rembr_app;
  END IF;
END $$;
