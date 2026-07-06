-- Migration 024: Agentic MCP feature backing schema
--
-- Enables exposed MCP tools for agent handoff and RLM workflows:
-- - work_queue
-- - rlm_session / rlm_iteration
-- - context_monitor
-- - temporal.search

CREATE TABLE IF NOT EXISTS work_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  queue_name       TEXT NOT NULL,
  task_type        TEXT NOT NULL,
  priority         TEXT NOT NULL DEFAULT 'normal'
                   CHECK (priority IN ('critical','high','normal','low')),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','claimed','completed','failed','dead_letter')),
  payload          JSONB NOT NULL DEFAULT '{}',
  handoff          JSONB,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  claimed_by       TEXT,
  claimed_at       TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  failed_at        TIMESTAMPTZ,
  failure_reason   TEXT,
  scheduled_after  TIMESTAMPTZ,
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_work_queue_claim
  ON work_queue (tenant_id, queue_name, status, priority DESC, scheduled_after ASC, created_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_work_queue_lease_expiry
  ON work_queue (lease_expires_at)
  WHERE status = 'claimed';

CREATE TABLE IF NOT EXISTS rlm_sessions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT        NOT NULL,
  task_id             TEXT        NOT NULL,
  task_title          TEXT        NOT NULL DEFAULT '',
  status              TEXT        NOT NULL DEFAULT 'active',
  acceptance_criteria JSONB       NOT NULL DEFAULT '[]',
  current_plan        TEXT,
  regeneration_count  INTEGER     NOT NULL DEFAULT 0,
  metadata            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rlm_iterations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID        NOT NULL REFERENCES rlm_sessions(id) ON DELETE CASCADE,
  tenant_id        TEXT        NOT NULL,
  iteration_number INTEGER     NOT NULL,
  plan_summary     TEXT        NOT NULL DEFAULT '',
  approach         TEXT        NOT NULL DEFAULT '',
  outcome          TEXT        NOT NULL DEFAULT 'failed',
  evidence         JSONB       NOT NULL DEFAULT '[]',
  error            TEXT,
  ac_met           JSONB       NOT NULL DEFAULT '[]',
  ac_failed        JSONB       NOT NULL DEFAULT '[]',
  duration_ms      INTEGER,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  metadata         JSONB       NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS context_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  agent_name TEXT,
  max_tokens INTEGER NOT NULL DEFAULT 200000,
  current_usage INTEGER NOT NULL DEFAULT 0,
  peak_usage INTEGER NOT NULL DEFAULT 0,
  compression_count INTEGER NOT NULL DEFAULT 0,
  last_compression_at TIMESTAMPTZ,
  session_state TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb,
  CONSTRAINT context_sessions_unique UNIQUE (tenant_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_context_sessions_tenant ON context_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_context_sessions_state ON context_sessions(session_state);
CREATE INDEX IF NOT EXISTS idx_context_sessions_created_at ON context_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_sessions_updated_at ON context_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS context_analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  token_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_context_analytics_events_tenant ON context_analytics_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_context_analytics_events_session ON context_analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_context_analytics_events_type ON context_analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_context_analytics_events_created_at ON context_analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_analytics_events_data ON context_analytics_events USING GIN (event_data);

ALTER TABLE context_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS context_sessions_tenant_isolation ON context_sessions;
CREATE POLICY context_sessions_tenant_isolation ON context_sessions
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

ALTER TABLE context_analytics_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS context_analytics_events_tenant_isolation ON context_analytics_events;
CREATE POLICY context_analytics_events_tenant_isolation ON context_analytics_events
  USING (tenant_id::text = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant', true));

CREATE OR REPLACE FUNCTION update_context_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS context_sessions_updated_at_trigger ON context_sessions;
CREATE TRIGGER context_sessions_updated_at_trigger
  BEFORE UPDATE ON context_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_context_sessions_updated_at();

CREATE OR REPLACE FUNCTION search_memories_at_time(
  p_tenant_id UUID,
  p_query_embedding vector(768),
  p_as_of_time TIMESTAMPTZ,
  p_project_id UUID DEFAULT NULL,
  p_category VARCHAR(50) DEFAULT NULL,
  p_limit INTEGER DEFAULT 10
)
RETURNS TABLE(
  id UUID,
  content TEXT,
  category VARCHAR(50),
  metadata JSONB,
  distance DOUBLE PRECISION,
  created_at TIMESTAMPTZ,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.category,
    m.metadata,
    (m.embedding <=> p_query_embedding) AS distance,
    m.created_at,
    m.valid_from,
    m.valid_until
  FROM memories m
  WHERE m.tenant_id = p_tenant_id
    AND (p_project_id IS NULL OR m.project_id = p_project_id)
    AND (p_category IS NULL OR m.category = p_category)
    AND m.valid_from <= p_as_of_time
    AND (m.valid_until IS NULL OR m.valid_until > p_as_of_time)
    AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> p_query_embedding
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

GRANT USAGE ON SCHEMA public TO rembr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_queue TO rembr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rlm_sessions TO rembr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rlm_iterations TO rembr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON context_sessions TO rembr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON context_analytics_events TO rembr_app;
GRANT SELECT, INSERT, UPDATE ON causal_relationships TO rembr_app;
GRANT SELECT, INSERT ON temporal_snapshots TO rembr_app;
GRANT SELECT, INSERT ON audit_logs TO rembr_app;
GRANT EXECUTE ON FUNCTION search_memories_at_time(UUID, vector(768), TIMESTAMPTZ, UUID, VARCHAR, INTEGER) TO rembr_app;
