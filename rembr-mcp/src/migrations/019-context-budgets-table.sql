-- =============================================================================
-- Migration 019: Context Budgets Table (RAD-85 / REM-100)
-- Token budget allocation and enforcement for ContextPilot.
-- =============================================================================
--
-- budget-management.ts (REM-100) references context_budgets but the table
-- had no CREATE TABLE anywhere. This migration provisions it.
--
-- Features:
--   - Per-tenant named budgets with per-category token allocations
--   - Built-in templates: coding, research, conversation, automation
--   - Warning and critical thresholds for soft enforcement
--   - Compression trigger percentage
--   - Track active/inactive budgets per session
-- =============================================================================

CREATE TABLE IF NOT EXISTS context_budgets (
  id                         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  TEXT         NOT NULL,
  budget_name                TEXT         NOT NULL,
  total_tokens               INTEGER      NOT NULL DEFAULT 128000,
  allocations                JSONB        NOT NULL DEFAULT '{}',
                             -- { "history": 40000, "system": 20000, ... }
  thresholds                 JSONB        NOT NULL DEFAULT '{"warning_percent": 75, "critical_percent": 90}',
  compression_trigger_percent INTEGER     NOT NULL DEFAULT 80,
                             -- Trigger compression at this % of total_tokens
  is_active                  BOOLEAN      NOT NULL DEFAULT TRUE,
  metadata                   JSONB        NOT NULL DEFAULT '{}',
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Each tenant can have at most one active budget with a given name
  CONSTRAINT context_budgets_unique_name UNIQUE (tenant_id, budget_name)
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Primary query: find active budget for tenant
CREATE INDEX IF NOT EXISTS idx_budgets_tenant_active
  ON context_budgets (tenant_id, is_active);

-- History queries
CREATE INDEX IF NOT EXISTS idx_budgets_tenant_created
  ON context_budgets (tenant_id, created_at DESC);

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_context_budgets_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_context_budgets_updated_at ON context_budgets;
CREATE TRIGGER trg_context_budgets_updated_at
  BEFORE UPDATE ON context_budgets
  FOR EACH ROW EXECUTE FUNCTION update_context_budgets_updated_at();

-- ─── Comment ──────────────────────────────────────────────────────────────────

COMMENT ON TABLE context_budgets IS
  'Token budget allocations for ContextPilot (RAD-85 / REM-100). '
  'Defines per-category token limits used by budget-aware memory search '
  'and context monitoring. Built-in templates: coding, research, conversation, automation.';
