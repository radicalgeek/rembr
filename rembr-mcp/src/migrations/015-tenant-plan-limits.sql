-- Migration: Create tenant_plan_limits table
-- RAD-70: tenant_plan_limits missing from test database
-- This table enforces per-plan resource limits for each tenant.
--
-- Apply this migration to any database where it is missing:
--   psql $DATABASE_URL -f <this-file>

CREATE TABLE IF NOT EXISTS tenant_plan_limits (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID         NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan                   TEXT         NOT NULL DEFAULT 'free'
                                      CHECK (plan IN ('free', 'pro', 'enterprise')),
  -- Memory limits
  max_memories           INTEGER      NOT NULL DEFAULT 1000,
  max_searches_per_day   INTEGER      NOT NULL DEFAULT 10000,
  max_projects           INTEGER      NOT NULL DEFAULT 5,
  -- API limits
  max_api_keys           INTEGER      NOT NULL DEFAULT 3,
  -- Current usage counters (reset periodically by the app)
  searches_today         INTEGER      NOT NULL DEFAULT 0,
  searches_reset_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Timestamps
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_plan_limits_tenant
  ON tenant_plan_limits (tenant_id);

CREATE INDEX IF NOT EXISTS idx_tenant_plan_limits_plan
  ON tenant_plan_limits (plan);

-- Auto-update updated_at (assumes update_updated_at_column() trigger fn exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column'
  ) THEN
    CREATE TRIGGER tenant_plan_limits_updated_at
      BEFORE UPDATE ON tenant_plan_limits
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- Seed plan limits for any existing tenants that don't have a row yet
INSERT INTO tenant_plan_limits (tenant_id, plan, max_memories, max_searches_per_day, max_projects, max_api_keys)
SELECT
  t.id,
  t.plan,
  CASE t.plan
    WHEN 'free'       THEN 1000
    WHEN 'pro'        THEN 25000
    WHEN 'enterprise' THEN 250000
    ELSE 1000
  END,
  CASE t.plan
    WHEN 'free'       THEN 10000
    WHEN 'pro'        THEN 250000
    WHEN 'enterprise' THEN 3000000
    ELSE 10000
  END,
  CASE t.plan
    WHEN 'free'       THEN 5
    WHEN 'pro'        THEN 25
    WHEN 'enterprise' THEN 2147483647  -- effectively unlimited
    ELSE 5
  END,
  CASE t.plan
    WHEN 'free'       THEN 3
    WHEN 'pro'        THEN 10
    WHEN 'enterprise' THEN 50
    ELSE 3
  END
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_plan_limits tpl WHERE tpl.tenant_id = t.id
)
ON CONFLICT (tenant_id) DO NOTHING;
