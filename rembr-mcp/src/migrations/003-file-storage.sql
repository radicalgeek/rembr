-- Migration: 003-file-storage
-- REM-109: File Storage for Memories
-- Adds attachment support with MinIO object storage

-- Attachments table: stores file metadata linked to memories
CREATE TABLE IF NOT EXISTS memory_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  user_id TEXT NOT NULL, -- Owner of the attachment
  
  -- File metadata
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  
  -- MinIO storage location
  minio_bucket TEXT NOT NULL,
  minio_key TEXT NOT NULL, -- Object key in MinIO
  
  -- Timestamps
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Optional metadata (tags, description, etc.)
  metadata JSONB DEFAULT '{}',
  
  -- Privacy: if TRUE, only user_id can access (follows memory privacy)
  is_private BOOLEAN DEFAULT FALSE,
  
  CONSTRAINT unique_minio_key UNIQUE (minio_bucket, minio_key)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_attachments_memory ON memory_attachments(memory_id);
CREATE INDEX IF NOT EXISTS idx_attachments_tenant ON memory_attachments(tenant_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON memory_attachments(user_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_private ON memory_attachments(is_private) WHERE is_private = TRUE;

-- RLS Policy for tenant isolation
ALTER TABLE memory_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON memory_attachments;
CREATE POLICY tenant_isolation ON memory_attachments
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

-- Storage usage tracking per tenant
CREATE TABLE IF NOT EXISTS tenant_storage_usage (
  tenant_id UUID PRIMARY KEY,
  total_bytes BIGINT DEFAULT 0,
  file_count INTEGER DEFAULT 0,
  quota_bytes BIGINT NOT NULL DEFAULT 53687091200, -- 50GB default for test
  
  -- Timestamps
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Metadata (plan tier, warnings, etc.)
  metadata JSONB DEFAULT '{}'
);

-- Index for quota enforcement queries
CREATE INDEX IF NOT EXISTS idx_storage_quota ON tenant_storage_usage(tenant_id, total_bytes);

-- RLS Policy for tenant storage usage
ALTER TABLE tenant_storage_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_storage_usage;
CREATE POLICY tenant_isolation ON tenant_storage_usage
  USING (tenant_id::TEXT = current_setting('app.current_tenant', TRUE));

-- Function to update storage usage after insert
CREATE OR REPLACE FUNCTION update_storage_usage_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO tenant_storage_usage (tenant_id, total_bytes, file_count)
  VALUES (NEW.tenant_id, NEW.size_bytes, 1)
  ON CONFLICT (tenant_id) DO UPDATE
  SET 
    total_bytes = tenant_storage_usage.total_bytes + NEW.size_bytes,
    file_count = tenant_storage_usage.file_count + 1,
    updated_at = NOW();
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update storage usage after delete
CREATE OR REPLACE FUNCTION update_storage_usage_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE tenant_storage_usage
  SET 
    total_bytes = GREATEST(0, total_bytes - OLD.size_bytes),
    file_count = GREATEST(0, file_count - 1),
    updated_at = NOW()
  WHERE tenant_id = OLD.tenant_id;
  
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Triggers for automatic storage usage tracking
DROP TRIGGER IF EXISTS trg_attachment_insert ON memory_attachments;
CREATE TRIGGER trg_attachment_insert
  AFTER INSERT ON memory_attachments
  FOR EACH ROW
  EXECUTE FUNCTION update_storage_usage_on_insert();

DROP TRIGGER IF EXISTS trg_attachment_delete ON memory_attachments;
CREATE TRIGGER trg_attachment_delete
  AFTER DELETE ON memory_attachments
  FOR EACH ROW
  EXECUTE FUNCTION update_storage_usage_on_delete();

-- Comments explaining the feature
COMMENT ON TABLE memory_attachments IS 'File attachments linked to memories (documents, images, etc.)';
COMMENT ON COLUMN memory_attachments.minio_bucket IS 'MinIO bucket name (tenant-scoped)';
COMMENT ON COLUMN memory_attachments.minio_key IS 'Object key in MinIO (UUID-based for uniqueness)';
COMMENT ON COLUMN memory_attachments.is_private IS 'If TRUE, only user_id can access (follows memory privacy)';

COMMENT ON TABLE tenant_storage_usage IS 'Track storage usage per tenant for quota enforcement';
COMMENT ON COLUMN tenant_storage_usage.quota_bytes IS 'Storage quota in bytes (50GB test, 200GB prod)';

-- Migration complete
