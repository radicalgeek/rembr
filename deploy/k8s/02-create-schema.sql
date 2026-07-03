-- Production Schema Export for rembr Test Environment
-- Generated: January 9, 2026
-- Source: Production Prisma Schema + Recent Migrations

-- =====================================================
-- CORE TENANT & USER MANAGEMENT
-- =====================================================

-- Tenants table (organizations/accounts with full Stripe integration)
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  plan VARCHAR(50) NOT NULL DEFAULT 'dev',
  stripe_customer_id VARCHAR(255) UNIQUE,
  stripe_subscription_id VARCHAR(255) UNIQUE,
  subscription_status VARCHAR(50),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  payment_method_last4 VARCHAR(4),
  payment_method_brand VARCHAR(20),
  trial_ends_at TIMESTAMPTZ,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Users table (NextAuth.js compatible with GitHub OAuth)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL UNIQUE,
  email_verified TIMESTAMPTZ,
  name VARCHAR(255),
  image TEXT,
  github_id VARCHAR(255) UNIQUE,
  avatar_url TEXT,
  role VARCHAR(50) NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- NextAuth.js Account table
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  expires_at INTEGER,
  token_type TEXT,
  scope TEXT,
  id_token TEXT,
  session_state TEXT,
  UNIQUE(provider, provider_account_id)
);

-- NextAuth.js Session table
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires TIMESTAMPTZ NOT NULL
);

-- NextAuth.js Verification tokens
CREATE TABLE IF NOT EXISTS verification_tokens (
  identifier TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires TIMESTAMPTZ NOT NULL,
  UNIQUE(identifier, token)
);

-- =====================================================
-- PROJECT & WORKSPACE SYSTEM
-- =====================================================

-- Projects (workspaces within tenants)
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_by UUID REFERENCES users(id),
  -- Personal-project fields: on existing deployments these come from the
  -- prisma migration 20260124000000_add_project_personal_fields; fresh
  -- installs need them here because the engine's searchMemories queries
  -- p.is_personal and p.owner_id.
  is_personal BOOLEAN NOT NULL DEFAULT false,
  owner_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, name)
);

-- =====================================================
-- AUTHENTICATION & API KEYS
-- =====================================================

-- API Keys for MCP authentication
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  key_prefix VARCHAR(20) NOT NULL,
  -- REM-250/REM-252: algorithm tracking + optional per-key salt
  hash_algorithm VARCHAR(20) NOT NULL DEFAULT 'sha256',
  key_salt CHAR(64),
  name VARCHAR(255),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ
);

-- OAuth Apps for Claude Desktop integration
CREATE TABLE IF NOT EXISTS oauth_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  client_id VARCHAR(255) NOT NULL UNIQUE,
  client_secret VARCHAR(255) NOT NULL,
  redirect_uris TEXT[] NOT NULL DEFAULT '{}',
  description TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- OAuth Tokens for active sessions
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id VARCHAR(255) NOT NULL,
  access_token VARCHAR(255) NOT NULL UNIQUE,
  refresh_token VARCHAR(255),
  expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  -- SEP-837 / RFC 9207 (MCP 2026-07-28): issuer binding for OAuth tokens
  issuer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Authorization codes for PKCE flow
CREATE TABLE IF NOT EXISTS authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(255) NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id VARCHAR(255) NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge VARCHAR(255),
  used BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- CORE MEMORY SYSTEM
-- =====================================================

-- Memories table with pgvector embeddings
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(768),
  category VARCHAR(50),
  metadata JSONB,
  relevance_score FLOAT DEFAULT 1.0,
  -- PII detection fields (REM-29)
  pii_detected BOOLEAN DEFAULT FALSE,
  pii_types TEXT[] DEFAULT '{}',
  pii_confidence FLOAT,
  pii_scanned_at TIMESTAMPTZ,
  -- Data retention (REM-29)
  retention_policy VARCHAR(50) DEFAULT 'standard',  -- standard | extended | minimal | gdpr_deleted
  retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Memory embeddings (separate table for different providers)
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding vector(768),
  provider VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- RLM WORKSPACE & CONTEXT SYSTEM (Phase 2)
-- =====================================================

-- Contexts for organizing memories within projects
CREATE TABLE IF NOT EXISTS contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, name)
);

-- Many-to-many relationship: memories <-> contexts
CREATE TABLE IF NOT EXISTS memory_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  context_id UUID NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  relevance_score FLOAT DEFAULT 1.0,
  added_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(memory_id, context_id)
);

-- Context summaries for quick access
CREATE TABLE IF NOT EXISTS context_summaries (
  context_id UUID PRIMARY KEY REFERENCES contexts(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  memory_count INTEGER DEFAULT 0,
  token_estimate INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- CONTEXT SNAPSHOTS FOR RLM HANDOFF
-- =====================================================

-- Immutable snapshots of context state
CREATE TABLE IF NOT EXISTS context_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255),
  description TEXT,
  query TEXT,
  max_tokens INTEGER,
  token_count INTEGER DEFAULT 0,
  memory_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- Snapshot memory copies (immutable)
CREATE TABLE IF NOT EXISTS snapshot_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
  memory_id UUID,
  content TEXT NOT NULL,
  category VARCHAR(50),
  metadata JSONB,
  relevance_score FLOAT DEFAULT 1.0,
  position INTEGER NOT NULL
);

-- Snapshot context links
CREATE TABLE IF NOT EXISTS snapshot_contexts (
  snapshot_id UUID NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
  context_id UUID NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  PRIMARY KEY (snapshot_id, context_id)
);

-- =====================================================
-- INTELLIGENCE LAYER (Phase 3)
-- =====================================================

-- Memory relationships for graph analysis
CREATE TABLE IF NOT EXISTS memory_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relationship_type VARCHAR(50) NOT NULL,
  confidence FLOAT DEFAULT 1.0,
  evidence TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Compiled insights from memory analysis
CREATE TABLE IF NOT EXISTS compiled_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id UUID REFERENCES contexts(id) ON DELETE CASCADE,
  insight_type VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  confidence FLOAT DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Memory tags for categorization
CREATE TABLE IF NOT EXISTS memory_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag VARCHAR(100) NOT NULL,
  tag_type VARCHAR(50),
  confidence FLOAT DEFAULT 1.0
);

-- =====================================================
-- BILLING & USAGE TRACKING
-- =====================================================

-- Tenant plan configurations
CREATE TABLE IF NOT EXISTS tenant_plans (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan VARCHAR(50) NOT NULL CHECK (plan IN ('dev', 'pro', 'team', 'enterprise')),
  stripe_price_id VARCHAR(255),
  stripe_product_id VARCHAR(255),
  memory_limit INTEGER NOT NULL,
  search_limit_daily INTEGER NOT NULL,
  project_limit INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Daily usage tracking for billing
CREATE TABLE IF NOT EXISTS usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  oauth_app_id UUID REFERENCES oauth_apps(id) ON DELETE SET NULL,
  auth_method VARCHAR(50),
  date DATE NOT NULL,
  memories_stored INTEGER DEFAULT 0,
  searches_performed INTEGER DEFAULT 0,
  embeddings_generated INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, project_id, date)
);

-- Stripe webhook events
CREATE TABLE IF NOT EXISTS stripe_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id VARCHAR(255) NOT NULL UNIQUE,
  type VARCHAR(100) NOT NULL,
  data JSONB NOT NULL,
  processed BOOLEAN DEFAULT false,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- MCP SESSIONS
-- =====================================================

-- MCP session tracking removed: MCP 2026-07-28 (SEP-2575) drops protocol
-- sessions and session-based auth (see rembr-mcp migration 026).

-- =====================================================
-- GDPR COMPLIANCE (REM-29)
-- =====================================================

-- GDPR deletion requests (right to erasure)
CREATE TABLE IF NOT EXISTS gdpr_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID,
  requested_by_user_id UUID,
  request_type VARCHAR(50) NOT NULL DEFAULT 'full',  -- full | selective | export
  status VARCHAR(50) NOT NULL DEFAULT 'pending',     -- pending | processing | completed | failed
  memories_deleted INTEGER DEFAULT 0,
  contexts_deleted INTEGER DEFAULT 0,
  snapshots_deleted INTEGER DEFAULT 0,
  error_message TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Consent audit trail (REM-29)
CREATE TABLE IF NOT EXISTS gdpr_consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID,
  event_type VARCHAR(100) NOT NULL,  -- consent_given | consent_withdrawn | data_accessed | data_exported | data_deleted | retention_policy_changed
  resource_type VARCHAR(50),         -- memory | context | snapshot | account
  resource_id UUID,
  previous_value JSONB,
  new_value JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gdpr_deletion_tenant ON gdpr_deletion_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_gdpr_deletion_status ON gdpr_deletion_requests(status);
CREATE INDEX IF NOT EXISTS idx_gdpr_consent_tenant ON gdpr_consent_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gdpr_consent_user ON gdpr_consent_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_retention ON memories(retention_expires_at) WHERE retention_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_pii ON memories(tenant_id) WHERE pii_detected = TRUE;
