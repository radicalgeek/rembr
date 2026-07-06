-- Migration 025: Agentic runtime follow-up fixes
--
-- The work_queue service uses ON CONFLICT (tenant_id, idempotency_key).
-- Postgres cannot use deferrable unique constraints as ON CONFLICT arbiters,
-- so convert the migration-created constraint to a normal unique index.

ALTER TABLE work_queue
  DROP CONSTRAINT IF EXISTS work_queue_tenant_id_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_queue_tenant_idempotency_unique
  ON work_queue (tenant_id, idempotency_key);
