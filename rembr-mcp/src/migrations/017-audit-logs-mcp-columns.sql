-- =============================================================================
-- Migration 017: Extend audit_logs with MCP-layer columns (RAD-10)
-- =============================================================================
--
-- The audit_logs table is created by the rembr-ui Prisma schema with the
-- minimal set of columns needed for auth event logging:
--   id, type, user_identifier, provider, success, ip_address, user_agent,
--   metadata, created_at
--
-- The rembr-mcp AuditLogger (audit-logger.ts, REM-251) requires additional
-- columns for full MCP-layer audit coverage:
--   tenant_id       — multi-tenant scoping
--   user_id         — UUID user reference
--   api_key_id      — API key used for the request
--   agent_id        — agent identifier
--   event_type      — structured event type (e.g. memory.create)
--   resource_type   — resource category (memory, context, snapshot, ...)
--   resource_id     — UUID of the affected resource
--   action_result   — success | failure | denied
--   error_message   — error detail on failure/denied
--   payload_before  — JSONB snapshot before the operation
--   payload_after   — JSONB snapshot after the operation
--   query_parameters — JSONB of query/filter params
--   session_id      — MCP session identifier
--   request_id      — per-request UUID for correlation
--
-- Migration 006 (audit-tamper-resistance) adds seq_num, entry_hash, prev_hash
-- on top of this base. Both migrations are idempotent (IF NOT EXISTS).
--
-- This migration MUST run BEFORE migration 006.
-- =============================================================================

-- ─── Extend audit_logs with MCP-layer columns ─────────────────────────────

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS tenant_id        UUID,
  ADD COLUMN IF NOT EXISTS user_id          UUID,
  ADD COLUMN IF NOT EXISTS api_key_id       UUID,
  ADD COLUMN IF NOT EXISTS agent_id         TEXT,
  ADD COLUMN IF NOT EXISTS event_type       TEXT,
  ADD COLUMN IF NOT EXISTS resource_type    TEXT,
  ADD COLUMN IF NOT EXISTS resource_id      UUID,
  ADD COLUMN IF NOT EXISTS action_result    TEXT
    CONSTRAINT audit_logs_action_result_check
      CHECK (action_result IN ('success', 'failure', 'denied')),
  ADD COLUMN IF NOT EXISTS error_message    TEXT,
  ADD COLUMN IF NOT EXISTS payload_before   JSONB,
  ADD COLUMN IF NOT EXISTS payload_after    JSONB,
  ADD COLUMN IF NOT EXISTS query_parameters JSONB,
  ADD COLUMN IF NOT EXISTS session_id       TEXT,
  ADD COLUMN IF NOT EXISTS request_id       TEXT;

-- ─── Indexes for common audit query patterns ──────────────────────────────

-- Tenant-scoped queries (primary access pattern for all audit queries)
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created
  ON audit_logs (tenant_id, created_at DESC);

-- Event type filtering (query_audit_log tool)
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type
  ON audit_logs (tenant_id, event_type)
  WHERE event_type IS NOT NULL;

-- Resource lookup (who touched this memory/context/snapshot?)
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource
  ON audit_logs (tenant_id, resource_type, resource_id)
  WHERE resource_id IS NOT NULL;

-- Action result filtering (find failures/denied events)
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_result
  ON audit_logs (tenant_id, action_result)
  WHERE action_result IN ('failure', 'denied');

-- Agent audit trail
CREATE INDEX IF NOT EXISTS idx_audit_logs_agent_id
  ON audit_logs (agent_id)
  WHERE agent_id IS NOT NULL;

-- Request correlation
CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id
  ON audit_logs (request_id)
  WHERE request_id IS NOT NULL;

-- ─── Comment ──────────────────────────────────────────────────────────────

COMMENT ON TABLE audit_logs IS
  'Tamper-resistant audit trail. Prisma base schema extended by migration 017 '
  '(MCP columns) and migration 006 (hash-chain tamper resistance). RAD-10 / REM-251.';
