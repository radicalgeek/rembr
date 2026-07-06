-- Migration 028: Repair legacy btree vector indexes
--
-- Older deployments created vector indexes with the default btree access
-- method. 768-dimensional pgvector rows are too large for btree inserts, which
-- blocks embedding storage with:
--   index row size ... exceeds btree version 4 maximum ...

DROP INDEX IF EXISTS idx_memories_embedding;
DROP INDEX IF EXISTS idx_embeddings_vector;

ALTER TABLE memories
  ALTER COLUMN embedding TYPE vector(768)
  USING embedding::vector(768);

ALTER TABLE memory_embeddings
  ALTER COLUMN embedding TYPE vector(768)
  USING embedding::vector(768);

CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_embeddings_vector
  ON memory_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
