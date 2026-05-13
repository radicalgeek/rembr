-- =============================================================================
-- Migration 016: Acceptance Criteria Service (RAD-58)
-- Phase 5.1 — per-task acceptance criteria with evidence + memory linking
-- =============================================================================

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          UUID        NOT NULL,      -- foreign key intent; no FK to keep service portable
  criterion        TEXT        NOT NULL,      -- human-readable criterion text
  validation_method TEXT       NOT NULL DEFAULT 'manual',
                               -- 'manual' | 'automated' | 'review'
  status           TEXT        NOT NULL DEFAULT 'pending',
                               -- 'pending' | 'passed' | 'failed' | 'skipped'
  evidence         JSONB,                     -- arbitrary evidence blob
  validated_at     TIMESTAMPTZ,
  validated_by     TEXT,                      -- agent/user ID that validated
  tenant_id        UUID        NOT NULL,      -- for RLS scoping
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Link acceptance criteria to supporting memory IDs
CREATE TABLE IF NOT EXISTS acceptance_criteria_memories (
  criterion_id UUID NOT NULL REFERENCES acceptance_criteria(id) ON DELETE CASCADE,
  memory_id    UUID NOT NULL,
  linked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (criterion_id, memory_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ac_task_id    ON acceptance_criteria(task_id);
CREATE INDEX IF NOT EXISTS idx_ac_tenant_id  ON acceptance_criteria(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ac_status     ON acceptance_criteria(status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_acceptance_criteria_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ac_updated_at ON acceptance_criteria;
CREATE TRIGGER trg_ac_updated_at
  BEFORE UPDATE ON acceptance_criteria
  FOR EACH ROW EXECUTE FUNCTION update_acceptance_criteria_updated_at();
