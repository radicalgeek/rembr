-- Migration: Causal Reasoning, Temporal Querying & Audit Logging
-- Date: 2026-01-20
-- Description: Implements three foundational features for RLM debugging and compliance

-- ============================================================================
-- PART 1: CAUSAL REASONING GRAPH
-- ============================================================================

-- Create causal_relationships table
CREATE TABLE IF NOT EXISTS causal_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  
  -- Causal Link
  cause_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  effect_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  
  -- Causal Strength & Type
  causal_strength DECIMAL(3,2) NOT NULL CHECK (causal_strength >= 0.0 AND causal_strength <= 1.0),
  causal_type VARCHAR(20) NOT NULL CHECK (causal_type IN ('enables', 'causes', 'prevents', 'requires', 'invalidates')),
  
  -- Evidence & Provenance
  evidence_count INTEGER DEFAULT 1,
  inferred_by VARCHAR(20) NOT NULL CHECK (inferred_by IN ('user', 'llm', 'system', 'agent')),
  inference_model VARCHAR(50), -- e.g., 'llama3.1:8b'
  inference_prompt TEXT,
  
  -- Temporal Context
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ, -- NULL = still valid
  
  -- Metadata
  confidence_score DECIMAL(3,2) DEFAULT 0.80,
  validated_by_user BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'::jsonb,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Constraints
  UNIQUE (cause_memory_id, effect_memory_id, causal_type, tenant_id),
  CHECK (cause_memory_id != effect_memory_id) -- No self-causation
);

-- Indexes for causal relationships
CREATE INDEX idx_causal_cause ON causal_relationships(cause_memory_id, tenant_id);
CREATE INDEX idx_causal_effect ON causal_relationships(effect_memory_id, tenant_id);
CREATE INDEX idx_causal_type ON causal_relationships(causal_type, tenant_id);
CREATE INDEX idx_causal_strength ON causal_relationships(causal_strength DESC);
CREATE INDEX idx_causal_tenant ON causal_relationships(tenant_id, created_at DESC);
CREATE INDEX idx_causal_valid ON causal_relationships(tenant_id, valid_from, valid_until);

-- RLS Policy for causal_relationships
ALTER TABLE causal_relationships ENABLE ROW LEVEL SECURITY;

CREATE POLICY causal_tenant_isolation ON causal_relationships
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

-- ============================================================================
-- PART 2: TEMPORAL QUERYING
-- ============================================================================

-- Add temporal columns to memories table (if not exist)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'memories' AND column_name = 'valid_from'
  ) THEN
    ALTER TABLE memories 
      ADD COLUMN valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN valid_until TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

-- Backfill valid_from for existing memories
UPDATE memories 
SET valid_from = created_at
WHERE valid_from IS NULL OR valid_from = NOW();

-- Index for temporal queries
CREATE INDEX IF NOT EXISTS idx_memories_temporal ON memories(tenant_id, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_memories_temporal_range ON memories USING GIST (
  tenant_id,
  tstzrange(valid_from, COALESCE(valid_until, 'infinity'::timestamptz))
);

-- Create temporal_snapshots table
CREATE TABLE IF NOT EXISTS temporal_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  
  snapshot_name VARCHAR(200) NOT NULL,
  snapshot_time TIMESTAMPTZ NOT NULL,
  
  -- Statistics
  total_memories INTEGER NOT NULL,
  categories_snapshot JSONB DEFAULT '{}'::jsonb,
  
  -- Optional: Frozen embedding index for fast queries
  frozen_index_path TEXT,
  
  created_by_user_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE (tenant_id, snapshot_name)
);

CREATE INDEX idx_temporal_snapshots ON temporal_snapshots(tenant_id, snapshot_time DESC);
CREATE INDEX idx_temporal_snapshots_created ON temporal_snapshots(created_at DESC);

ALTER TABLE temporal_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY temporal_snapshots_tenant_isolation ON temporal_snapshots
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

-- Function to set valid_from on insert
CREATE OR REPLACE FUNCTION set_memory_valid_from()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.valid_from IS NULL THEN
    NEW.valid_from := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to set valid_from on insert (if not already set)
DROP TRIGGER IF EXISTS memory_valid_from_trigger ON memories;
CREATE TRIGGER memory_valid_from_trigger
  BEFORE INSERT ON memories
  FOR EACH ROW
  EXECUTE FUNCTION set_memory_valid_from();

-- ============================================================================
-- PART 3: ENHANCED AUDIT LOGGING
-- ============================================================================

-- Enhance existing audit_logs table
DO $$ 
BEGIN
  -- Add tenant_id if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'audit_logs' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE audit_logs ADD COLUMN tenant_id UUID;
  END IF;
  
  -- Add resource tracking columns
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'audit_logs' AND column_name = 'resource_type'
  ) THEN
    ALTER TABLE audit_logs 
      ADD COLUMN resource_type VARCHAR(50),
      ADD COLUMN resource_id UUID,
      ADD COLUMN action_result VARCHAR(20) DEFAULT 'success' CHECK (action_result IN ('success', 'failure', 'denied')),
      ADD COLUMN error_message TEXT,
      ADD COLUMN event_type VARCHAR(50),
      ADD COLUMN api_key_id UUID,
      ADD COLUMN agent_id VARCHAR(200),
      ADD COLUMN session_id VARCHAR(200),
      ADD COLUMN request_id VARCHAR(200),
      ADD COLUMN payload_before JSONB,
      ADD COLUMN payload_after JSONB,
      ADD COLUMN query_parameters JSONB,
      ADD COLUMN retention_until TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 years';
  END IF;
  
  -- Rename columns for consistency
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'audit_logs' AND column_name = 'user_email'
  ) THEN
    ALTER TABLE audit_logs RENAME COLUMN user_email TO user_identifier;
  END IF;
END $$;

-- Additional indexes for audit logs
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_logs(action_result, created_at DESC) WHERE action_result != 'success';
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_logs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_logs(agent_id, created_at DESC);

-- RLS Policy for audit_logs
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policy
DROP POLICY IF EXISTS audit_tenant_isolation ON audit_logs;
CREATE POLICY audit_tenant_isolation ON audit_logs
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

-- Immutability: Prevent updates/deletes on audit logs
DROP POLICY IF EXISTS audit_no_update ON audit_logs;
DROP POLICY IF EXISTS audit_no_delete ON audit_logs;
CREATE POLICY audit_no_update ON audit_logs FOR UPDATE USING (false);
CREATE POLICY audit_no_delete ON audit_logs FOR DELETE USING (false);

-- Trigger for memory audit logging
CREATE OR REPLACE FUNCTION audit_memory_changes()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_logs (
    tenant_id, 
    event_type, 
    resource_type, 
    resource_id, 
    action_result, 
    payload_before, 
    payload_after,
    type,
    user_identifier,
    provider,
    success
  )
  VALUES (
    COALESCE(NEW.tenant_id, OLD.tenant_id),
    CASE TG_OP
      WHEN 'INSERT' THEN 'memory.created'
      WHEN 'UPDATE' THEN 'memory.updated'
      WHEN 'DELETE' THEN 'memory.deleted'
    END,
    'memory',
    COALESCE(NEW.id, OLD.id),
    'success',
    CASE WHEN TG_OP != 'INSERT' THEN row_to_json(OLD) ELSE NULL END,
    CASE WHEN TG_OP != 'DELETE' THEN row_to_json(NEW) ELSE NULL END,
    -- Legacy columns for compatibility
    'memory.' || lower(TG_OP),
    'system',
    'database_trigger',
    true
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_memories ON memories;
CREATE TRIGGER audit_memories
  AFTER INSERT OR UPDATE OR DELETE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION audit_memory_changes();

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to trace causal chain (recursive)
CREATE OR REPLACE FUNCTION trace_causal_chain(
  p_tenant_id UUID,
  p_memory_id UUID,
  p_direction VARCHAR(10), -- 'forward' or 'backward'
  p_max_depth INTEGER DEFAULT 5,
  p_current_depth INTEGER DEFAULT 0
)
RETURNS TABLE(
  memory_id UUID,
  causal_type VARCHAR(20),
  causal_strength DECIMAL(3,2),
  depth INTEGER,
  path TEXT
) AS $$
BEGIN
  IF p_current_depth >= p_max_depth THEN
    RETURN;
  END IF;

  IF p_direction = 'forward' THEN
    -- Trace what this memory caused
    RETURN QUERY
    SELECT 
      cr.effect_memory_id,
      cr.causal_type,
      cr.causal_strength,
      p_current_depth + 1,
      p_memory_id::TEXT || ' -> ' || cr.effect_memory_id::TEXT
    FROM causal_relationships cr
    WHERE cr.cause_memory_id = p_memory_id
      AND cr.tenant_id = p_tenant_id
      AND (cr.valid_until IS NULL OR cr.valid_until > NOW())
    ORDER BY cr.causal_strength DESC;
  ELSE
    -- Trace what caused this memory
    RETURN QUERY
    SELECT 
      cr.cause_memory_id,
      cr.causal_type,
      cr.causal_strength,
      p_current_depth + 1,
      cr.cause_memory_id::TEXT || ' -> ' || p_memory_id::TEXT
    FROM causal_relationships cr
    WHERE cr.effect_memory_id = p_memory_id
      AND cr.tenant_id = p_tenant_id
      AND (cr.valid_until IS NULL OR cr.valid_until > NOW())
    ORDER BY cr.causal_strength DESC;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to search memories at a specific time
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
    (m.embedding <=> p_query_embedding) as distance,
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

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON causal_relationships TO rembr;
GRANT SELECT, INSERT ON temporal_snapshots TO rembr;
GRANT SELECT, INSERT ON audit_logs TO rembr;

-- Update triggers
CREATE TRIGGER update_causal_updated_at
  BEFORE UPDATE ON causal_relationships
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE causal_relationships IS 'Tracks cause-effect relationships between memories for causal reasoning';
COMMENT ON TABLE temporal_snapshots IS 'Named snapshots of knowledge graph state at specific times';
COMMENT ON TABLE audit_logs IS 'Immutable audit trail for compliance and debugging';
