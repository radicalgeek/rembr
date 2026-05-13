-- Migration: 002-pii-detection
-- Phase 0.5 of Master Implementation Plan
-- Adds PII detection fields to memories table

-- Add PII columns to memories table
ALTER TABLE memories 
  ADD COLUMN IF NOT EXISTS pii_detected BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pii_types TEXT[],
  ADD COLUMN IF NOT EXISTS pii_confidence FLOAT,
  ADD COLUMN IF NOT EXISTS pii_scanned_at TIMESTAMPTZ;

-- Index for querying PII-flagged memories
CREATE INDEX IF NOT EXISTS idx_memories_pii ON memories(pii_detected) WHERE pii_detected = TRUE;

-- Audit table for PII access compliance
CREATE TABLE IF NOT EXISTS pii_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL, -- 'view', 'search', 'export', 'redact'
  pii_types TEXT[],
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB DEFAULT '{}'
);

-- Indexes for audit queries
CREATE INDEX IF NOT EXISTS idx_pii_access_tenant ON pii_access_logs(tenant_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pii_access_memory ON pii_access_logs(memory_id);
CREATE INDEX IF NOT EXISTS idx_pii_access_action ON pii_access_logs(action);

-- RLS Policy for pii_access_logs (tenant isolation)
ALTER TABLE pii_access_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON pii_access_logs;
CREATE POLICY tenant_isolation ON pii_access_logs
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

-- Add comment explaining the PII detection feature
COMMENT ON COLUMN memories.pii_detected IS 'Whether PII was detected in memory content';
COMMENT ON COLUMN memories.pii_types IS 'Array of detected PII types: email, phone, ssn, credit_card, etc.';
COMMENT ON COLUMN memories.pii_confidence IS 'Confidence score of PII detection (0.0 to 1.0)';
COMMENT ON COLUMN memories.pii_scanned_at IS 'When the memory was last scanned for PII';

-- Migration complete
