-- =============================================================================
-- Migration 006: Vector Similarity Search — Index Strategy & Runtime Tuning
-- REM-254: Vector similarity search performance at scale
-- =============================================================================
--
-- BACKGROUND
-- ----------
-- rembr stores 768-dimensional embeddings (nomic-embed-text) for every memory
-- and memory-embedding record.  Similarity search (cosine distance) is the
-- hot path for context retrieval.
--
-- INDEX TYPE: HNSW (Hierarchical Navigable Small World)
-- ------------------------------------------------------
-- HNSW is chosen over IVFFlat for the following reasons:
--
--  | Property              | HNSW                        | IVFFlat                     |
--  |-----------------------|-----------------------------|-----------------------------|
--  | Build time            | Slower (kept manageable)    | Faster                      |
--  | Query speed           | Fast (no cluster scan)      | Depends on probes setting   |
--  | Recall quality        | High (≥ 95% typical)        | Moderate (tunable)          |
--  | Incremental inserts   | ✅ Supports online inserts  | ❌ Requires VACUUM/rebuild  |
--  | Memory per vector     | Higher (graph overhead)     | Lower                       |
--
-- IVFFlat would require a full VACUUM + reindex whenever large batches of
-- vectors are inserted (lists shift).  HNSW handles incremental writes natively,
-- which matches rembr's append-heavy workload.
--
-- HNSW PARAMETERS (set in 03-create-indexes.sql)
-- -----------------------------------------------
--  m = 16            — max bidirectional edges per node in the graph.
--                      Higher → better recall + faster queries, more memory.
--                      16 is the pgvector-recommended default for general use.
--
--  ef_construction = 64 — candidate list size during index build.
--                      Higher → better index quality, slower build.
--                      64 is a safe balance for datasets up to ~10 M vectors.
--
-- RUNTIME TUNING: ef_search
-- --------------------------
-- ef_search controls the candidate list size at query time.
-- It is a GUC (Grand Unified Configuration) parameter that can be set:
--   - Per-session     : SET hnsw.ef_search = 100;
--   - Per-transaction : SET LOCAL hnsw.ef_search = 100;
--   - Globally        : ALTER DATABASE rembr SET hnsw.ef_search = 100;
--
-- Default pgvector value: 40 (pgvector ≥ 0.6)
-- Recommended for rembr:  64 — matches ef_construction, gives ~97 % recall
--                              while keeping p50 query latency < 5 ms on
--                              datasets up to ~1 M rows.
--
-- Increasing to 128 raises recall to ~99 % at roughly 2× query cost.
-- This is appropriate when a tenant has > 100 k memories and precision matters
-- more than throughput.
--
-- PERFORMANCE GUIDANCE
-- ---------------------
-- 1. Keep maintenance_work_mem ≥ 256 MB during index builds.
-- 2. Index build is single-threaded; schedule during low-traffic windows.
-- 3. Monitor index bloat with: SELECT * FROM pg_stat_user_indexes
--    WHERE indexname LIKE '%embedding%';
-- 4. Re-index rarely (HNSW degrades < 1 % after normal insert churn).
--    Only consider REINDEX if bulk-deleting > 50 % of rows.
--
-- =============================================================================

-- Set the recommended ef_search default at the database level.
-- Individual queries can override with SET hnsw.ef_search = <n> for the session.
ALTER DATABASE rembr SET hnsw.ef_search = 64;

-- Document the index parameters in a metadata table for observability.
CREATE TABLE IF NOT EXISTS vector_index_config (
  id             SERIAL PRIMARY KEY,
  index_name     TEXT NOT NULL UNIQUE,
  table_name     TEXT NOT NULL,
  column_name    TEXT NOT NULL,
  index_type     TEXT NOT NULL,
  dimensions     INT  NOT NULL,
  distance_op    TEXT NOT NULL,
  m              INT,
  ef_construction INT,
  ef_search_default INT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO vector_index_config
  (index_name, table_name, column_name, index_type, dimensions, distance_op, m, ef_construction, ef_search_default, notes)
VALUES
  ('idx_memories_embedding',  'memories',         'embedding', 'hnsw', 768, 'vector_cosine_ops', 16, 64, 64,
   'Primary similarity search index. Increase ef_search to 128 for high-precision recall at > 100 k rows per tenant.'),
  ('idx_embeddings_vector',   'memory_embeddings','embedding', 'hnsw', 768, 'vector_cosine_ops', 16, 64, 64,
   'Secondary embedding store index. Same tuning guidance as idx_memories_embedding.')
ON CONFLICT (index_name) DO UPDATE
  SET ef_search_default = EXCLUDED.ef_search_default,
      notes             = EXCLUDED.notes;
