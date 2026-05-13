-- Migration: Auto-Optimization Tables
-- Date: 2026-01-20
-- Description: Database schema for auto-optimization feature
-- Adds 4 tables: optimization_history, graph_quality_metrics, optimization_config, archived_memories

-- 1. optimization_history: Track all optimization operations
CREATE TABLE IF NOT EXISTS optimization_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  
  operation_type VARCHAR(50) NOT NULL, -- 'deduplication', 'temporal_analysis', 'relationship_update', 'quality_check'
  status VARCHAR(20) NOT NULL, -- 'success', 'partial', 'failed'
  
  memories_processed INTEGER NOT NULL DEFAULT 0,
  duplicates_found INTEGER DEFAULT 0,
  duplicates_merged INTEGER DEFAULT 0,
  outdated_marked INTEGER DEFAULT 0,
  relationships_added INTEGER DEFAULT 0,
  relationships_removed INTEGER DEFAULT 0,
  
  quality_score_before DECIMAL(3,2),
  quality_score_after DECIMAL(3,2),
  
  duration_ms INTEGER NOT NULL,
  error_message TEXT,
  metadata JSONB,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_optimization_history_tenant ON optimization_history(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_optimization_history_type ON optimization_history(operation_type, status);

-- RLS Policy for optimization_history
ALTER TABLE optimization_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON optimization_history;
CREATE POLICY tenant_isolation ON optimization_history
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));


-- 2. graph_quality_metrics: Track graph health over time
CREATE TABLE IF NOT EXISTS graph_quality_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  
  total_memories INTEGER NOT NULL,
  active_memories INTEGER NOT NULL,
  archived_memories INTEGER NOT NULL,
  
  duplicate_clusters INTEGER DEFAULT 0,
  estimated_duplicates INTEGER DEFAULT 0,
  
  outdated_memories INTEGER DEFAULT 0,
  fresh_memories INTEGER NOT NULL, -- < 30 days
  
  total_relationships INTEGER NOT NULL,
  orphaned_memories INTEGER DEFAULT 0, -- 0 relationships
  highly_connected INTEGER DEFAULT 0, -- > 10 relationships
  
  avg_relationships_per_memory DECIMAL(5,2),
  relationship_density DECIMAL(5,4), -- actual / possible
  
  overall_quality_score DECIMAL(3,2) NOT NULL, -- 0.00-1.00
  
  metadata JSONB,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quality_metrics_tenant ON graph_quality_metrics(tenant_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_metrics_score ON graph_quality_metrics(overall_quality_score);

-- RLS Policy for graph_quality_metrics
ALTER TABLE graph_quality_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON graph_quality_metrics;
CREATE POLICY tenant_isolation ON graph_quality_metrics
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));


-- 3. optimization_config: Per-tenant optimization settings
CREATE TABLE IF NOT EXISTS optimization_config (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  
  -- Scheduling
  schedule_frequency VARCHAR(20) NOT NULL DEFAULT 'daily', -- 'hourly', 'daily', 'weekly', 'monthly'
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  
  -- Deduplication Settings
  dedup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  dedup_similarity_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.85, -- 0.00-1.00
  dedup_batch_size INTEGER NOT NULL DEFAULT 100,
  
  -- Temporal Analysis Settings
  temporal_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  outdated_threshold_days INTEGER NOT NULL DEFAULT 180,
  archive_outdated BOOLEAN NOT NULL DEFAULT FALSE,
  
  -- Relationship Settings
  relationship_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  relationship_min_score DECIMAL(3,2) NOT NULL DEFAULT 0.70,
  relationship_batch_size INTEGER NOT NULL DEFAULT 50,
  
  -- Quality Thresholds
  quality_alert_threshold DECIMAL(3,2) NOT NULL DEFAULT 0.60,
  
  metadata JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS Policy for optimization_config
ALTER TABLE optimization_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON optimization_config;
CREATE POLICY tenant_isolation ON optimization_config
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));


-- 4. archived_memories: Store memories removed during optimization
CREATE TABLE IF NOT EXISTS archived_memories (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  project_id UUID,
  user_id UUID,
  
  content TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  embedding vector(768),
  
  archived_reason VARCHAR(100) NOT NULL, -- 'outdated', 'duplicate', 'manual'
  replaced_by_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  
  original_created_at TIMESTAMPTZ NOT NULL,
  original_updated_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_archived_tenant ON archived_memories(tenant_id, archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_archived_reason ON archived_memories(archived_reason);

-- RLS Policy for archived_memories
ALTER TABLE archived_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON archived_memories;
CREATE POLICY tenant_isolation ON archived_memories
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

-- Migration complete
