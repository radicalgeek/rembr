-- =============================================================================
-- Migration 007: API Key Security — Salt Column + Algorithm Tracking
-- REM-250: SHA-256 without salt — vulnerable to rainbow table attacks
-- REM-252: Timing-safe comparison and upgrade path to HMAC-SHA256
-- =============================================================================
--
-- BACKGROUND
-- ----------
-- The original api_keys table stored key hashes as plain SHA-256 hex strings.
-- This is vulnerable to rainbow table attacks for any key where the attacker
-- can enumerate a large set of plausible values (even though rembr keys are
-- random, a compromised DB could be searched offline with a GPU cluster).
--
-- FIX STRATEGY
-- ------------
-- New keys (issued after this migration) are hashed with HMAC-SHA256, using
-- API_KEY_SECRET as the server-side HMAC key.  This eliminates rainbow table
-- attacks entirely — the attacker would need both the DB and the secret.
--
-- Existing keys are NOT re-hashed (the plaintext is not stored), so they
-- retain hash_algorithm = 'sha256'.  They remain valid and continue to work.
-- Users with existing keys are not disrupted.
--
-- Over time, key rotation (delete + re-issue) will naturally migrate the estate
-- to HMAC-SHA256.  To force a full rotation, revoke all keys and re-issue.
--
-- TIMING-SAFE COMPARISON (REM-252)
-- ---------------------------------
-- Application code now uses `crypto.timingSafeEqual()` (via the
-- `timingSafeCompare` helper in auth.ts) to compare the computed hash against
-- the stored hash.  This prevents timing-oracle attacks that could allow an
-- attacker to enumerate valid key_prefix values by measuring response latency.
--
-- COLUMNS ADDED
-- -------------
--  key_salt       CHAR(64) NULL  — reserved for optional per-key salt (future use)
--                                  Currently unused; HMAC covers the rainbow-table
--                                  attack surface without per-key salt complexity.
--  hash_algorithm VARCHAR(20)    — 'sha256' (legacy) | 'hmac-sha256' (new)
--                                  Application reads this column to choose the
--                                  correct verification path.
-- =============================================================================

-- 1. Add hash_algorithm column (default 'sha256' to mark all existing rows as legacy)
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS hash_algorithm VARCHAR(20) NOT NULL DEFAULT 'sha256';

-- 2. Add key_salt column (nullable, reserved for future per-key salt support)
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS key_salt CHAR(64);

-- 3. Comment documenting the security model
COMMENT ON COLUMN api_keys.key_hash IS
  'Hash of the raw API key. Algorithm depends on hash_algorithm column. '
  'sha256: plain SHA-256 hex (legacy). '
  'hmac-sha256: HMAC-SHA256 with API_KEY_SECRET server secret.';

COMMENT ON COLUMN api_keys.hash_algorithm IS
  'Hashing algorithm used for key_hash. '
  'sha256 = legacy plain SHA-256 (vulnerable to rainbow tables). '
  'hmac-sha256 = HMAC-SHA256 with API_KEY_SECRET (preferred for new keys).';

COMMENT ON COLUMN api_keys.key_salt IS
  'Reserved for future per-key salt support. Currently unused. '
  'HMAC with API_KEY_SECRET provides equivalent rainbow-table protection '
  'without per-row salt complexity.';

-- 4. Index on hash_algorithm for monitoring queries
CREATE INDEX IF NOT EXISTS idx_api_keys_algorithm ON api_keys(hash_algorithm);

-- 5. View for security monitoring: identify legacy (unsalted SHA-256) keys
CREATE OR REPLACE VIEW api_keys_security_status AS
SELECT
  tenant_id,
  COUNT(*) FILTER (WHERE hash_algorithm = 'sha256')        AS legacy_sha256_count,
  COUNT(*) FILTER (WHERE hash_algorithm = 'hmac-sha256')   AS hmac_sha256_count,
  COUNT(*) FILTER (WHERE revoked_at IS NULL)                AS active_count,
  MIN(created_at) FILTER (WHERE hash_algorithm = 'sha256') AS oldest_legacy_key
FROM api_keys
GROUP BY tenant_id;

COMMENT ON VIEW api_keys_security_status IS
  'Security monitoring: shows count of legacy SHA-256 vs HMAC-SHA256 keys per tenant. '
  'Target state: legacy_sha256_count = 0 (achieved by revoking and re-issuing all keys).';
