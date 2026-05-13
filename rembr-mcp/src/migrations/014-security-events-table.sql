-- =============================================================================
-- Migration 014: Security Events Table (REM-185)
-- Stores Falco-sourced security events for alerting and digest workflows.
-- =============================================================================
--
-- Schema supports:
--   - REM-200 (WF20): weekly security digest via n8n
--   - WF19: live alert triage (in progress)
--   - Prometheus scraping via security_events_summary view
--
-- Retention: events older than 90 days are eligible for archival (see cleanup job).
-- =============================================================================

-- ─────────────────────────────────────────────────────────
-- ENUM: severity levels (mirrors Falco priority levels)
-- ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE security_event_severity AS ENUM (
    'critical',
    'high',
    'medium',
    'low',
    'debug'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────
-- ENUM: resolution status
-- ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE security_event_status AS ENUM (
    'open',       -- new, not yet triaged
    'ack',        -- acknowledged, being investigated
    'resolved',   -- closed with known resolution
    'suppressed'  -- known false positive, suppressed
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────
-- TABLE: security_events
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_events (
  id              UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event identity
  rule_name       TEXT                    NOT NULL,
  severity        security_event_severity NOT NULL,
  message         TEXT                    NOT NULL,

  -- Kubernetes context (nullable — not all events come from k8s)
  namespace       TEXT,
  pod_name        TEXT,
  container_name  TEXT,
  image           TEXT,

  -- Source and dedup
  source          TEXT                    NOT NULL DEFAULT 'falco',
  fingerprint     TEXT,                  -- sha256(rule_name + namespace + pod_name) for dedup

  -- Resolution tracking
  status          security_event_status   NOT NULL DEFAULT 'open',
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,
  resolution_note TEXT,

  -- Timestamps
  event_time      TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ             NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ             NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────

-- Primary query pattern: digest window (last 7 days)
CREATE INDEX IF NOT EXISTS idx_security_events_created_at
  ON security_events (created_at DESC);

-- Severity filter (critical/high unresolved — used by digest + WF19)
CREATE INDEX IF NOT EXISTS idx_security_events_severity_status
  ON security_events (severity, status);

-- Namespace/pod grouping for top-N ranking
CREATE INDEX IF NOT EXISTS idx_security_events_namespace
  ON security_events (namespace, rule_name);

-- Fingerprint dedup lookup
CREATE INDEX IF NOT EXISTS idx_security_events_fingerprint
  ON security_events (fingerprint)
  WHERE fingerprint IS NOT NULL;

-- ─────────────────────────────────────────────────────────
-- TRIGGER: updated_at auto-maintenance
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_security_events_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_security_events_updated_at ON security_events;
CREATE TRIGGER trg_security_events_updated_at
  BEFORE UPDATE ON security_events
  FOR EACH ROW EXECUTE FUNCTION update_security_events_updated_at();

-- ─────────────────────────────────────────────────────────
-- VIEW: security_events_summary
-- Weekly digest summary — used by WF20 and Prometheus scrape.
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW security_events_weekly_summary AS
SELECT
  severity,
  rule_name,
  namespace,
  status,
  COUNT(*)                                        AS occurrence_count,
  MIN(event_time)                                 AS first_seen,
  MAX(event_time)                                 AS last_seen
FROM security_events
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY severity, rule_name, namespace, status
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'high'     THEN 2
    WHEN 'medium'   THEN 3
    WHEN 'low'      THEN 4
    ELSE            5
  END,
  occurrence_count DESC;

-- ─────────────────────────────────────────────────────────
-- VIEW: prior week (for week-over-week delta in WF20)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW security_events_prior_week_summary AS
SELECT
  severity,
  rule_name,
  namespace,
  status,
  COUNT(*) AS occurrence_count
FROM security_events
WHERE created_at >= NOW() - INTERVAL '14 days'
  AND created_at <  NOW() - INTERVAL '7 days'
GROUP BY severity, rule_name, namespace, status;

-- ─────────────────────────────────────────────────────────
-- COMMENT
-- ─────────────────────────────────────────────────────────
COMMENT ON TABLE security_events IS
  'Falco-sourced security events. Drives WF19 (live triage) and WF20 (weekly digest). REM-185.';
