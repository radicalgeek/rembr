-- Migration 010: ContextPilot Database Schema
-- Phase 1 (Foundation) - REM-102 / RAD-87
--
-- Overview:
-- Creates core database schema for ContextPilot functionality:
-- - Context sessions (tracking context window usage)
-- - Context checkpoints (pre-compression state snapshots)
-- - Context budgets (per-tenant budget configurations)
-- - Context analytics events (append-only analytics)
-- - Memories table extensions (checkpoint linkage)
--
-- All tables use tenant_id for row-level security and multi-tenancy.

-- ============================================================================
-- 1. context_sessions
-- ============================================================================
-- Tracks active and historical context sessions for agents.
-- Stores session metadata, token usage, and lifecycle state.

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
    session_state TEXT NOT NULL DEFAULT 'active',  -- active, compressed, expired, archived
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT context_sessions_unique UNIQUE (tenant_id, session_id)
);

-- Indexes for session lookups and analytics
CREATE INDEX idx_context_sessions_tenant ON context_sessions(tenant_id);
CREATE INDEX idx_context_sessions_state ON context_sessions(session_state);
CREATE INDEX idx_context_sessions_created_at ON context_sessions(created_at DESC);
CREATE INDEX idx_context_sessions_updated_at ON context_sessions(updated_at DESC);

-- Enable RLS
ALTER TABLE context_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY context_sessions_tenant_isolation ON context_sessions
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);


-- ============================================================================
-- 2. context_checkpoints
-- ============================================================================
-- Stores pre-compression checkpoint snapshots of context state.
-- Enables rollback and analysis of compression decisions.

CREATE TABLE IF NOT EXISTS context_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    session_id TEXT NOT NULL,
    checkpoint_type TEXT NOT NULL DEFAULT 'compression',  -- compression, manual, scheduled
    token_count_before INTEGER NOT NULL,
    token_count_after INTEGER,
    decisions_snapshot JSONB DEFAULT '[]'::jsonb,  -- Critical decisions to preserve
    pending_snapshot JSONB DEFAULT '[]'::jsonb,    -- Pending actions/tasks
    lifeboat_snapshot JSONB DEFAULT '[]'::jsonb,   -- Essential context that must survive
    linked_memory_ids UUID[] DEFAULT ARRAY[]::UUID[],
    compression_strategy TEXT,  -- Which compression algorithm was used
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT context_checkpoints_session_fk 
        FOREIGN KEY (tenant_id, session_id) 
        REFERENCES context_sessions(tenant_id, session_id)
        ON DELETE CASCADE
);

-- Indexes for checkpoint retrieval
CREATE INDEX idx_context_checkpoints_tenant ON context_checkpoints(tenant_id);
CREATE INDEX idx_context_checkpoints_session ON context_checkpoints(session_id);
CREATE INDEX idx_context_checkpoints_created_at ON context_checkpoints(created_at DESC);
CREATE INDEX idx_context_checkpoints_type ON context_checkpoints(checkpoint_type);

-- GIN index for JSONB queries
CREATE INDEX idx_context_checkpoints_decisions ON context_checkpoints USING GIN (decisions_snapshot);

-- Enable RLS
ALTER TABLE context_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY context_checkpoints_tenant_isolation ON context_checkpoints
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);


-- ============================================================================
-- 3. context_budgets
-- ============================================================================
-- Per-tenant budget configurations and allocations.
-- Defines how tokens are allocated across different context categories.

CREATE TABLE IF NOT EXISTS context_budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    budget_name TEXT NOT NULL,
    total_tokens INTEGER NOT NULL,
    allocations JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Category allocations (decisions: 10000, conversation: 50000, etc.)
    thresholds JSONB DEFAULT '{}'::jsonb,            -- Warning/critical thresholds
    compression_trigger_percent INTEGER DEFAULT 80,  -- Trigger compression at 80% usage
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT context_budgets_unique UNIQUE (tenant_id, budget_name)
);

-- Indexes for budget lookups
CREATE INDEX idx_context_budgets_tenant ON context_budgets(tenant_id);
CREATE INDEX idx_context_budgets_active ON context_budgets(is_active) WHERE is_active = TRUE;

-- Enable RLS
ALTER TABLE context_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY context_budgets_tenant_isolation ON context_budgets
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);


-- ============================================================================
-- 4. context_analytics_events
-- ============================================================================
-- Append-only analytics event log for context usage and compression events.
-- Never updated or deleted - immutable audit trail.

CREATE TABLE IF NOT EXISTS context_analytics_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    session_id TEXT,
    event_type TEXT NOT NULL,  -- usage_snapshot, compression_triggered, compression_completed, budget_exceeded, etc.
    event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    token_count INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for event queries
CREATE INDEX idx_context_analytics_events_tenant ON context_analytics_events(tenant_id);
CREATE INDEX idx_context_analytics_events_session ON context_analytics_events(session_id);
CREATE INDEX idx_context_analytics_events_type ON context_analytics_events(event_type);
CREATE INDEX idx_context_analytics_events_created_at ON context_analytics_events(created_at DESC);

-- GIN index for event data queries
CREATE INDEX idx_context_analytics_events_data ON context_analytics_events USING GIN (event_data);

-- Enable RLS
ALTER TABLE context_analytics_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY context_analytics_events_tenant_isolation ON context_analytics_events
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);


-- ============================================================================
-- 5. Extend memories table
-- ============================================================================
-- Add ContextPilot-specific columns to existing memories table.

-- Add checkpoint_id to link memories to checkpoints
ALTER TABLE memories 
    ADD COLUMN IF NOT EXISTS checkpoint_id UUID 
    REFERENCES context_checkpoints(id) ON DELETE SET NULL;

-- Add context_source to track where memory originated
ALTER TABLE memories 
    ADD COLUMN IF NOT EXISTS context_source TEXT;

-- Index for checkpoint queries
CREATE INDEX IF NOT EXISTS idx_memories_checkpoint_id ON memories(checkpoint_id) 
    WHERE checkpoint_id IS NOT NULL;

-- Index for context source queries
CREATE INDEX IF NOT EXISTS idx_memories_context_source ON memories(context_source) 
    WHERE context_source IS NOT NULL;


-- ============================================================================
-- Triggers for updated_at timestamps
-- ============================================================================

-- Update context_sessions.updated_at on modification
CREATE OR REPLACE FUNCTION update_context_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER context_sessions_updated_at_trigger
    BEFORE UPDATE ON context_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_context_sessions_updated_at();

-- Update context_budgets.updated_at on modification
CREATE OR REPLACE FUNCTION update_context_budgets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER context_budgets_updated_at_trigger
    BEFORE UPDATE ON context_budgets
    FOR EACH ROW
    EXECUTE FUNCTION update_context_budgets_updated_at();


-- ============================================================================
-- Comments for documentation
-- ============================================================================

COMMENT ON TABLE context_sessions IS 'Tracks active and historical context sessions for agents (REM-102)';
COMMENT ON TABLE context_checkpoints IS 'Pre-compression checkpoint snapshots for rollback and analysis (REM-102)';
COMMENT ON TABLE context_budgets IS 'Per-tenant budget configurations and token allocations (REM-102)';
COMMENT ON TABLE context_analytics_events IS 'Append-only analytics event log for context usage (REM-102)';

COMMENT ON COLUMN memories.checkpoint_id IS 'Links memory to checkpoint that created it (REM-102)';
COMMENT ON COLUMN memories.context_source IS 'Tracks where memory originated (compression, lifeboat, etc.) (REM-102)';
