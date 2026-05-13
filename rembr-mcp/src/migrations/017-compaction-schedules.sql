-- Migration: Create compaction_schedules table (RAD-73)
-- Tracks pending plan-downgrade compaction requests with grace periods.
-- Agents use this table to schedule compaction, track user consent, and
-- record the outcome once compaction runs.

CREATE TABLE IF NOT EXISTS compaction_schedules (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Plan transition context
  old_plan             TEXT         NOT NULL,
  new_plan             TEXT         NOT NULL,
  old_memory_limit     INTEGER      NOT NULL,
  new_memory_limit     INTEGER      NOT NULL,
  current_memory_count INTEGER      NOT NULL,
  -- Grace period
  scheduled_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  execute_after        TIMESTAMPTZ  NOT NULL,  -- scheduled_at + grace_period_days
  grace_period_days    INTEGER      NOT NULL DEFAULT 7,
  -- Consent
  user_consented       BOOLEAN      NOT NULL DEFAULT FALSE,
  consented_at         TIMESTAMPTZ,
  -- Execution
  status               TEXT         NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','consented','executing','completed','cancelled','failed','overage_allowed')),
  executed_at          TIMESTAMPTZ,
  result               JSONB,       -- CompactionResult snapshot
  -- Notifications sent
  notified_email       BOOLEAN      NOT NULL DEFAULT FALSE,
  notified_inapp       BOOLEAN      NOT NULL DEFAULT FALSE,
  notified_support     BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Audit
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compaction_schedules_tenant
  ON compaction_schedules (tenant_id);

CREATE INDEX IF NOT EXISTS idx_compaction_schedules_status
  ON compaction_schedules (status);

CREATE INDEX IF NOT EXISTS idx_compaction_schedules_execute_after
  ON compaction_schedules (execute_after)
  WHERE status = 'consented';

-- Auto-update updated_at
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column'
  ) THEN
    CREATE TRIGGER compaction_schedules_updated_at
      BEFORE UPDATE ON compaction_schedules
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
