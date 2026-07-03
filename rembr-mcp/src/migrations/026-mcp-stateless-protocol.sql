-- Migration 026: MCP 2026-07-28 stateless protocol
--
-- 1. SEP-837 / RFC 9207: bind OAuth credentials to their issuer.
--    rembr-ui populates this at token issuance; rembr-mcp validates it in
--    verifyOAuthToken() (advisory by default, enforced when
--    OAUTH_ENFORCE_ISSUER=true).
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS issuer TEXT;

-- 2. SEP-2575: Mcp-Session-Id was removed from the protocol and the
--    session-auth fallback retired. mcp_sessions held only ephemeral
--    session-auth cache rows (24h expiry), so dropping it loses no durable
--    data. Clients using session auth must switch to API keys or OAuth.
DROP TABLE IF EXISTS mcp_sessions;
