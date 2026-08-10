-- Migration 015: per-tenant quota counters on installations that do not
-- already use the historical plan-catalogue form of tenant_plan_limits.
--
-- Two supported lineages exist:
--   * newer/fresh databases: tenant_plan_limits is absent, or has tenant_id;
--   * production legacy databases: tenant_plan_limits is a global plan
--     catalogue (plan, memory_limit, search_limit_daily, ...), while actual
--     tenant assignments live in tenant_plans.
--
-- CREATE TABLE IF NOT EXISTS is insufficient here: it silently accepts the
-- legacy name and the old migration then queries a nonexistent tenant_id.
-- Detect the lineage explicitly. The plan catalogue is security-relevant
-- billing state and must remain byte-for-byte unchanged during this cutover.

DO $rembr_tenant_plan_limits$
DECLARE
  has_tenant_id BOOLEAN;
  missing_modern_columns TEXT[];
  missing_legacy_columns TEXT[];
  legacy_column_count INTEGER;
  invalid_legacy_column_count INTEGER;
  legacy_primary_key_count INTEGER;
  legacy_plan_check_count INTEGER;
BEGIN
  IF to_regclass('public.tenant_plan_limits') IS NULL THEN
    CREATE TABLE public.tenant_plan_limits (
      id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id              UUID         NOT NULL UNIQUE
                                           REFERENCES public.tenants(id) ON DELETE CASCADE,
      plan                   TEXT         NOT NULL DEFAULT 'free'
                                           CHECK (plan IN (
                                             'dev', 'free', 'pro', 'team',
                                             'business', 'enterprise'
                                           )),
      max_memories           INTEGER      NOT NULL DEFAULT 1000,
      max_searches_per_day   INTEGER      NOT NULL DEFAULT 10000,
      max_projects           INTEGER      NOT NULL DEFAULT 5,
      max_api_keys           INTEGER      NOT NULL DEFAULT 3,
      searches_today         INTEGER      NOT NULL DEFAULT 0,
      searches_reset_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tenant_plan_limits'
      AND column_name = 'tenant_id'
  ) INTO has_tenant_id;

  IF NOT has_tenant_id THEN
    SELECT ARRAY_AGG(required.column_name ORDER BY required.column_name)
      INTO missing_legacy_columns
    FROM unnest(ARRAY[
      'plan', 'memory_limit', 'search_limit_daily', 'project_limit',
      'api_rate_limit', 'max_users', 'features', 'created_at', 'updated_at'
    ]::TEXT[]) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM information_schema.columns actual
      WHERE actual.table_schema = 'public'
        AND actual.table_name = 'tenant_plan_limits'
        AND actual.column_name = required.column_name
    );

    IF COALESCE(cardinality(missing_legacy_columns), 0) <> 0 THEN
      RAISE EXCEPTION
        'tenant_plan_limits has an unsupported lineage; missing reviewed legacy columns';
    END IF;

    SELECT
      COUNT(*),
      COUNT(*) FILTER (WHERE CASE column_name
        WHEN 'plan' THEN udt_name <> 'varchar'
          OR character_maximum_length IS DISTINCT FROM 50
          OR is_nullable <> 'NO'
        WHEN 'memory_limit' THEN udt_name <> 'int4' OR is_nullable <> 'NO'
        WHEN 'search_limit_daily' THEN udt_name <> 'int4' OR is_nullable <> 'NO'
        WHEN 'project_limit' THEN udt_name <> 'int4' OR is_nullable <> 'NO'
        WHEN 'api_rate_limit' THEN udt_name <> 'int4' OR is_nullable <> 'NO'
        WHEN 'max_users' THEN udt_name <> 'int4' OR is_nullable <> 'NO'
        WHEN 'features' THEN udt_name <> 'jsonb' OR is_nullable <> 'YES'
        WHEN 'created_at' THEN udt_name <> 'timestamptz' OR is_nullable <> 'NO'
        WHEN 'updated_at' THEN udt_name <> 'timestamptz' OR is_nullable <> 'NO'
        ELSE TRUE
      END)
      INTO legacy_column_count, invalid_legacy_column_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tenant_plan_limits';

    SELECT COUNT(*) INTO legacy_primary_key_count
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.tenant_plan_limits'::regclass
      AND constraint_row.conname = 'tenant_plan_limits_pkey'
      AND constraint_row.contype = 'p'
      AND pg_get_constraintdef(constraint_row.oid) = 'PRIMARY KEY (plan)';

    SELECT COUNT(*) INTO legacy_plan_check_count
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.tenant_plan_limits'::regclass
      AND constraint_row.conname = 'valid_plan'
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%''free''%'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%''pro''%'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%''team''%'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%''business''%'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%''enterprise''%';

    IF legacy_column_count <> 9 OR invalid_legacy_column_count <> 0
       OR legacy_primary_key_count <> 1 OR legacy_plan_check_count <> 1 THEN
      RAISE EXCEPTION
        'tenant_plan_limits does not match the reviewed legacy plan catalogue';
    END IF;

    RAISE NOTICE
      'Preserving reviewed legacy tenant_plan_limits plan catalogue unchanged';
    RETURN;
  END IF;

  SELECT ARRAY_AGG(required.column_name ORDER BY required.column_name)
    INTO missing_modern_columns
  FROM unnest(ARRAY[
    'id', 'tenant_id', 'plan', 'max_memories', 'max_searches_per_day',
    'max_projects', 'max_api_keys', 'searches_today', 'searches_reset_at',
    'created_at', 'updated_at'
  ]::TEXT[]) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns actual
    WHERE actual.table_schema = 'public'
      AND actual.table_name = 'tenant_plan_limits'
      AND actual.column_name = required.column_name
  );

  IF COALESCE(cardinality(missing_modern_columns), 0) <> 0 THEN
    RAISE EXCEPTION
      'tenant_plan_limits has tenant_id but is missing reviewed per-tenant columns';
  END IF;

  CREATE INDEX IF NOT EXISTS idx_tenant_plan_limits_tenant
    ON public.tenant_plan_limits (tenant_id);
  CREATE INDEX IF NOT EXISTS idx_tenant_plan_limits_plan
    ON public.tenant_plan_limits (plan);

  ALTER TABLE public.tenant_plan_limits
    DROP CONSTRAINT IF EXISTS tenant_plan_limits_plan_check;
  ALTER TABLE public.tenant_plan_limits
    ADD CONSTRAINT tenant_plan_limits_plan_check
    CHECK (plan IN ('dev', 'free', 'pro', 'team', 'business', 'enterprise'));

  IF to_regprocedure('public.update_updated_at_column()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tenant_plan_limits_updated_at
      ON public.tenant_plan_limits;
    CREATE TRIGGER tenant_plan_limits_updated_at
      BEFORE UPDATE ON public.tenant_plan_limits
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;

  INSERT INTO public.tenant_plan_limits (
    tenant_id, plan, max_memories, max_searches_per_day,
    max_projects, max_api_keys
  )
  SELECT
    tenant.id,
    tenant.plan,
    CASE tenant.plan
      WHEN 'pro' THEN 25000
      WHEN 'team' THEN 250000
      WHEN 'business' THEN 1000000
      WHEN 'enterprise' THEN 2147483647
      ELSE 1000
    END,
    CASE tenant.plan
      WHEN 'pro' THEN 250000
      WHEN 'team' THEN 2500000
      WHEN 'business' THEN 10000000
      WHEN 'enterprise' THEN 2147483647
      ELSE 10000
    END,
    CASE tenant.plan
      WHEN 'pro' THEN 25
      WHEN 'team' THEN 999
      WHEN 'business' THEN 999
      WHEN 'enterprise' THEN 2147483647
      ELSE 5
    END,
    CASE tenant.plan
      WHEN 'pro' THEN 10
      WHEN 'team' THEN 25
      WHEN 'business' THEN 50
      WHEN 'enterprise' THEN 100
      ELSE 3
    END
  FROM public.tenants tenant
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.tenant_plan_limits limits
    WHERE limits.tenant_id = tenant.id
  )
  ON CONFLICT (tenant_id) DO NOTHING;
END
$rembr_tenant_plan_limits$;

-- The fresh self-host schema historically constrained tenant_plans to a
-- subset that omitted the free and business plans used by agent signup and
-- billing. Repair that known lineage and install one canonical constraint.
-- Unknown plan-related checks fail closed instead of being silently dropped.
DO $rembr_tenant_plans_plan_constraint$
DECLARE
  plan_attribute SMALLINT;
BEGIN
  IF to_regclass('public.tenant_plans') IS NULL THEN
    RAISE EXCEPTION 'tenant_plans is required before applying plan limits';
  END IF;

  SELECT attribute.attnum
    INTO plan_attribute
  FROM pg_attribute attribute
  WHERE attribute.attrelid = 'public.tenant_plans'::regclass
    AND attribute.attname = 'plan'
    AND NOT attribute.attisdropped;

  IF plan_attribute IS NULL THEN
    RAISE EXCEPTION 'tenant_plans is missing its plan column';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.tenant_plans'::regclass
      AND constraint_row.contype = 'c'
      AND plan_attribute = ANY (constraint_row.conkey)
      AND constraint_row.conname <> 'tenant_plans_plan_check'
  ) THEN
    RAISE EXCEPTION 'tenant_plans has an unsupported plan constraint lineage';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tenant_plans
    WHERE plan NOT IN ('dev', 'free', 'pro', 'team', 'business', 'enterprise')
  ) THEN
    RAISE EXCEPTION 'tenant_plans contains an unsupported plan value';
  END IF;

  ALTER TABLE public.tenant_plans
    DROP CONSTRAINT IF EXISTS tenant_plans_plan_check;
  ALTER TABLE public.tenant_plans
    ADD CONSTRAINT tenant_plans_plan_check
    CHECK (plan IN ('dev', 'free', 'pro', 'team', 'business', 'enterprise'));
END
$rembr_tenant_plans_plan_constraint$;
