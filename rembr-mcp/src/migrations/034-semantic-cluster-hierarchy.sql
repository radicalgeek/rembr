CREATE TABLE IF NOT EXISTS semantic_clusters (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  parent_id UUID REFERENCES semantic_clusters(id) ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK (level >= 0),
  label TEXT NOT NULL,
  centroid vector(768) NOT NULL,
  memory_count INTEGER NOT NULL CHECK (memory_count >= 0),
  category_counts JSONB NOT NULL DEFAULT '{}',
  is_leaf BOOLEAN NOT NULL DEFAULT FALSE,
  source_embedding_count INTEGER,
  source_embedding_at TIMESTAMPTZ,
  algorithm_version INTEGER NOT NULL DEFAULT 2,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE semantic_clusters
  ADD COLUMN IF NOT EXISTS algorithm_version INTEGER NOT NULL DEFAULT 2;

CREATE INDEX IF NOT EXISTS idx_semantic_clusters_tenant_parent
  ON semantic_clusters(tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS semantic_cluster_members (
  cluster_id UUID NOT NULL REFERENCES semantic_clusters(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_semantic_cluster_members_memory
  ON semantic_cluster_members(memory_id);

ALTER TABLE semantic_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_cluster_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS semantic_clusters_tenant_isolation ON semantic_clusters;
CREATE POLICY semantic_clusters_tenant_isolation ON semantic_clusters
  FOR ALL
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

DROP POLICY IF EXISTS semantic_cluster_members_tenant_isolation ON semantic_cluster_members;
CREATE POLICY semantic_cluster_members_tenant_isolation ON semantic_cluster_members
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM semantic_clusters
      WHERE semantic_clusters.id = semantic_cluster_members.cluster_id
        AND semantic_clusters.tenant_id::TEXT = current_setting('app.current_tenant', TRUE)
    )
    AND EXISTS (
      SELECT 1 FROM memories
      WHERE memories.id = semantic_cluster_members.memory_id
        AND memories.tenant_id::TEXT = current_setting('app.current_tenant', TRUE)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM semantic_clusters
      WHERE semantic_clusters.id = semantic_cluster_members.cluster_id
        AND semantic_clusters.tenant_id::TEXT = current_setting('app.current_tenant', TRUE)
    )
    AND EXISTS (
      SELECT 1 FROM memories
      WHERE memories.id = semantic_cluster_members.memory_id
        AND memories.tenant_id::TEXT = current_setting('app.current_tenant', TRUE)
    )
  );
