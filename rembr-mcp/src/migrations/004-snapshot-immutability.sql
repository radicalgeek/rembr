-- =====================================================
-- MIGRATION 004: Snapshot Immutability Guarantees
-- =====================================================
-- REM-256: Enforce snapshot immutability at database level
-- Snapshots are designed to be immutable point-in-time captures
-- This migration adds triggers to prevent modifications

-- Function to prevent updates on immutable tables
CREATE OR REPLACE FUNCTION prevent_snapshot_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Snapshots are immutable and cannot be modified. Delete and recreate if needed.';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to prevent deletes on snapshot memories (snapshots can be deleted as a whole)
CREATE OR REPLACE FUNCTION prevent_snapshot_memory_deletion()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Snapshot memories are immutable. Delete the parent snapshot to cascade delete.';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Prevent UPDATE on context_snapshots
DROP TRIGGER IF EXISTS immutable_context_snapshots ON context_snapshots;
CREATE TRIGGER immutable_context_snapshots
  BEFORE UPDATE ON context_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION prevent_snapshot_modification();

-- Prevent UPDATE on snapshot_memories
DROP TRIGGER IF EXISTS immutable_snapshot_memories_update ON snapshot_memories;
CREATE TRIGGER immutable_snapshot_memories_update
  BEFORE UPDATE ON snapshot_memories
  FOR EACH ROW
  EXECUTE FUNCTION prevent_snapshot_modification();

-- Prevent DELETE on snapshot_memories (only allow cascade from parent snapshot)
DROP TRIGGER IF EXISTS immutable_snapshot_memories_delete ON snapshot_memories;
CREATE TRIGGER immutable_snapshot_memories_delete
  BEFORE DELETE ON snapshot_memories
  FOR EACH ROW
  WHEN (pg_trigger_depth() = 0)  -- Only block top-level deletes, allow cascades
  EXECUTE FUNCTION prevent_snapshot_memory_deletion();

-- Prevent UPDATE on snapshot_contexts junction table
DROP TRIGGER IF EXISTS immutable_snapshot_contexts ON snapshot_contexts;
CREATE TRIGGER immutable_snapshot_contexts
  BEFORE UPDATE ON snapshot_contexts
  FOR EACH ROW
  EXECUTE FUNCTION prevent_snapshot_modification();

COMMENT ON FUNCTION prevent_snapshot_modification() IS 'Enforces immutability of snapshot tables';
COMMENT ON FUNCTION prevent_snapshot_memory_deletion() IS 'Prevents direct deletion of snapshot memories (must cascade from snapshot)';
