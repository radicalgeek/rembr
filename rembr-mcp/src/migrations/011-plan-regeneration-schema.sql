-- Migration 011: Plan Regeneration Service Schema (REM-76)
--
-- Overview:
-- Creates database schema for auto-unstuck plan regeneration mechanism:
-- - plan_regenerations: Stores regeneration events and context snapshots
-- - task_iterations: Tracks task execution attempts and outcomes
--
-- All tables use tenant_id for row-level security and multi-tenancy.

-- ============================================================================
-- 1. task_iterations
-- ============================================================================
-- Tracks task execution attempts, approaches, and outcomes.
-- Used to detect stuck patterns and provide context for plan regeneration.

CREATE TABLE IF NOT EXISTS task_iterations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    task_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    approach TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    metadata JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT task_iterations_unique UNIQUE (tenant_id, task_id, attempt_number)
);

-- Indexes for iteration queries
CREATE INDEX idx_task_iterations_tenant ON task_iterations(tenant_id);
CREATE INDEX idx_task_iterations_task ON task_iterations(task_id);
CREATE INDEX idx_task_iterations_started_at ON task_iterations(started_at DESC);
CREATE INDEX idx_task_iterations_attempt ON task_iterations(attempt_number);

-- Enable RLS
ALTER TABLE task_iterations ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_iterations_tenant_isolation ON task_iterations
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);


-- ============================================================================
-- 2. plan_regenerations
-- ============================================================================
-- Stores plan regeneration events, context snapshots, and generated prompts.
-- Tracks when and why plan regeneration was triggered, and the outcome.

CREATE TABLE IF NOT EXISTS plan_regenerations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    task_id TEXT NOT NULL,
    reason_type TEXT NOT NULL,  -- stuck_detection, manual, failure_threshold, timeout
    reason_description TEXT NOT NULL,
    context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Full StuckContext snapshot
    generated_prompt JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Generated RegenerationPrompt
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    new_plan TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT plan_regenerations_tenant_task_fk 
        FOREIGN KEY (tenant_id, task_id) 
        REFERENCES task_iterations(tenant_id, task_id)
        ON DELETE CASCADE
);

-- Indexes for regeneration queries
CREATE INDEX idx_plan_regenerations_tenant ON plan_regenerations(tenant_id);
CREATE INDEX idx_plan_regenerations_task ON plan_regenerations(task_id);
CREATE INDEX idx_plan_regenerations_triggered_at ON plan_regenerations(triggered_at DESC);
CREATE INDEX idx_plan_regenerations_reason_type ON plan_regenerations(reason_type);
CREATE INDEX idx_plan_regenerations_resolved ON plan_regenerations(resolved_at) WHERE resolved_at IS NOT NULL;

-- GIN indexes for JSONB queries
CREATE INDEX idx_plan_regenerations_context ON plan_regenerations USING GIN (context_snapshot);
CREATE INDEX idx_plan_regenerations_prompt ON plan_regenerations USING GIN (generated_prompt);

-- Enable RLS
ALTER TABLE plan_regenerations ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_regenerations_tenant_isolation ON plan_regenerations
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::uuid);


-- ============================================================================
-- Comments for documentation
-- ============================================================================

COMMENT ON TABLE task_iterations IS 'Tracks task execution attempts and outcomes for stuck detection (REM-76)';
COMMENT ON TABLE plan_regenerations IS 'Stores plan regeneration events and context snapshots (REM-76)';

COMMENT ON COLUMN task_iterations.attempt_number IS 'Sequential attempt number for this task (1, 2, 3, ...)';
COMMENT ON COLUMN task_iterations.approach IS 'High-level description of the approach taken in this iteration';
COMMENT ON COLUMN task_iterations.outcome IS 'Human-readable outcome (success, failed, blocked, etc.)';
COMMENT ON COLUMN task_iterations.error IS 'Error message or exception details if iteration failed';

COMMENT ON COLUMN plan_regenerations.context_snapshot IS 'Full StuckContext snapshot at time of regeneration trigger';
COMMENT ON COLUMN plan_regenerations.generated_prompt IS 'Structured prompt generated for agent to create new plan';
COMMENT ON COLUMN plan_regenerations.new_plan IS 'New plan created by agent in response to regeneration prompt';
