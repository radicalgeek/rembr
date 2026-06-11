-- Migration 012: Task Management Schema
-- REM-69 / RAD-53
-- 
-- Creates database schema for task management system:
-- - Core task entity with metadata
-- - Task dependencies (DAG)
-- - State transition history
-- - Agent assignment tracking
--
-- All tables include RLS policies for tenant isolation.

-- =============================================================================
-- TASKS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  project_id UUID, -- Optional project grouping
  
  -- Core attributes
  title TEXT NOT NULL,
  description TEXT,
  state VARCHAR(50) NOT NULL DEFAULT 'inbox',
  priority VARCHAR(20) DEFAULT 'medium',
  
  -- Metadata
  tags TEXT[] DEFAULT '{}',
  assigned_to UUID, -- Agent or user ID
  parent_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  due_date TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  
  -- Audit
  created_by UUID NOT NULL,
  updated_by UUID,
  
  CONSTRAINT valid_state CHECK (state IN ('inbox', 'backlog', 'ready', 'in_progress', 'review', 'blocked', 'done', 'cancelled')),
  CONSTRAINT valid_priority CHECK (priority IN ('low', 'medium', 'high', 'urgent'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_id ON tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(tenant_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(tenant_id, due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Idempotent: drop-and-recreate so the migration can be safely re-applied
DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_tasks_updated_at();

-- RLS Policy
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_tenant_isolation ON tasks;
CREATE POLICY tasks_tenant_isolation ON tasks
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- TASK DEPENDENCIES TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS task_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  
  -- Dependency relationship
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  
  -- Metadata
  dependency_type VARCHAR(50) DEFAULT 'blocks', -- blocks, related, subtask
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL,
  
  CONSTRAINT no_self_dependency CHECK (task_id != depends_on_task_id),
  CONSTRAINT unique_dependency UNIQUE (task_id, depends_on_task_id),
  CONSTRAINT valid_dependency_type CHECK (dependency_type IN ('blocks', 'related', 'subtask'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_tenant ON task_dependencies(tenant_id);

-- RLS Policy
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_dependencies_tenant_isolation ON task_dependencies;
CREATE POLICY task_dependencies_tenant_isolation ON task_dependencies
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- TASK STATE TRANSITIONS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS task_state_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  
  -- Transition details
  from_state VARCHAR(50),
  to_state VARCHAR(50) NOT NULL,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  transitioned_by UUID NOT NULL,
  
  -- Context
  comment TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  
  CONSTRAINT valid_from_state CHECK (from_state IS NULL OR from_state IN ('inbox', 'backlog', 'ready', 'in_progress', 'review', 'blocked', 'done', 'cancelled')),
  CONSTRAINT valid_to_state CHECK (to_state IN ('inbox', 'backlog', 'ready', 'in_progress', 'review', 'blocked', 'done', 'cancelled'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_task_state_transitions_task ON task_state_transitions(task_id, transitioned_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_state_transitions_tenant ON task_state_transitions(tenant_id);

-- RLS Policy
ALTER TABLE task_state_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_state_transitions_tenant_isolation ON task_state_transitions;
CREATE POLICY task_state_transitions_tenant_isolation ON task_state_transitions
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- TASK ASSIGNMENTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS task_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  
  -- Assignment details
  agent_id UUID NOT NULL, -- Agent or user identifier
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by UUID NOT NULL,
  unassigned_at TIMESTAMPTZ,
  unassigned_by UUID,
  
  -- Context
  role VARCHAR(50), -- owner, reviewer, collaborator
  comment TEXT,
  
  CONSTRAINT valid_role CHECK (role IS NULL OR role IN ('owner', 'reviewer', 'collaborator', 'observer'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_agent ON task_assignments(tenant_id, agent_id, unassigned_at) WHERE unassigned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_task_assignments_tenant ON task_assignments(tenant_id);

-- RLS Policy
ALTER TABLE task_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_assignments_tenant_isolation ON task_assignments;
CREATE POLICY task_assignments_tenant_isolation ON task_assignments
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- =============================================================================
-- MIGRATION METADATA
-- =============================================================================

COMMENT ON TABLE tasks IS 'REM-69: Core task management entity';
COMMENT ON TABLE task_dependencies IS 'REM-69: Task dependency graph (DAG)';
COMMENT ON TABLE task_state_transitions IS 'REM-69: Task state machine history';
COMMENT ON TABLE task_assignments IS 'REM-69: Agent/user assignment tracking';
