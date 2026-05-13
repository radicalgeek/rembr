-- Migration 012: Task Handoff Service Schema (REM-73)
--
-- Overview:
-- Creates database schema for inter-agent task handoff mechanism:
-- - task_handoffs: Tracks handoff requests between agents
--
-- All tables use tenant_id for row-level security and multi-tenancy.

-- ============================================================================
-- 1. task_handoffs
-- ============================================================================
-- Tracks task handoff requests between agents.
-- Manages handoff workflow (pending, accepted, rejected).

CREATE TABLE IF NOT EXISTS task_handoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    task_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    reason TEXT NOT NULL,
    context JSONB DEFAULT '{}'::jsonb,  -- Handoff context (current state, notes, etc.)
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, accepted, rejected
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT task_handoffs_status_check CHECK (status IN ('pending', 'accepted', 'rejected'))
);

-- Indexes for handoff queries
CREATE INDEX idx_task_handoffs_tenant ON task_handoffs(tenant_id);
CREATE INDEX idx_task_handoffs_task ON task_handoffs(task_id);
CREATE INDEX idx_task_handoffs_from_agent ON task_handoffs(from_agent);
CREATE INDEX idx_task_handoffs_to_agent ON task_handoffs(to_agent);
CREATE INDEX idx_task_handoffs_status ON task_handoffs(status);
CREATE INDEX idx_task_handoffs_created_at ON task_handoffs(created_at DESC);

-- Composite indexes for common queries
CREATE INDEX idx_task_handoffs_to_agent_status ON task_handoffs(to_agent, status);
CREATE INDEX idx_task_handoffs_from_agent_status ON task_handoffs(from_agent, status);

-- GIN index for context queries
CREATE INDEX idx_task_handoffs_context ON task_handoffs USING GIN (context);

-- Enable RLS
ALTER TABLE task_handoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_handoffs_tenant_isolation ON task_handoffs
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);


-- ============================================================================
-- Comments for documentation
-- ============================================================================

COMMENT ON TABLE task_handoffs IS 'Tracks task handoff requests between agents (REM-73)';

COMMENT ON COLUMN task_handoffs.task_id IS 'ID of the task being handed off';
COMMENT ON COLUMN task_handoffs.from_agent IS 'Agent initiating the handoff';
COMMENT ON COLUMN task_handoffs.to_agent IS 'Agent receiving the handoff';
COMMENT ON COLUMN task_handoffs.reason IS 'Reason for handoff (skills, capacity, blocking issue, etc.)';
COMMENT ON COLUMN task_handoffs.context IS 'Handoff context (current state, progress, blockers, notes)';
COMMENT ON COLUMN task_handoffs.status IS 'Handoff status: pending, accepted, rejected';
COMMENT ON COLUMN task_handoffs.rejection_reason IS 'Reason for rejection (if rejected)';
