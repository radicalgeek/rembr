REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE rembr TO rembr_app;
GRANT USAGE ON SCHEMA public TO rembr_app;

-- The schema includes authentication, agent-signup, OAuth, plan and tenant
-- workflows alongside the MCP tables. Grant the complete application surface
-- to the non-owner runtime role; application queries enforce their explicit
-- user, tenant and project predicates.
DO $grants$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE '
      || target.qualified_name || ' TO rembr_app';
  END LOOP;
END
$grants$;

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO rembr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, rembr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, rembr_app;

-- Trigger-owned integrity state is never part of the shared UI/MCP table
-- surface. set_audit_entry_hash() is SECURITY DEFINER and advances it without
-- granting the runtime role a way to forge a predecessor or sequence number.
-- The Prisma ledger and security cutover marker are also migration-owner state.
-- Future objects remain private until their migration grants an audited runtime
-- privilege explicitly.
REVOKE ALL ON TABLE audit_chain_heads, gdpr_deletion_requests, gdpr_consent_events,
  rembr_security_migration_state
  FROM PUBLIC, rembr_app;
GRANT SELECT ON TABLE rembr_security_migration_state TO rembr_app;
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM PUBLIC, rembr_app;
GRANT SELECT, INSERT ON TABLE audit_logs TO rembr_app;

DO $private_prisma_ledger$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public._prisma_migrations FROM PUBLIC, rembr_app';
  END IF;
END
$private_prisma_ledger$;

-- New functions created by the database owner are private by default. Existing
-- SECURITY DEFINER functions are revoked dynamically before the audited lookup
-- allowlist is restored below. SECURITY INVOKER helpers keep PostgreSQL's normal
-- privileges and cannot elevate the caller.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

SELECT format(
  'REVOKE ALL ON FUNCTION %s FROM PUBLIC, rembr_app',
  p.oid::regprocedure
)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
\gexec

SELECT format(
  'REVOKE ALL ON FUNCTION %s FROM PUBLIC, rembr_app',
  p.oid::regprocedure
)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('search_memories_at_time', 'hybrid_search')
\gexec

GRANT EXECUTE ON FUNCTION rembr_lookup_api_key(TEXT) TO rembr_app;
GRANT EXECUTE ON FUNCTION rembr_lookup_oauth_token(TEXT) TO rembr_app;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'rembr_app'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'rembr_app has unsafe role attributes';
  END IF;
  IF has_schema_privilege('rembr_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'rembr_app can create objects in public';
  END IF;
  IF NOT (
    has_table_privilege('rembr_app', 'users', 'SELECT')
    AND has_table_privilege('rembr_app', 'accounts', 'INSERT')
    AND has_table_privilege('rembr_app', 'api_keys', 'SELECT')
    AND has_table_privilege('rembr_app', 'oauth_tokens', 'UPDATE')
    AND has_table_privilege('rembr_app', 'sessions', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'shared UI/MCP application table grants are incomplete';
  END IF;
  IF has_table_privilege('rembr_app', 'audit_chain_heads', 'SELECT')
     OR has_table_privilege('rembr_app', 'audit_chain_heads', 'INSERT')
     OR has_table_privilege('rembr_app', 'audit_chain_heads', 'UPDATE')
     OR has_table_privilege('rembr_app', 'audit_chain_heads', 'DELETE') THEN
    RAISE EXCEPTION 'rembr_app can modify audit chain control state';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY['gdpr_deletion_requests', 'gdpr_consent_events']) AS gated(table_name)
    WHERE has_table_privilege('rembr_app', gated.table_name, 'SELECT')
       OR has_table_privilege('rembr_app', gated.table_name, 'INSERT')
       OR has_table_privilege('rembr_app', gated.table_name, 'UPDATE')
       OR has_table_privilege('rembr_app', gated.table_name, 'DELETE')
  ) THEN
    RAISE EXCEPTION 'rembr_app can access a release-gated GDPR table';
  END IF;
  IF NOT has_table_privilege('rembr_app', 'rembr_security_migration_state', 'SELECT')
     OR has_table_privilege('rembr_app', 'rembr_security_migration_state', 'INSERT')
     OR has_table_privilege('rembr_app', 'rembr_security_migration_state', 'UPDATE')
     OR has_table_privilege('rembr_app', 'rembr_security_migration_state', 'DELETE') THEN
    RAISE EXCEPTION 'rembr_app security migration marker privileges are unsafe';
  END IF;
  IF COALESCE(has_table_privilege(
       'rembr_app', to_regclass('public._prisma_migrations'), 'SELECT'), false)
     OR COALESCE(has_table_privilege(
       'rembr_app', to_regclass('public._prisma_migrations'), 'INSERT'), false)
     OR COALESCE(has_table_privilege(
       'rembr_app', to_regclass('public._prisma_migrations'), 'UPDATE'), false)
     OR COALESCE(has_table_privilege(
       'rembr_app', to_regclass('public._prisma_migrations'), 'DELETE'), false) THEN
    RAISE EXCEPTION 'rembr_app can modify the Prisma migration ledger';
  END IF;
  IF NOT has_table_privilege('rembr_app', 'audit_logs', 'SELECT')
     OR NOT has_table_privilege('rembr_app', 'audit_logs', 'INSERT')
     OR has_table_privilege('rembr_app', 'audit_logs', 'UPDATE')
     OR has_table_privilege('rembr_app', 'audit_logs', 'DELETE') THEN
    RAISE EXCEPTION 'rembr_app audit log privileges are unsafe';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_default_acl defaults
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
    WHERE defaults.defaclnamespace = 'public'::regnamespace
      AND defaults.defaclobjtype IN ('r', 'S')
      AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'rembr_app')
  ) THEN
    RAISE EXCEPTION 'future tables or sequences grant rembr_app privileges by default';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC can execute a SECURITY DEFINER function';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'rembr_app')
      AND p.proname NOT IN ('rembr_lookup_api_key', 'rembr_lookup_oauth_token')
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'rembr_app can execute a non-allowlisted SECURITY DEFINER function';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE n.nspname = 'public'
      AND p.proname IN ('search_memories_at_time', 'hybrid_search')
      AND acl.grantee IN (
        0,
        (SELECT oid FROM pg_roles WHERE rolname = 'rembr_app')
      )
      AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'unsafe content-returning function remains executable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'memories' AND relrowsecurity AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'memories FORCE RLS boundary is missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relrowsecurity
      AND c.relname = ANY (ARRAY[
        'tenants', 'users', 'accounts', 'sessions', 'verification_tokens',
        'projects', 'project_members', 'api_keys', 'oauth_apps', 'oauth_tokens',
        'authorization_codes', 'memory_embeddings', 'contexts',
        'memory_contexts', 'context_summaries', 'context_snapshots',
        'snapshot_memories', 'snapshot_contexts', 'memory_relationships',
        'compiled_insights', 'memory_tags', 'tenant_plans', 'usage_daily',
        'stripe_events', 'invitations', 'email_sends',
        'agent_signup_rate_limits', 'feature_flags'
      ]::name[])
  ) THEN
    RAISE EXCEPTION 'a shared UI/MCP table still has GUC-based RLS enabled';
  END IF;
END
$verify$;
