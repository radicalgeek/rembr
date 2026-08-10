import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./migrations/${name}`, import.meta.url)), 'utf8');
}

function migrationRunner(): string {
  return readFileSync(
    fileURLToPath(new URL('../scripts/apply-security-migration.mjs', import.meta.url)),
    'utf8',
  );
}

function quotedValues(source: string): string[] {
  return [...source.matchAll(/'([^']+)'/g)].map(match => match[1]);
}

describe('security migration convergence', () => {
  it('uses one OAuth scope catalogue for MCP-first and UI-first ordering', () => {
    const sql = migration('030-security-boundaries.sql');
    const add = sql.match(/ADD COLUMN IF NOT EXISTS allowed_scopes[\s\S]*?DEFAULT ARRAY\[([\s\S]*?)\]::TEXT\[\]/)?.[1];
    const alter = sql.match(/ALTER COLUMN allowed_scopes SET DEFAULT ARRAY\[([\s\S]*?)\]::TEXT\[\]/)?.[1];
    const expected = [
      'openid', 'profile', 'email', 'mcp:read', 'mcp:write', 'mcp:full',
      'read:memories', 'write:memories',
    ];
    expect(add).toBeDefined();
    expect(alter).toBeDefined();
    expect(quotedValues(add!)).toEqual(expected);
    expect(quotedValues(alter!)).toEqual(expected);
  });

  it('invalidates legacy OAuth grants and returns the exact resource binding from the privileged lookup', () => {
    const sql = migration('030-security-boundaries.sql');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS resource VARCHAR(255)');
    expect(sql).toContain("resource = 'urn:rembr:reauthorization-required'");
    expect(sql).toContain('revoked_at = COALESCE(revoked_at, NOW())');
    expect(sql).toContain('CHECK (resource = audience)');
    expect(sql).toContain('ALTER COLUMN resource SET NOT NULL');
    expect(sql).toContain('DROP FUNCTION IF EXISTS rembr_lookup_oauth_token(TEXT)');
    expect(sql).toMatch(/RETURNS TABLE \([\s\S]*?audience TEXT,[\s\S]*?resource VARCHAR,/);
    expect(sql).toContain('ot.issuer, ot.audience, ot.resource, ot.revoked_at');
    expect(sql).toContain('token_endpoint_auth_method VARCHAR(32) NOT NULL');
  });

  it('filters expired API keys before the bounded authentication lookup', () => {
    const sql = migration('030-security-boundaries.sql');
    const lookup = sql.match(
      /CREATE OR REPLACE FUNCTION rembr_lookup_api_key\(p_key_prefix TEXT\)([\s\S]*?)DROP FUNCTION IF EXISTS rembr_lookup_oauth_token/,
    )?.[1];
    expect(lookup).toBeDefined();
    expect(lookup).toContain('k.revoked_at IS NULL');
    expect(lookup).toContain('k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP');
    expect(lookup!.indexOf('k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP'))
      .toBeLessThan(lookup!.indexOf('LIMIT 2'));
  });

  it('serialises each tenant audit chain and does not use global sequence gaps', () => {
    const sql = migration('006-audit-tamper-resistance.sql');
    expect(sql).toContain('tenant_seq_num BIGINT');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain("COALESCE(NEW.tenant_id::text, '__system__')");
    expect(sql).toContain('audit_chain_heads');
    expect(sql).toContain('NEW.tenant_seq_num::text');
    expect(sql).toContain("ORDER BY COALESCE(tenant_id::text, '__system__'), seq_num ASC NULLS LAST, id ASC");
    const boundary = migration('030-security-boundaries.sql');
    expect(boundary).toContain('REVOKE ALL PRIVILEGES ON TABLE audit_chain_heads FROM rembr_app');
    expect(boundary).toContain("has_table_privilege('rembr_app', 'public.audit_chain_heads', 'UPDATE')");
  });

  it('marks snapshot audience exactly once', () => {
    const sql = migration('030-security-boundaries.sql');
    expect(sql).toContain('audience_version SMALLINT');
    expect(sql).toMatch(/UPDATE snapshot_memories[\s\S]*?WHERE audience_version IS NULL/);
    expect(sql).toMatch(/UPDATE context_snapshots[\s\S]*?WHERE audience_version IS NULL/);
  });

  it('normalises surviving task policies and rejects every stale tenant GUC in pg_policies', () => {
    const sql = migration('030-security-boundaries.sql');
    for (const policy of [
      'tasks_tenant_isolation',
      'task_dependencies_tenant_isolation',
      'task_state_transitions_tenant_isolation',
      'task_assignments_tenant_isolation',
      'task_handoffs_tenant_isolation',
    ]) {
      expect(sql).toContain(`'${policy}'`);
    }
    expect(sql).toContain("current_setting(''app.current_tenant'', TRUE)");
    expect(sql).toContain('FROM pg_policies policy');
    expect(sql).toContain("COALESCE(policy.qual, '') LIKE '%app.current_tenant_id%'");
    expect(sql).toContain("COALESCE(policy.with_check, '') LIKE '%app.current_tenant_id%'");
    expect(sql).toContain("RAISE EXCEPTION 'public RLS policies retained the stale app.current_tenant_id GUC'");
  });

  it('drops every historical reviewed-table policy before recreating one exact catalogue', () => {
    const sql = migration('030-security-boundaries.sql');
    const dropBlock = sql.match(/DO \$drop_reviewed_policies\$[\s\S]*?\$drop_reviewed_policies\$;/)?.[0];
    expect(dropBlock).toBeDefined();
    for (const table of [
      'memories', 'tasks', 'task_dependencies', 'task_state_transitions',
      'task_assignments', 'task_handoffs',
    ]) {
      expect(dropBlock).toContain(`'${table}'`);
    }
    expect(dropBlock).toContain('FROM pg_policies policy');
    expect(dropBlock).toContain("'DROP POLICY %I ON public.%I'");
    expect(sql).not.toContain('CREATE POLICY task_tenant_isolation ON tasks');

    const exactBlock = sql.match(/DO \$reviewed_policy_assertions\$[\s\S]*?\$reviewed_policy_assertions\$;/)?.[0];
    expect(exactBlock).toBeDefined();
    expect(exactBlock).toContain('security_030_memories_select');
    expect(exactBlock).toContain('security_030_memories_insert');
    expect(exactBlock).toContain('security_030_memories_update');
    expect(exactBlock).toContain('security_030_memories_delete');
    expect(exactBlock).toContain("policy.roles IS DISTINCT FROM ARRAY['public']::name[]");
    expect(exactBlock).toContain("policy.cmd <> 'ALL'");
    expect(exactBlock).toContain('policy_count <> 1');
    expect(exactBlock).toContain('actual_memory_policies IS DISTINCT FROM ARRAY[');
  });

  it('preserves the reviewed legacy tenant plan catalogue and migrates only the per-tenant lineage', () => {
    const sql = migration('015-tenant-plan-limits.sql');
    const legacyBranch = sql.match(/IF NOT has_tenant_id THEN([\s\S]*?)RETURN;/)?.[1];
    expect(legacyBranch).toBeDefined();
    for (const column of [
      'memory_limit', 'search_limit_daily', 'project_limit',
      'api_rate_limit', 'max_users', 'features',
    ]) {
      expect(legacyBranch).toContain(`'${column}'`);
    }
    expect(legacyBranch).toContain('unsupported lineage');
    expect(legacyBranch).toContain('legacy_column_count <> 9');
    expect(legacyBranch).toContain("constraint_row.conname = 'tenant_plan_limits_pkey'");
    expect(legacyBranch).toContain("constraint_row.conname = 'valid_plan'");
    expect(legacyBranch).not.toContain('ALTER TABLE');
    expect(legacyBranch).not.toContain('CREATE INDEX');
    expect(legacyBranch).not.toContain('INSERT INTO public.tenant_plan_limits');
    expect(sql).toContain('CREATE TABLE public.tenant_plan_limits');
    expect(sql).toContain('ON CONFLICT (tenant_id) DO NOTHING');
    expect(sql).toContain("constraint_row.conname <> 'tenant_plans_plan_check'");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS tenant_plans_plan_check");
    expect(sql).toContain('ADD CONSTRAINT tenant_plans_plan_check');
    expect(sql).toContain(
      "CHECK (plan IN ('dev', 'free', 'pro', 'team', 'business', 'enterprise'))",
    );
  });

  it('backfills embedding fingerprints without an implicit pgcrypto dependency', () => {
    const sql = migration('007-embedding-model-consistency.sql');
    expect(sql).toContain('pg_catalog.sha256(pg_catalog.convert_to(');
    expect(sql).not.toMatch(/\bdigest\s*\(/i);
  });

  it('sets vector defaults on the connected database without a hard-coded name', () => {
    const sql = migration('006-vector-index-tuning.sql');
    expect(sql).toContain("'ALTER DATABASE %I SET hnsw.ef_search = 64'");
    expect(sql).toContain('pg_catalog.current_database()');
    expect(sql).not.toMatch(/ALTER DATABASE\s+rembr\s+SET/i);
  });

  it('applies every prerequisite, migration 030 and its grants in one transaction', () => {
    const runner = migrationRunner();
    const connected = runner.indexOf('await client.connect()');
    const began = runner.indexOf("await client.query('BEGIN')", connected);
    const loop = runner.indexOf('for (const filename of prerequisiteMigrations)', began);
    const boundary = runner.indexOf('await client.query(sql)', loop);
    const verification = runner.indexOf('const verification = await client.query', boundary);
    const committed = runner.indexOf("await client.query('COMMIT')", verification);
    expect(connected).toBeGreaterThan(-1);
    expect(began).toBeGreaterThan(connected);
    expect(loop).toBeGreaterThan(began);
    expect(boundary).toBeGreaterThan(loop);
    expect(verification).toBeGreaterThan(boundary);
    expect(committed).toBeGreaterThan(verification);
    expect(runner.slice(loop, boundary)).not.toContain("client.query('BEGIN')");
    expect(runner.slice(loop, boundary)).not.toContain("client.query('COMMIT')");
    expect(runner).toContain("SET LOCAL lock_timeout = '30s'");
    expect(runner).toContain("SET LOCAL statement_timeout = '15min'");
    expect(runner).toContain("await client.query('ROLLBACK')");
  });
});
