-- =============================================================================
-- Migration 013: Vector Search — Adaptive ef_search Tuning Telemetry
-- REM-249: Vector similarity search performance degrades at scale
-- =============================================================================
--
-- PURPOSE
-- -------
-- Track slow vector searches per tenant so the adaptive tuning logic in
-- VectorSearchService can be validated and future tier boundaries adjusted
-- with real data.
--
-- TABLE: vector_search_stats
-- --------------------------
-- Written by the application for every search where slowQuery = true
-- (i.e., duration > 200 ms). Normal-speed searches are not logged to
-- avoid write amplification on hot-path queries.
--
-- RETENTION
-- ---------
-- Rows older than 30 days are automatically deleted by the trigger
-- clean_old_vector_search_stats, keeping the table small.
--
-- =============================================================================

-- Slow-query telemetry table
CREATE TABLE IF NOT EXISTS vector_search_stats (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  memory_count     BIGINT      NOT NULL,
  ef_search_used   INT         NOT NULL,
  duration_ms      INT         NOT NULL,
  result_count     INT         NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index: recent slow queries per tenant
CREATE INDEX IF NOT EXISTS idx_vss_tenant_recorded
  ON vector_search_stats (tenant_id, recorded_at DESC);

-- RLS: each tenant can only see their own stats rows
ALTER TABLE vector_search_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY vss_tenant_isolation ON vector_search_stats
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Automatic cleanup: remove rows older than 30 days
CREATE OR REPLACE FUNCTION clean_old_vector_search_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM vector_search_stats
  WHERE recorded_at < NOW() - INTERVAL '30 days';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clean_vector_search_stats ON vector_search_stats;
CREATE TRIGGER trg_clean_vector_search_stats
  AFTER INSERT ON vector_search_stats
  EXECUTE FUNCTION clean_old_vector_search_stats();

-- Document ef_search tier configuration for observability
-- (Supplements the vector_index_config table from migration 006)
CREATE TABLE IF NOT EXISTS vector_ef_search_tiers (
  id              SERIAL PRIMARY KEY,
  min_memory_count BIGINT NOT NULL,
  ef_search        INT    NOT NULL,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upsert current tier values
INSERT INTO vector_ef_search_tiers (min_memory_count, ef_search, notes) VALUES
  (0,       40,  'Default for small tenants (< 10k memories). Fast queries, high recall.'),
  (10000,   64,  'Mid-size tenants. Matches database default set in migration 006.'),
  (100000, 100,  'Large tenants. ~97% recall at ~1.5x query cost vs ef_search=64.'),
  (500000, 128,  'Very large tenants. ~99% recall at ~2x query cost vs ef_search=64.')
ON CONFLICT DO NOTHING;
