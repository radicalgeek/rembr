-- ============================================================================
-- Migration 006: Audit Log Tamper-Resistance (REM-251)
-- ============================================================================
-- Adds tamper-resistance and chain-integrity verification to audit_logs:
--   1. tenant_seq_num BIGINT — gap detection within one tenant chain
--   2. entry_hash TEXT   — SHA-256 of this record's key fields (pgcrypto)
--   3. prev_hash TEXT    — entry_hash of the previous record (per tenant)
--   4. Immutability trigger — RAISE EXCEPTION on any UPDATE or DELETE attempt
--   5. Before-insert trigger — computes entry_hash + prev_hash automatically
--
-- Tamper detection:
--   - Modified record    → entry_hash no longer matches recomputed hash
--   - Deleted record     → tenant_seq_num gap in the tenant sequence
--   - Inserted fake row  → prev_hash chain break
-- ============================================================================

-- Prerequisite: pgcrypto for SHA-256
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── New columns ─────────────────────────────────────────────────────────────

-- Sequential number for gap-based deletion detection
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS seq_num BIGSERIAL;

-- Global BIGSERIAL remains a useful event identity, but cannot prove
-- per-tenant continuity when tenants insert concurrently/interleaved.
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS tenant_seq_num BIGINT;

-- SHA-256 hash of this record's immutable fields
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS entry_hash TEXT;

-- SHA-256 hash of the previous record in this tenant's chain
-- NULL for the first record per tenant
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS prev_hash TEXT;

-- Index to efficiently find the previous record when inserting
CREATE INDEX IF NOT EXISTS idx_audit_tenant_seq ON audit_logs(tenant_id, tenant_seq_num DESC);
-- Keep the NULL/system chain separate without reserving a sentinel tenant UUID.
DROP INDEX IF EXISTS idx_audit_tenant_sequence_unique;
CREATE UNIQUE INDEX idx_audit_tenant_sequence_unique
  ON audit_logs (tenant_id, tenant_seq_num)
  WHERE tenant_id IS NOT NULL AND tenant_seq_num IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_system_sequence_unique
  ON audit_logs (tenant_seq_num)
  WHERE tenant_id IS NULL AND tenant_seq_num IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_chain_heads (
  chain_key TEXT PRIMARY KEY,
  last_seq BIGINT NOT NULL,
  last_hash TEXT
);
REVOKE ALL ON TABLE audit_chain_heads FROM PUBLIC;
DO $chain_head_privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rembr_app') THEN
    REVOKE ALL PRIVILEGES ON TABLE audit_chain_heads FROM rembr_app;
  END IF;
END
$chain_head_privileges$;

-- ─── Trigger: compute hashes on insert ───────────────────────────────────────

CREATE OR REPLACE FUNCTION set_audit_entry_hash()
RETURNS TRIGGER AS $$
DECLARE
  v_chain_key TEXT;
  v_tenant_seq BIGINT;
  v_prev_hash TEXT;
  v_entry_hash TEXT;
BEGIN
  v_chain_key := COALESCE(NEW.tenant_id::text, '__system__');

  -- Serialise every chain head, including a stable NULL/system chain. The
  -- advisory lock and head update are transaction-scoped, so a failed insert
  -- rolls both back and concurrent inserts cannot fork from one predecessor.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_chain_key, 0));
  SELECT last_seq, last_hash
    INTO v_tenant_seq, v_prev_hash
    FROM public.audit_chain_heads
   WHERE chain_key = v_chain_key
   FOR UPDATE;

  v_tenant_seq := COALESCE(v_tenant_seq, 0) + 1;
  NEW.tenant_seq_num := v_tenant_seq;

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
      COALESCE(NEW.api_key_id::text,    '') || '|' ||
      COALESCE(NEW.agent_id,            '') || '|' ||
      COALESCE(NEW.ip_address::text,     '') || '|' ||
      COALESCE(NEW.user_agent,           '') || '|' ||
      COALESCE(NEW.event_type,          '') || '|' ||
      COALESCE(NEW.resource_type,       '') || '|' ||
      COALESCE(NEW.resource_id::text,   '') || '|' ||
      COALESCE(NEW.action_result,       '') || '|' ||
      COALESCE(NEW.error_message,       '') || '|' ||
      COALESCE(NEW.payload_before::text, '') || '|' ||
      COALESCE(NEW.payload_after::text, '') || '|' ||
      COALESCE(NEW.query_parameters::text, '') || '|' ||
      COALESCE(NEW.session_id,          '') || '|' ||
      COALESCE(NEW.request_id,          '') || '|' ||
      COALESCE(NEW.metadata::text,      '') || '|' ||
      COALESCE(NEW.type,                '') || '|' ||
      COALESCE(NEW.user_identifier,     '') || '|' ||
      COALESCE(NEW.provider,            '') || '|' ||
      COALESCE(NEW.success::text,       '') || '|' ||
      EXTRACT(EPOCH FROM NEW.created_at)::text || '|' ||
      NEW.tenant_seq_num::text || '|' ||
      COALESCE(v_prev_hash, 'GENESIS'),
      'sha256'
    ),
    'hex'
  );

  NEW.entry_hash := v_entry_hash;
  INSERT INTO public.audit_chain_heads(chain_key, last_seq, last_hash)
  VALUES (v_chain_key, v_tenant_seq, v_entry_hash)
  ON CONFLICT (chain_key) DO UPDATE
    SET last_seq = EXCLUDED.last_seq,
        last_hash = EXCLUDED.last_hash;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION set_audit_entry_hash() FROM PUBLIC;

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
-- Reconcile pre-existing records into one canonical order. Re-running the
-- migration is deterministic and leaves the same tenant sequences/hashes.
-- We disable the immutability trigger only inside this migration transaction.

DO $$
DECLARE
  v_row audit_logs%ROWTYPE;
  v_prev_hash TEXT := NULL;
  v_entry_hash TEXT;
  v_chain_key TEXT;
  v_last_chain_key TEXT := NULL;
  v_tenant_seq BIGINT := 0;
BEGIN
  -- Temporarily disable the immutability trigger for backfill
  ALTER TABLE audit_logs DISABLE TRIGGER audit_immutable;

  FOR v_row IN
    SELECT * FROM audit_logs
    ORDER BY COALESCE(tenant_id::text, '__system__'), seq_num ASC NULLS LAST, id ASC
  LOOP
    v_chain_key := COALESCE(v_row.tenant_id::text, '__system__');
    IF v_chain_key IS DISTINCT FROM v_last_chain_key THEN
      v_prev_hash := NULL;
      v_tenant_seq := 0;
      v_last_chain_key := v_chain_key;
    END IF;
    v_tenant_seq := v_tenant_seq + 1;

    v_entry_hash := encode(
      digest(
        COALESCE(v_row.id::text,            '') || '|' ||
        COALESCE(v_row.tenant_id::text,     '') || '|' ||
        COALESCE(v_row.user_id::text,       '') || '|' ||
        COALESCE(v_row.api_key_id::text,    '') || '|' ||
        COALESCE(v_row.agent_id,            '') || '|' ||
        COALESCE(v_row.ip_address::text,     '') || '|' ||
        COALESCE(v_row.user_agent,           '') || '|' ||
        COALESCE(v_row.event_type,          '') || '|' ||
        COALESCE(v_row.resource_type,       '') || '|' ||
        COALESCE(v_row.resource_id::text,   '') || '|' ||
        COALESCE(v_row.action_result,       '') || '|' ||
        COALESCE(v_row.error_message,       '') || '|' ||
        COALESCE(v_row.payload_before::text, '') || '|' ||
        COALESCE(v_row.payload_after::text, '') || '|' ||
        COALESCE(v_row.query_parameters::text, '') || '|' ||
        COALESCE(v_row.session_id,          '') || '|' ||
        COALESCE(v_row.request_id,          '') || '|' ||
        COALESCE(v_row.metadata::text,      '') || '|' ||
        COALESCE(v_row.type,                '') || '|' ||
        COALESCE(v_row.user_identifier,     '') || '|' ||
        COALESCE(v_row.provider,            '') || '|' ||
        COALESCE(v_row.success::text,       '') || '|' ||
        EXTRACT(EPOCH FROM v_row.created_at)::text || '|' ||
        v_tenant_seq::text || '|' ||
        COALESCE(v_prev_hash, 'GENESIS'),
        'sha256'
      ),
      'hex'
    );

    UPDATE audit_logs
       SET entry_hash = v_entry_hash,
           prev_hash  = v_prev_hash,
           tenant_seq_num = v_tenant_seq
     WHERE id = v_row.id;

    v_prev_hash := v_entry_hash;
  END LOOP;

  TRUNCATE TABLE audit_chain_heads;
  INSERT INTO audit_chain_heads(chain_key, last_seq, last_hash)
  SELECT DISTINCT ON (COALESCE(tenant_id::text, '__system__'))
         COALESCE(tenant_id::text, '__system__'), tenant_seq_num, entry_hash
    FROM audit_logs
   WHERE tenant_seq_num IS NOT NULL
   ORDER BY COALESCE(tenant_id::text, '__system__'), tenant_seq_num DESC, id DESC;

  -- Re-enable the immutability trigger
  ALTER TABLE audit_logs ENABLE TRIGGER audit_immutable;
END $$;
