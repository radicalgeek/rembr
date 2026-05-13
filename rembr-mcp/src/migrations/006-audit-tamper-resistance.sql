-- ============================================================================
-- Migration 006: Audit Log Tamper-Resistance (REM-251)
-- ============================================================================
-- Adds tamper-resistance and chain-integrity verification to audit_logs:
--   1. seq_num BIGSERIAL — sequence for gap-based deletion detection
--   2. entry_hash TEXT   — SHA-256 of this record's key fields (pgcrypto)
--   3. prev_hash TEXT    — entry_hash of the previous record (per tenant)
--   4. Immutability trigger — RAISE EXCEPTION on any UPDATE or DELETE attempt
--   5. Before-insert trigger — computes entry_hash + prev_hash automatically
--
-- Tamper detection:
--   - Modified record    → entry_hash no longer matches recomputed hash
--   - Deleted record     → seq_num gap in the sequence
--   - Inserted fake row  → prev_hash chain break
-- ============================================================================

-- Prerequisite: pgcrypto for SHA-256
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── New columns ─────────────────────────────────────────────────────────────

-- Sequential number for gap-based deletion detection
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS seq_num BIGSERIAL;

-- SHA-256 hash of this record's immutable fields
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS entry_hash TEXT;

-- SHA-256 hash of the previous record in this tenant's chain
-- NULL for the first record per tenant
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS prev_hash TEXT;

-- Index to efficiently find the previous record when inserting
CREATE INDEX IF NOT EXISTS idx_audit_tenant_seq ON audit_logs(tenant_id, seq_num DESC);

-- ─── Trigger: compute hashes on insert ───────────────────────────────────────

CREATE OR REPLACE FUNCTION set_audit_entry_hash()
RETURNS TRIGGER AS $$
DECLARE
  v_prev_hash TEXT;
  v_entry_hash TEXT;
BEGIN
  -- Fetch the most recent entry_hash for this tenant (for chain linking)
  SELECT entry_hash
    INTO v_prev_hash
    FROM audit_logs
   WHERE tenant_id = NEW.tenant_id
   ORDER BY seq_num DESC
   LIMIT 1;

  -- Store the chain link
  NEW.prev_hash := v_prev_hash;

  -- Compute SHA-256 of canonical record fields.
  -- Fields: id, tenant_id, user_id, event_type, resource_type, action_result,
  --         created_at, prev_hash (so tampering prev_hash also breaks the hash).
  v_entry_hash := encode(
    digest(
      COALESCE(NEW.id::text,            '') || '|' ||
      COALESCE(NEW.tenant_id::text,     '') || '|' ||
      COALESCE(NEW.user_id::text,       '') || '|' ||
      COALESCE(NEW.agent_id,            '') || '|' ||
      COALESCE(NEW.event_type,          '') || '|' ||
      COALESCE(NEW.resource_type,       '') || '|' ||
      COALESCE(NEW.resource_id::text,   '') || '|' ||
      COALESCE(NEW.action_result,       '') || '|' ||
      EXTRACT(EPOCH FROM NEW.created_at)::text || '|' ||
      COALESCE(v_prev_hash, 'GENESIS'),
      'sha256'
    ),
    'hex'
  );

  NEW.entry_hash := v_entry_hash;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach BEFORE INSERT (so hash is part of the row from creation)
DROP TRIGGER IF EXISTS audit_set_hash ON audit_logs;
CREATE TRIGGER audit_set_hash
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION set_audit_entry_hash();

-- ─── Trigger: immutability — block UPDATE and DELETE ─────────────────────────

CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Audit logs are immutable. UPDATE is not permitted on audit_logs (record id: %).',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Audit logs are immutable. DELETE is not permitted on audit_logs (record id: %). '
      'Retention-based expiry is the only permitted removal path, and only via the '
      'designated maintenance role.',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_immutable ON audit_logs;
CREATE TRIGGER audit_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_modification();

-- ─── Backfill: compute entry_hash for existing rows ──────────────────────────
-- This is a one-time operation to hash pre-existing records.
-- We disable the immutability trigger temporarily for this backfill.

DO $$
DECLARE
  v_row audit_logs%ROWTYPE;
  v_prev_hash TEXT := NULL;
  v_entry_hash TEXT;
  v_last_tenant UUID := NULL;
BEGIN
  -- Temporarily disable the immutability trigger for backfill
  ALTER TABLE audit_logs DISABLE TRIGGER audit_immutable;

  FOR v_row IN
    SELECT * FROM audit_logs
    WHERE entry_hash IS NULL
    ORDER BY tenant_id, created_at ASC
  LOOP
    -- Reset chain when tenant changes
    IF v_row.tenant_id IS DISTINCT FROM v_last_tenant THEN
      v_prev_hash := NULL;
      v_last_tenant := v_row.tenant_id;
    END IF;

    v_entry_hash := encode(
      digest(
        COALESCE(v_row.id::text,            '') || '|' ||
        COALESCE(v_row.tenant_id::text,     '') || '|' ||
        COALESCE(v_row.user_id::text,       '') || '|' ||
        COALESCE(v_row.agent_id,            '') || '|' ||
        COALESCE(v_row.event_type,          '') || '|' ||
        COALESCE(v_row.resource_type,       '') || '|' ||
        COALESCE(v_row.resource_id::text,   '') || '|' ||
        COALESCE(v_row.action_result,       '') || '|' ||
        EXTRACT(EPOCH FROM v_row.created_at)::text || '|' ||
        COALESCE(v_prev_hash, 'GENESIS'),
        'sha256'
      ),
      'hex'
    );

    UPDATE audit_logs
       SET entry_hash = v_entry_hash,
           prev_hash  = v_prev_hash
     WHERE id = v_row.id;

    v_prev_hash := v_entry_hash;
  END LOOP;

  -- Re-enable the immutability trigger
  ALTER TABLE audit_logs ENABLE TRIGGER audit_immutable;
END $$;
