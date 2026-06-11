-- Migration: purge pre-fix plaintext OAuth tokens
-- Context: commit 22f15cf7 (2026-02-24) added SHA-256 hashing to storeOAuthToken().
-- Tokens stored before that date have plaintext values in access_token column.
-- Identification: plaintext tokens are 74 chars (mcp_oauth_ + 64 hex); hashed tokens are 64-char hex.
-- These plaintext tokens are already unusable (verifyOAuthToken hashes before lookup),
-- but they remain a risk if the DB is compromised (attacker could use them directly as Bearer tokens).
-- This migration purges them. All active sessions will need to re-authenticate.
--
-- Run against: test DB + prod DB (after user communication if needed)
-- Idempotent: safe to re-run.

DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM oauth_tokens
  WHERE (length(access_token) = 74 AND access_token LIKE 'mcp_oauth_%')
     OR (length(refresh_token) = 76 AND refresh_token LIKE 'mcp_refresh_%');

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Purged % plaintext OAuth tokens', deleted_count;
END $$;
