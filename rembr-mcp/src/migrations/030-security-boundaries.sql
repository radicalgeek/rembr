-- Migration 030: authentication, tenant isolation, snapshot visibility, and RLM RLS
-- Idempotent by design because production currently has no migration ledger.

-- Credential capabilities and lifecycle.
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role VARCHAR(50) NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS hash_algorithm VARCHAR(20);
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(50) NOT NULL DEFAULT 'standard';
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT ARRAY[
    'memory:read', 'memory:write', 'context:manage', 'snapshot:manage'
  ]::TEXT[];

-- Legacy rows predate the marker; any other value is ambiguous and must stop
-- rollout rather than silently falling back to the weaker legacy algorithm.
UPDATE api_keys SET hash_algorithm = 'sha256' WHERE hash_algorithm IS NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM api_keys
    WHERE hash_algorithm NOT IN ('sha256', 'hmac-sha256')
  ) THEN
    RAISE EXCEPTION 'api_keys contains an unsupported hash_algorithm';
  END IF;
END $$;
ALTER TABLE api_keys ALTER COLUMN hash_algorithm SET DEFAULT 'sha256';
ALTER TABLE api_keys ALTER COLUMN hash_algorithm SET NOT NULL;
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_hash_algorithm_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_hash_algorithm_check
  CHECK (hash_algorithm IN ('sha256', 'hmac-sha256'));

ALTER TABLE oauth_apps ADD COLUMN IF NOT EXISTS client_secret_hash VARCHAR(64);
ALTER TABLE oauth_apps
  ADD COLUMN IF NOT EXISTS client_type VARCHAR(20) NOT NULL DEFAULT 'confidential';
ALTER TABLE oauth_apps
  ADD COLUMN IF NOT EXISTS token_endpoint_auth_method VARCHAR(32) NOT NULL DEFAULT 'client_secret_post';
ALTER TABLE oauth_apps
  ADD COLUMN IF NOT EXISTS allowed_scopes TEXT[] NOT NULL DEFAULT ARRAY[
    'openid', 'profile', 'email', 'mcp:read', 'mcp:write', 'mcp:full',
    'read:memories', 'write:memories'
  ]::TEXT[];
-- ADD COLUMN IF NOT EXISTS does not converge a pre-existing default. Set it
-- explicitly so UI-first and MCP-first migration order produce the same OAuth
-- catalogue (API-key capabilities remain canonical and narrower).
ALTER TABLE oauth_apps ALTER COLUMN allowed_scopes SET DEFAULT ARRAY[
  'openid', 'profile', 'email', 'mcp:read', 'mcp:write', 'mcp:full',
  'read:memories', 'write:memories'
]::TEXT[];

UPDATE oauth_apps
SET token_endpoint_auth_method = CASE
  WHEN client_type = 'public' THEN 'none'
  ELSE COALESCE(token_endpoint_auth_method, 'client_secret_post')
END;
ALTER TABLE oauth_apps DROP CONSTRAINT IF EXISTS oauth_apps_token_auth_method_check;
ALTER TABLE oauth_apps ADD CONSTRAINT oauth_apps_token_auth_method_check
  CHECK (
    (client_type = 'public' AND token_endpoint_auth_method = 'none') OR
    (client_type = 'confidential' AND token_endpoint_auth_method IN ('client_secret_post', 'client_secret_basic'))
  );

ALTER TABLE authorization_codes ADD COLUMN IF NOT EXISTS code_challenge_method VARCHAR(20);
ALTER TABLE authorization_codes ADD COLUMN IF NOT EXISTS issuer TEXT;
ALTER TABLE authorization_codes ADD COLUMN IF NOT EXISTS resource VARCHAR(255);
UPDATE authorization_codes
SET resource = 'urn:rembr:reauthorization-required', used = TRUE
WHERE resource IS NULL;
ALTER TABLE authorization_codes ALTER COLUMN resource SET NOT NULL;
ALTER TABLE authorization_codes DROP CONSTRAINT IF EXISTS authorization_codes_pkce_method_check;
ALTER TABLE authorization_codes ADD CONSTRAINT authorization_codes_pkce_method_check
  CHECK (code_challenge_method IS NULL OR code_challenge_method = 'S256');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM authorization_codes WHERE length(issuer) > 255) THEN
    RAISE EXCEPTION 'authorization_codes contains an issuer longer than 255 characters';
  END IF;
END $$;
ALTER TABLE authorization_codes
  ALTER COLUMN code_challenge_method TYPE VARCHAR(10),
  ALTER COLUMN issuer TYPE VARCHAR(255);

ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS audience TEXT;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS resource VARCHAR(255);
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS project_id UUID;
-- Resource identifiers are environment-specific; legacy grants are revoked
-- rather than guessed. Re-running preserves already-bound current tokens.
UPDATE oauth_tokens
SET resource = 'urn:rembr:reauthorization-required',
    audience = 'urn:rembr:reauthorization-required',
    revoked_at = COALESCE(revoked_at, NOW())
WHERE resource IS NULL OR audience IS NULL OR resource <> audience;
ALTER TABLE oauth_tokens ALTER COLUMN resource SET NOT NULL;
ALTER TABLE oauth_tokens DROP CONSTRAINT IF EXISTS oauth_tokens_resource_audience_check;
ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_resource_audience_check
  CHECK (resource = audience);

-- Agent-first default hierarchy uses an internal sentinel name. The partial
-- unique index makes concurrent/on-retry provisioning converge on one shared
-- project without constraining ordinary or personal project names.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_one_shared_default_per_tenant
  ON projects (tenant_id)
  WHERE name = '__rembr_shared_default__' AND is_personal = false;

-- Runtime roles do not create feature tables. These owner-managed definitions
-- replace the old per-request CREATE TABLE paths.
CREATE TABLE IF NOT EXISTS audit_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  threshold_id TEXT NOT NULL,
  threshold_name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  metric TEXT NOT NULL,
  observed_value DOUBLE PRECISION NOT NULL,
  threshold_value DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'firing' CHECK (status IN ('firing', 'resolved', 'acknowledged')),
  message TEXT NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_alerts_tenant ON audit_alerts (tenant_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_alerts_status ON audit_alerts (tenant_id, status);

CREATE TABLE IF NOT EXISTS embedding_spaces (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  domain VARCHAR(100) NOT NULL,
  model_config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_embedding_spaces_tenant_domain
  ON embedding_spaces (tenant_id, domain);

CREATE TABLE IF NOT EXISTS saved_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  project_id UUID,
  user_id UUID,
  owner_principal TEXT,
  name TEXT NOT NULL,
  description TEXT,
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS owner_principal TEXT;
-- Legacy tenant-global searches cannot be attributed safely. Quarantine each
-- under an unreachable principal instead of assigning them to the first user.
UPDATE saved_searches
SET owner_principal = 'legacy-quarantined:' || id::text
WHERE owner_principal IS NULL;
ALTER TABLE saved_searches ALTER COLUMN owner_principal SET NOT NULL;
ALTER TABLE saved_searches DROP CONSTRAINT IF EXISTS saved_searches_tenant_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_searches_principal_name
  ON saved_searches (tenant_id, owner_principal, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

CREATE TABLE IF NOT EXISTS gdpr_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID,
  requested_by_user_id UUID,
  request_type VARCHAR(50) NOT NULL DEFAULT 'full',
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  memories_deleted INTEGER NOT NULL DEFAULT 0,
  contexts_deleted INTEGER NOT NULL DEFAULT 0,
  snapshots_deleted INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS gdpr_consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID,
  event_type VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  resource_id UUID,
  previous_value JSONB,
  new_value JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS retention_policy VARCHAR(50) DEFAULT 'standard';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_gdpr_deletion_tenant ON gdpr_deletion_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_gdpr_deletion_status ON gdpr_deletion_requests(status);
CREATE INDEX IF NOT EXISTS idx_gdpr_consent_tenant ON gdpr_consent_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gdpr_consent_user ON gdpr_consent_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_retention ON memories(retention_expires_at)
  WHERE retention_expires_at IS NOT NULL;

-- Personal projects can be deliberately shared with explicit members. Older
-- fresh-install schemas modelled this in Prisma but did not create the table.
CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'member',
  added_by UUID NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members(user_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_active_expiry
  ON api_keys (tenant_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_active_expiry
  ON oauth_tokens (tenant_id, expires_at) WHERE revoked_at IS NULL;

-- Immutable snapshots retain the source audience instead of broadening it.
ALTER TABLE context_snapshots ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE context_snapshots ADD COLUMN IF NOT EXISTS visibility VARCHAR(20);
ALTER TABLE context_snapshots ADD COLUMN IF NOT EXISTS audience_version SMALLINT;
ALTER TABLE snapshot_memories ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE snapshot_memories ADD COLUMN IF NOT EXISTS visibility VARCHAR(20);
ALTER TABLE snapshot_memories ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE snapshot_memories ADD COLUMN IF NOT EXISTS audience_version SMALLINT;

-- Recover audience from the immutable source pointer where possible. Orphaned
-- copies and ambiguous/empty legacy snapshots are quarantined as personal with
-- no owner, so they cannot silently become tenant-shared.
-- Migration 004 deliberately rejects UPDATEs. Disable only the two named
-- UPDATE triggers inside the migrator-owned transaction; SAVEPOINT makes a
-- transaction mandatory and a failed backfill rolls the trigger state back.
SAVEPOINT rembr_snapshot_audience_backfill;
DO $snapshot_backfill_disable$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'context_snapshots'::regclass AND tgname = 'immutable_context_snapshots') THEN
    ALTER TABLE context_snapshots DISABLE TRIGGER immutable_context_snapshots;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'snapshot_memories'::regclass AND tgname = 'immutable_snapshot_memories_update') THEN
    ALTER TABLE snapshot_memories DISABLE TRIGGER immutable_snapshot_memories_update;
  END IF;
END
$snapshot_backfill_disable$;

UPDATE snapshot_memories sm
SET user_id = m.user_id,
    visibility = COALESCE(m.visibility, 'shared'),
    project_id = m.project_id
FROM memories m, context_snapshots cs
WHERE sm.memory_id = m.id
  AND sm.snapshot_id = cs.id
  AND m.tenant_id = cs.tenant_id
  AND sm.audience_version IS NULL;
UPDATE snapshot_memories
SET visibility = 'personal',
    user_id = '00000000-0000-0000-0000-000000000000'::uuid,
    project_id = NULL
WHERE audience_version IS NULL
  AND (
    visibility IS NULL
    OR visibility NOT IN ('personal', 'project', 'shared')
    OR (visibility = 'personal' AND user_id IS NULL)
    OR (visibility = 'project' AND project_id IS NULL)
  );
UPDATE snapshot_memories
SET audience_version = 1
WHERE audience_version IS NULL;

WITH audience AS (
  SELECT cs.id,
         COUNT(sm.id) AS copy_count,
         BOOL_OR(sm.visibility = 'personal') AS has_personal,
         BOOL_OR(sm.visibility = 'project') AS has_project,
         BOOL_OR(sm.project_id IS NULL) AS has_unbound,
         COUNT(DISTINCT sm.project_id) AS project_count,
         MIN(sm.project_id::text)::uuid AS source_project,
         COUNT(DISTINCT sm.user_id) FILTER (WHERE sm.visibility = 'personal') AS personal_users,
         MIN(sm.user_id::text) FILTER (WHERE sm.visibility = 'personal')::uuid AS personal_user
  FROM context_snapshots cs
  LEFT JOIN snapshot_memories sm ON sm.snapshot_id = cs.id
  WHERE cs.audience_version IS NULL
  GROUP BY cs.id
)
UPDATE context_snapshots cs
SET visibility = CASE
      WHEN a.copy_count = 0 THEN 'personal'
      WHEN a.project_count > 1 OR (a.project_count > 0 AND a.has_unbound) THEN 'personal'
      WHEN a.has_personal THEN 'personal'
      WHEN a.has_project THEN 'project'
      ELSE 'shared'
    END,
    user_id = CASE
      WHEN a.has_personal AND a.personal_users = 1 THEN a.personal_user
      ELSE '00000000-0000-0000-0000-000000000000'::uuid
    END,
    project_id = CASE
      WHEN a.project_count = 1 AND NOT a.has_unbound THEN a.source_project
      WHEN a.project_count = 0 THEN NULL
      ELSE NULL
    END
FROM audience a
WHERE cs.id = a.id;
-- Personal snapshots without one attributable owner, and project snapshots
-- without a bound project, remain intentionally inaccessible.
UPDATE context_snapshots
SET user_id = '00000000-0000-0000-0000-000000000000'::uuid
WHERE audience_version IS NULL
  AND visibility = 'personal'
  AND user_id IS NULL;
UPDATE context_snapshots
SET visibility = 'personal',
    user_id = '00000000-0000-0000-0000-000000000000'::uuid,
    project_id = NULL
WHERE audience_version IS NULL
  AND visibility = 'project'
  AND project_id IS NULL;
UPDATE context_snapshots
SET audience_version = 1
WHERE audience_version IS NULL;

DO $snapshot_backfill_enable$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'context_snapshots'::regclass AND tgname = 'immutable_context_snapshots') THEN
    ALTER TABLE context_snapshots ENABLE TRIGGER immutable_context_snapshots;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'snapshot_memories'::regclass AND tgname = 'immutable_snapshot_memories_update') THEN
    ALTER TABLE snapshot_memories ENABLE TRIGGER immutable_snapshot_memories_update;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid IN ('context_snapshots'::regclass, 'snapshot_memories'::regclass)
      AND tgname IN ('immutable_context_snapshots', 'immutable_snapshot_memories_update')
      AND tgenabled <> 'O'
  ) THEN
    RAISE EXCEPTION 'snapshot immutability update triggers were not restored';
  END IF;
END
$snapshot_backfill_enable$;
RELEASE SAVEPOINT rembr_snapshot_audience_backfill;

ALTER TABLE context_snapshots ALTER COLUMN visibility SET DEFAULT 'shared';
ALTER TABLE context_snapshots ALTER COLUMN visibility SET NOT NULL;
ALTER TABLE context_snapshots ALTER COLUMN audience_version SET DEFAULT 1;
ALTER TABLE context_snapshots ALTER COLUMN audience_version SET NOT NULL;
ALTER TABLE snapshot_memories ALTER COLUMN visibility SET DEFAULT 'shared';
ALTER TABLE snapshot_memories ALTER COLUMN visibility SET NOT NULL;
ALTER TABLE snapshot_memories ALTER COLUMN audience_version SET DEFAULT 1;
ALTER TABLE snapshot_memories ALTER COLUMN audience_version SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_snapshots_visibility_check'
  ) THEN
    ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_visibility_check
      CHECK (visibility IN ('personal', 'shared', 'project'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_memories_visibility_check'
  ) THEN
    ALTER TABLE snapshot_memories ADD CONSTRAINT snapshot_memories_visibility_check
      CHECK (visibility IN ('personal', 'shared', 'project'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_snapshots_project_visibility_check'
  ) THEN
    ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_project_visibility_check
      CHECK (visibility <> 'project' OR project_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_memories_project_visibility_check'
  ) THEN
    ALTER TABLE snapshot_memories ADD CONSTRAINT snapshot_memories_project_visibility_check
      CHECK (visibility <> 'project' OR project_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_snapshots_personal_owner_check'
  ) THEN
    ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_personal_owner_check
      CHECK (visibility <> 'personal' OR user_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_memories_personal_owner_check'
  ) THEN
    ALTER TABLE snapshot_memories ADD CONSTRAINT snapshot_memories_personal_owner_check
      CHECK (visibility <> 'personal' OR user_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'context_snapshots_audience_version_check'
  ) THEN
    ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_audience_version_check
      CHECK (audience_version >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'snapshot_memories_audience_version_check'
  ) THEN
    ALTER TABLE snapshot_memories ADD CONSTRAINT snapshot_memories_audience_version_check
      CHECK (audience_version >= 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_context_snapshots_tenant_visibility
  ON context_snapshots (tenant_id, visibility, user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_memories_visibility
  ON snapshot_memories (snapshot_id, visibility, user_id, project_id);

-- Keep the database owner/migration identity separate from the application
-- identity. Existing production rembr_app roles are left unchanged.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rembr_app') THEN
    CREATE ROLE rembr_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- Authentication happens before a tenant GUC can be set. These two functions
-- expose only the fields needed to verify one credential and current principal
-- state. They are owned by the migration role and are not callable by PUBLIC.
CREATE OR REPLACE FUNCTION rembr_lookup_api_key(p_key_prefix TEXT)
RETURNS TABLE (
  id UUID,
  key_hash VARCHAR,
  hash_algorithm VARCHAR,
  tenant_id UUID,
  project_id UUID,
  user_id UUID,
  expires_at TIMESTAMPTZ,
  purpose VARCHAR,
  capabilities TEXT[],
  tenant_status VARCHAR,
  user_status VARCHAR,
  auth_version INTEGER
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT k.id, k.key_hash, COALESCE(k.hash_algorithm, 'sha256'),
         k.tenant_id, k.project_id, k.user_id, k.expires_at,
         k.purpose, k.capabilities, t.status,
         u.status, COALESCE(u.auth_version, 0)
  FROM public.api_keys k
  JOIN public.tenants t ON t.id = k.tenant_id
  LEFT JOIN public.users u ON u.id = k.user_id AND u.tenant_id = k.tenant_id
  WHERE k.key_prefix = p_key_prefix AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)
    AND (
      k.project_id IS NULL OR EXISTS (
        SELECT 1 FROM public.projects p
        WHERE p.id = k.project_id AND p.tenant_id = k.tenant_id
          AND (
            p.is_personal = FALSE OR p.owner_id = k.user_id OR EXISTS (
              SELECT 1 FROM public.project_members pm
              WHERE pm.project_id = p.id AND pm.user_id = k.user_id
            )
          )
      )
    )
  LIMIT 2
$$;

DROP FUNCTION IF EXISTS rembr_lookup_oauth_token(TEXT);
CREATE FUNCTION rembr_lookup_oauth_token(p_access_token_hash TEXT)
RETURNS TABLE (
  tenant_id UUID,
  project_id UUID,
  user_id UUID,
  client_id VARCHAR,
  scope TEXT,
  expires_at TIMESTAMPTZ,
  issuer TEXT,
  audience TEXT,
  resource VARCHAR,
  revoked_at TIMESTAMPTZ,
  tenant_status VARCHAR,
  user_status VARCHAR,
  auth_version INTEGER
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT ot.tenant_id, ot.project_id, ot.user_id, ot.client_id, ot.scope, ot.expires_at,
         ot.issuer, ot.audience, ot.resource, ot.revoked_at, t.status,
         u.status, COALESCE(u.auth_version, 0)
  FROM public.oauth_tokens ot
  JOIN public.tenants t ON t.id = ot.tenant_id
  JOIN public.users u ON u.id = ot.user_id AND u.tenant_id = ot.tenant_id
  WHERE ot.access_token = p_access_token_hash
    AND (
      ot.project_id IS NULL OR EXISTS (
        SELECT 1 FROM public.projects p
        WHERE p.id = ot.project_id AND p.tenant_id = ot.tenant_id
          AND (p.is_personal = FALSE OR p.owner_id = ot.user_id OR EXISTS (
            SELECT 1 FROM public.project_members pm
            WHERE pm.project_id = p.id AND pm.user_id = ot.user_id
          ))
      )
    )
  LIMIT 1
$$;

-- PostgreSQL grants function EXECUTE to PUBLIC by default, and older
-- self-hosting bootstrap scripts also granted every public function to the app
-- role. Revoke all project-defined functions first; extension functions (for
-- example pgvector's operator support) are deliberately outside this name list.
DO $function_privileges$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'update_updated_at_column',
        'hybrid_search',
        'prevent_snapshot_modification',
        'prevent_snapshot_memory_deletion',
        'set_audit_entry_hash',
        'prevent_audit_modification',
        'update_storage_usage_on_insert',
        'update_storage_usage_on_delete',
        'mark_stale_embeddings',
        'clear_stale_flag',
        'trg_audit_stripe_customer_id_plaintext',
        'check_stripe_customer_id_encryption',
        'update_context_sessions_updated_at',
        'update_context_budgets_updated_at',
        'update_tasks_updated_at',
        'clean_old_vector_search_stats',
        'update_security_events_updated_at',
        'update_acceptance_criteria_updated_at',
        'update_engagement_events_updated_at',
        'search_memories_at_time',
        'update_memory_maintenance_updated_at',
        'rembr_lookup_api_key',
        'rembr_lookup_oauth_token'
      ]::name[])
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC', fn.signature);
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM rembr_app', fn.signature);
  END LOOP;
END
$function_privileges$;

GRANT EXECUTE ON FUNCTION rembr_lookup_api_key(TEXT) TO rembr_app;
GRANT EXECUTE ON FUNCTION rembr_lookup_oauth_token(TEXT) TO rembr_app;
GRANT USAGE ON SCHEMA public TO rembr_app;

-- The production UI and MCP currently share rembr_app. Prisma UI queries do
-- not consistently set app.current_tenant, so GUC-based RLS on shared tables
-- breaks signup, login, OAuth, billing and dashboard access. Both applications
-- must use explicit tenant/project/user predicates on this interim boundary.
-- A future migration may re-enable RLS after the UI receives a dedicated role
-- or every shared query is transaction-scoped with app.current_tenant.
--
-- Fresh-install bootstrap 04 enables policies on many of these tables while a
-- production upgrade historically enabled only memories. Normalise both paths
-- to the same final state and remove stale policies so permissive policy
-- composition cannot accidentally broaden a later rollout.
DO $shared_rls$
DECLARE
  shared_table TEXT;
  stale_policy RECORD;
  shared_tables CONSTANT TEXT[] := ARRAY[
    'tenants',
    'users',
    'accounts',
    'sessions',
    'verification_tokens',
    'projects',
    'project_members',
    'invitations',
    'workspaces',
    'api_keys',
    'oauth_apps',
    'oauth_tokens',
    'authorization_codes',
    'memory_embeddings',
    'contexts',
    'memory_contexts',
    'context_summaries',
    'context_snapshots',
    'snapshot_memories',
    'snapshot_contexts',
    'memory_relationships',
    'compiled_insights',
    'memory_tags',
    'usage_daily',
    'tenant_plans',
    'tenant_plan_limits',
    'stripe_events',
    'mcp_sessions',
    'audit_logs',
    'email_sends',
    'agent_signup_rate_limits',
    'saved_searches',
    'audit_alerts',
    'embedding_spaces',
    'gdpr_deletion_requests',
    'gdpr_consent_events'
  ];
BEGIN
  FOREACH shared_table IN ARRAY shared_tables LOOP
    IF to_regclass(format('public.%I', shared_table)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', shared_table);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', shared_table);

    FOR stale_policy IN
      SELECT pol.polname
      FROM pg_policy pol
      JOIN pg_class rel ON rel.oid = pol.polrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public' AND rel.relname = shared_table
    LOOP
      EXECUTE format(
        'DROP POLICY IF EXISTS %I ON public.%I',
        stale_policy.polname,
        shared_table
      );
    END LOOP;
  END LOOP;
END
$shared_rls$;

-- Policy names changed across historical UI and MCP migrations. Drop every
-- policy on the tables whose final RLS contract is reviewed below; retaining
-- even one arbitrarily named permissive policy could broaden the union of
-- otherwise-correct policies.
DO $drop_reviewed_policies$
DECLARE
  reviewed_table TEXT;
  existing_policy RECORD;
  reviewed_tables CONSTANT TEXT[] := ARRAY[
    'memories',
    'tasks',
    'task_dependencies',
    'task_state_transitions',
    'task_assignments',
    'task_handoffs'
  ];
BEGIN
  FOREACH reviewed_table IN ARRAY reviewed_tables LOOP
    IF to_regclass(format('public.%I', reviewed_table)) IS NULL THEN
      CONTINUE;
    END IF;
    FOR existing_policy IN
      SELECT policy.policyname
      FROM pg_policies policy
      WHERE policy.schemaname = 'public' AND policy.tablename = reviewed_table
    LOOP
      EXECUTE format(
        'DROP POLICY %I ON public.%I',
        existing_policy.policyname,
        reviewed_table
      );
    END LOOP;
  END LOOP;
END
$drop_reviewed_policies$;

-- UI and MCP memory operations have been audited to establish the tenant GUC
-- inside a transaction. Preserve the existing production boundary and ensure
-- fresh installations receive equivalent per-command policies. User, project,
-- and personal visibility still require the explicit predicates in each app.
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY security_030_memories_select ON memories FOR SELECT
  USING (tenant_id::text = NULLIF(current_setting('app.current_tenant', TRUE), ''));

CREATE POLICY security_030_memories_insert ON memories FOR INSERT
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', TRUE), ''));

CREATE POLICY security_030_memories_update ON memories FOR UPDATE
  USING (tenant_id::text = NULLIF(current_setting('app.current_tenant', TRUE), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', TRUE), ''));

CREATE POLICY security_030_memories_delete ON memories FOR DELETE
  USING (tenant_id::text = NULLIF(current_setting('app.current_tenant', TRUE), ''));

ALTER TABLE memories FORCE ROW LEVEL SECURITY;

-- Task tooling is release-disabled pending schema reconciliation, but fresh
-- installs may still contain its tables and policies from migration 012.
-- Preserve the defence-in-depth RLS boundary while converging the old
-- app.current_tenant_id spelling on the one runtime GUC contract.
DO $task_rls_normalisation$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('tasks', 'tasks_tenant_isolation'),
      ('task_dependencies', 'task_dependencies_tenant_isolation'),
      ('task_state_transitions', 'task_state_transitions_tenant_isolation'),
      ('task_assignments', 'task_assignments_tenant_isolation'),
      ('task_handoffs', 'task_handoffs_tenant_isolation')
    ) AS policies(table_name, policy_name)
  LOOP
    IF to_regclass(format('public.%I', target.table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL '
      || 'USING (tenant_id::text = NULLIF(current_setting(''app.current_tenant'', TRUE), '''')) '
      || 'WITH CHECK (tenant_id::text = NULLIF(current_setting(''app.current_tenant'', TRUE), ''''))',
      target.policy_name,
      target.table_name
    );
  END LOOP;
END
$task_rls_normalisation$;

-- RLM tables are MCP-exclusive and every runtime query establishes the GUC in
-- a transaction, so they can safely enforce and force tenant RLS now.
ALTER TABLE rlm_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rlm_iterations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS security_030_rlm_sessions_tenant ON rlm_sessions;
CREATE POLICY security_030_rlm_sessions_tenant ON rlm_sessions FOR ALL
  USING (tenant_id::text = NULLIF(current_setting('app.current_tenant', TRUE), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', TRUE), ''));

DROP POLICY IF EXISTS security_030_rlm_iterations_tenant ON rlm_iterations;
CREATE POLICY security_030_rlm_iterations_tenant ON rlm_iterations FOR ALL
  USING (tenant_id::text = NULLIF(current_setting('app.current_tenant', TRUE), ''))
  WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant', TRUE), ''));

-- FORCE is also retained on memories after the audited UI transaction change.
ALTER TABLE rlm_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE rlm_iterations FORCE ROW LEVEL SECURITY;

-- Migration-time assertions make fresh and upgrade installs converge on the
-- reviewed boundary. Missing optional shared tables are ignored; every table
-- that exists must have the declared final state.
DO $rls_assertions$
DECLARE
  shared_table TEXT;
  shared_tables CONSTANT TEXT[] := ARRAY[
    'tenants', 'users', 'accounts', 'sessions', 'verification_tokens',
    'projects', 'project_members', 'invitations', 'workspaces', 'api_keys',
    'oauth_apps', 'oauth_tokens', 'authorization_codes', 'memory_embeddings',
    'contexts', 'memory_contexts', 'context_summaries', 'context_snapshots',
    'snapshot_memories', 'snapshot_contexts', 'memory_relationships',
    'compiled_insights', 'memory_tags', 'usage_daily', 'tenant_plans',
    'tenant_plan_limits', 'stripe_events', 'mcp_sessions', 'audit_logs',
    'email_sends', 'agent_signup_rate_limits', 'saved_searches', 'audit_alerts',
    'embedding_spaces', 'gdpr_deletion_requests', 'gdpr_consent_events'
  ];
  boundary RECORD;
BEGIN
  FOREACH shared_table IN ARRAY shared_tables LOOP
    SELECT relrowsecurity, relforcerowsecurity
    INTO boundary
    FROM pg_class rel
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = shared_table;

    IF FOUND AND (boundary.relrowsecurity OR boundary.relforcerowsecurity) THEN
      RAISE EXCEPTION 'shared table % retained an unsafe RLS state', shared_table;
    END IF;
  END LOOP;

  FOR boundary IN
    SELECT rel.relname, rel.relrowsecurity, rel.relforcerowsecurity
    FROM pg_class rel
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = ANY (ARRAY[
        'memories', 'rlm_sessions', 'rlm_iterations',
        'causal_relationships', 'temporal_snapshots'
      ])
  LOOP
    IF NOT boundary.relrowsecurity OR NOT boundary.relforcerowsecurity THEN
      RAISE EXCEPTION 'tenant table % must enforce FORCE RLS', boundary.relname;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND (
        COALESCE(policy.qual, '') LIKE '%app.current_tenant_id%'
        OR COALESCE(policy.with_check, '') LIKE '%app.current_tenant_id%'
      )
  ) THEN
    RAISE EXCEPTION 'public RLS policies retained the stale app.current_tenant_id GUC';
  END IF;
END
$rls_assertions$;

-- Validate the exact reviewed policy catalogue. PostgreSQL combines
-- permissive policies with OR, so names/counts are security properties as
-- well as documentation. Normalising the deparsed expression makes the check
-- stable across harmless whitespace/parenthesis differences.
DO $reviewed_policy_assertions$
DECLARE
  canonical_predicate CONSTANT TEXT :=
    'tenant_id::text=NULLIFcurrent_setting''app.current_tenant''::text,true,''''::text';
  actual_memory_policies TEXT[];
  policy RECORD;
  target RECORD;
  policy_count INTEGER;
  normalised_qual TEXT;
  normalised_check TEXT;
BEGIN
  SELECT array_agg(p.policyname::text ORDER BY p.policyname::text)
  INTO actual_memory_policies
  FROM pg_policies p
  WHERE p.schemaname = 'public' AND p.tablename = 'memories';

  IF actual_memory_policies IS DISTINCT FROM ARRAY[
    'security_030_memories_delete',
    'security_030_memories_insert',
    'security_030_memories_select',
    'security_030_memories_update'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'memories policy catalogue does not match the reviewed four-policy boundary: %',
      actual_memory_policies;
  END IF;

  FOR policy IN
    SELECT p.* FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = 'memories'
  LOOP
    IF policy.roles IS DISTINCT FROM ARRAY['public']::name[] THEN
      RAISE EXCEPTION 'memory policy % has unexpected roles %', policy.policyname, policy.roles;
    END IF;
    normalised_qual := regexp_replace(COALESCE(policy.qual, ''), '[()[:space:]]+', '', 'g');
    normalised_check := regexp_replace(COALESCE(policy.with_check, ''), '[()[:space:]]+', '', 'g');

    IF policy.policyname = 'security_030_memories_select'
       AND (policy.cmd <> 'SELECT' OR normalised_qual <> canonical_predicate OR normalised_check <> '') THEN
      RAISE EXCEPTION 'memory SELECT policy definition is not canonical';
    ELSIF policy.policyname = 'security_030_memories_insert'
       AND (policy.cmd <> 'INSERT' OR normalised_qual <> '' OR normalised_check <> canonical_predicate) THEN
      RAISE EXCEPTION 'memory INSERT policy definition is not canonical';
    ELSIF policy.policyname = 'security_030_memories_update'
       AND (policy.cmd <> 'UPDATE' OR normalised_qual <> canonical_predicate OR normalised_check <> canonical_predicate) THEN
      RAISE EXCEPTION 'memory UPDATE policy definition is not canonical';
    ELSIF policy.policyname = 'security_030_memories_delete'
       AND (policy.cmd <> 'DELETE' OR normalised_qual <> canonical_predicate OR normalised_check <> '') THEN
      RAISE EXCEPTION 'memory DELETE policy definition is not canonical';
    END IF;
  END LOOP;

  FOR target IN
    SELECT * FROM (VALUES
      ('tasks', 'tasks_tenant_isolation'),
      ('task_dependencies', 'task_dependencies_tenant_isolation'),
      ('task_state_transitions', 'task_state_transitions_tenant_isolation'),
      ('task_assignments', 'task_assignments_tenant_isolation'),
      ('task_handoffs', 'task_handoffs_tenant_isolation')
    ) AS policies(table_name, policy_name)
  LOOP
    IF to_regclass(format('public.%I', target.table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO policy_count
    FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = target.table_name;
    IF policy_count <> 1 THEN
      RAISE EXCEPTION 'task table % has % policies instead of exactly one', target.table_name, policy_count;
    END IF;

    SELECT p.* INTO policy
    FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = target.table_name;
    normalised_qual := regexp_replace(COALESCE(policy.qual, ''), '[()[:space:]]+', '', 'g');
    normalised_check := regexp_replace(COALESCE(policy.with_check, ''), '[()[:space:]]+', '', 'g');
    IF policy.policyname <> target.policy_name
       OR policy.cmd <> 'ALL'
       OR policy.roles IS DISTINCT FROM ARRAY['public']::name[]
       OR normalised_qual <> canonical_predicate
       OR normalised_check <> canonical_predicate THEN
      RAISE EXCEPTION 'task policy on % does not match the canonical reviewed definition', target.table_name;
    END IF;
  END LOOP;
END
$reviewed_policy_assertions$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  projects, project_members, contexts, memory_contexts, context_summaries,
  context_snapshots, snapshot_memories, snapshot_contexts,
  rlm_sessions, rlm_iterations, audit_alerts, embedding_spaces, saved_searches
TO rembr_app;

-- Destructive GDPR runtime operations are release-gated. Keep their request
-- and consent ledgers owner-only until a subject-bound transactional workflow
-- is re-enabled; blanket bootstrap grants are corrected here.
REVOKE ALL PRIVILEGES ON TABLE gdpr_deletion_requests, gdpr_consent_events FROM PUBLIC, rembr_app;
DO $gdpr_privilege_assertion$
BEGIN
  IF has_table_privilege('rembr_app', 'public.gdpr_deletion_requests', 'SELECT')
     OR has_table_privilege('rembr_app', 'public.gdpr_deletion_requests', 'INSERT')
     OR has_table_privilege('rembr_app', 'public.gdpr_deletion_requests', 'UPDATE')
     OR has_table_privilege('rembr_app', 'public.gdpr_deletion_requests', 'DELETE')
     OR has_table_privilege('rembr_app', 'public.gdpr_consent_events', 'SELECT')
     OR has_table_privilege('rembr_app', 'public.gdpr_consent_events', 'INSERT')
     OR has_table_privilege('rembr_app', 'public.gdpr_consent_events', 'UPDATE')
     OR has_table_privilege('rembr_app', 'public.gdpr_consent_events', 'DELETE') THEN
    RAISE EXCEPTION 'release-gated GDPR tables must remain owner-only';
  END IF;
END
$gdpr_privilege_assertion$;

-- Attachment uploads reserve quota before the object-store side effect. Old
-- rows are already complete, so upgrades safely mark them ready. Usage rows
-- with no recorded override came from the historical 50 GiB default and are
-- converged to a plan-derived limit; explicit custom quotas are preserved.
ALTER TABLE memory_attachments
  ADD COLUMN IF NOT EXISTS upload_status VARCHAR(20) NOT NULL DEFAULT 'ready';
ALTER TABLE memory_attachments
  DROP CONSTRAINT IF EXISTS memory_attachments_upload_status_check;
ALTER TABLE memory_attachments
  ADD CONSTRAINT memory_attachments_upload_status_check
  CHECK (upload_status IN ('pending', 'ready'));

ALTER TABLE tenant_storage_usage
  ALTER COLUMN quota_bytes SET DEFAULT 104857600;
UPDATE tenant_storage_usage usage
SET quota_bytes = CASE LOWER(COALESCE(tenant.plan, 'free'))
      WHEN 'dev' THEN 104857600
      WHEN 'free' THEN 104857600
      WHEN 'pro' THEN 5368709120
      WHEN 'team' THEN 26843545600
      WHEN 'business' THEN 107374182400
      WHEN 'enterprise' THEN 536870912000
      ELSE 104857600
    END,
    metadata = COALESCE(usage.metadata, '{}'::jsonb) || '{"quota_source":"plan"}'::jsonb,
    updated_at = NOW()
FROM tenants tenant
WHERE tenant.id = usage.tenant_id
  AND COALESCE(usage.metadata->>'quota_source', 'plan') <> 'custom';

-- This is trigger-owned integrity state, never application-owned data. The
-- shared runtime role must not be able to replace a chain head and choose the
-- predecessor for its next audit entry, even if a bootstrap grant broadly
-- grants CRUD on public tables before this migration runs.
REVOKE ALL PRIVILEGES ON TABLE audit_chain_heads FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE audit_chain_heads FROM rembr_app;

DO $audit_chain_privilege_assertion$
BEGIN
  IF has_table_privilege('rembr_app', 'public.audit_chain_heads', 'SELECT')
     OR has_table_privilege('rembr_app', 'public.audit_chain_heads', 'INSERT')
     OR has_table_privilege('rembr_app', 'public.audit_chain_heads', 'UPDATE')
     OR has_table_privilege('rembr_app', 'public.audit_chain_heads', 'DELETE') THEN
    RAISE EXCEPTION 'rembr_app must not have direct audit_chain_heads privileges';
  END IF;
END
$audit_chain_privilege_assertion$;
