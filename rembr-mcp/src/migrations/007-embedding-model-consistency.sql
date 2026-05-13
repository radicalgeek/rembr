-- ============================================================================
-- Migration 007: Embedding Model Consistency Tracking (REM-249)
-- ============================================================================
-- Adds model fingerprint tracking to detect incompatible embeddings when
-- the embedding model changes (e.g., nomic-embed-text → all-minilm-l6-v2).
--
-- When the model changes:
--   - Old embeddings are flagged as stale (is_stale = true)
--   - Stale embeddings are excluded from semantic search
--   - Background re-embedding job can regenerate stale vectors
--
-- SCHEMA CHANGES:
--   1. model_fingerprint TEXT — SHA-256(provider || model || dimensions)
--   2. is_stale BOOLEAN       — TRUE when fingerprint != current model
--   3. stale_since TIMESTAMPTZ — when the embedding was flagged stale
-- ============================================================================

-- Add columns to memory_embeddings
ALTER TABLE memory_embeddings
  ADD COLUMN IF NOT EXISTS model_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS is_stale BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stale_since TIMESTAMPTZ;

-- Index for finding stale embeddings
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_stale
  ON memory_embeddings(is_stale, stale_since)
  WHERE is_stale = TRUE;

-- ─── Backfill: compute model_fingerprint for existing rows ──────────────────

DO $$
DECLARE
  v_row memory_embeddings%ROWTYPE;
  v_fingerprint TEXT;
BEGIN
  FOR v_row IN
    SELECT * FROM memory_embeddings
    WHERE model_fingerprint IS NULL
  LOOP
    -- Compute fingerprint: SHA-256(provider || model || dimensions)
    v_fingerprint := encode(
      digest(
        COALESCE(v_row.provider, '') || '|' ||
        COALESCE(v_row.model, '') || '|' ||
        COALESCE(v_row.dimensions::text, ''),
        'sha256'
      ),
      'hex'
    );

    UPDATE memory_embeddings
       SET model_fingerprint = v_fingerprint
     WHERE memory_id = v_row.memory_id;
  END LOOP;
END $$;

-- ─── Function: mark embeddings as stale when model changes ──────────────────

CREATE OR REPLACE FUNCTION mark_stale_embeddings(
  p_current_fingerprint TEXT
)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Flag all embeddings with a different fingerprint as stale
  UPDATE memory_embeddings
     SET is_stale = TRUE,
         stale_since = NOW()
   WHERE model_fingerprint != p_current_fingerprint
     AND is_stale = FALSE;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ─── Function: clear stale flag after re-embedding ──────────────────────────

CREATE OR REPLACE FUNCTION clear_stale_flag(p_memory_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE memory_embeddings
     SET is_stale = FALSE,
         stale_since = NULL
   WHERE memory_id = p_memory_id;
END;
$$ LANGUAGE plpgsql;
