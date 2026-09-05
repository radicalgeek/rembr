-- Public self-host schema upgrade for Rembr's authentication and tenancy boundary.
-- It preserves legacy autonomous self-host keys without broadening their
-- capabilities or lifetime, while user-owned workspaces remain user-bound.

BEGIN;

-- pgcrypto is required for one-way migration of claim tokens and OAuth client
-- secrets. Deployment runs this migration as the database owner so extension
-- creation is deterministic on installations that only enabled pgvector.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    RAISE EXCEPTION 'pgcrypto is required by the Rembr security migration';
  END IF;
END $$;

-- Separate tenant-local authority from platform-wide authority and make
-- stateless session revocation enforceable.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "platform_role" VARCHAR(50) NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(50) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "auth_version" INTEGER NOT NULL DEFAULT 0;

UPDATE "users"
SET "status" = 'deactivated', "role" = 'member'
WHERE "role" = 'deactivated';

ALTER TABLE "users"
  DROP CONSTRAINT IF EXISTS "users_platform_role_check",
  ADD CONSTRAINT "users_platform_role_check"
    CHECK ("platform_role" IN ('user', 'platform_admin')),
  DROP CONSTRAINT IF EXISTS "users_status_check",
  ADD CONSTRAINT "users_status_check"
    CHECK ("status" IN ('active', 'deactivated', 'suspended'));

CREATE INDEX IF NOT EXISTS "idx_users_platform_role" ON "users"("platform_role");
CREATE INDEX IF NOT EXISTS "idx_users_status" ON "users"("status");

-- Durable, multi-replica agent-signup throttling. bucket_hash contains an HMAC
-- of the source/window or the global window; no raw network address is stored.
CREATE TABLE IF NOT EXISTS "agent_signup_rate_limits" (
  "bucket_hash" VARCHAR(64) PRIMARY KEY,
  "count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_agent_signup_rate_limits_expiry"
  ON "agent_signup_rate_limits"("expires_at");

-- Durable, leased reservations bound expensive authenticated model work by
-- tenant and user across replicas. Failed/expired work is refundable from the
-- daily budget but remains visible to the short abuse window until cleanup.
CREATE TABLE IF NOT EXISTS "ai_generation_reservations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" VARCHAR(32) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "ai_generation_kind_check" CHECK ("kind" IN ('memory_chat', 'concept_explain')),
  CONSTRAINT "ai_generation_status_check" CHECK ("status" IN ('pending', 'completed', 'failed'))
);
CREATE INDEX IF NOT EXISTS "idx_ai_generation_tenant_created"
  ON "ai_generation_reservations"("tenant_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_ai_generation_active"
  ON "ai_generation_reservations"("tenant_id", "status", "expires_at");
CREATE INDEX IF NOT EXISTS "idx_ai_generation_user_created"
  ON "ai_generation_reservations"("user_id", "created_at" DESC);

-- A stable cutover timestamp distinguishes legacy rows on repeat execution.
CREATE TABLE IF NOT EXISTS "rembr_security_migration_state" (
  "migration_key" TEXT PRIMARY KEY,
  "cutover_at" TIMESTAMPTZ(6) NOT NULL
);

-- Capture whether this transaction is performing the original cutover. Later
-- idempotent executions cannot reinterpret a key that an owner deliberately
-- revoked or rebound after migration.
CREATE TEMP TABLE "rembr_security_migration_run" (
  "first_run" BOOLEAN NOT NULL
) ON COMMIT DROP;
INSERT INTO "rembr_security_migration_run" ("first_run")
SELECT NOT EXISTS (
  SELECT 1
  FROM "rembr_security_migration_state"
  WHERE "migration_key" = '20260808000000_security_auth_boundary'
);

INSERT INTO "rembr_security_migration_state" ("migration_key", "cutover_at")
VALUES ('20260808000000_security_auth_boundary', NOW())
ON CONFLICT ("migration_key") DO NOTHING;

-- Canonicalise identity lookups once and enforce case-insensitive uniqueness.
-- Refuse an ambiguous upgrade rather than choosing one account from a
-- collision such as User@example.test / user@example.test.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "users"
    GROUP BY LOWER(BTRIM("email"))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'case-insensitive user email collision requires operator resolution';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "tenants"
    GROUP BY LOWER(BTRIM("email"))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'case-insensitive tenant email collision requires operator resolution';
  END IF;
END $$;

UPDATE "users" SET "email" = LOWER(BTRIM("email"));
UPDATE "tenants" SET "email" = LOWER(BTRIM("email"));
UPDATE "invitations" SET "email" = LOWER(BTRIM("email"));
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key" ON "users" (LOWER("email"));
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_email_lower_key" ON "tenants" (LOWER("email"));

-- Public dynamic OAuth clients are registry records, not product workspaces.
-- All unowned DCR applications use this single internal owner row; it has no
-- users, projects or agent credentials and cannot be joined by email.
INSERT INTO "tenants" ("id", "name", "email", "plan", "status", "created_at", "updated_at")
VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  'OAuth Dynamic Client Registry',
  'oauth-registry@internal.rembr.invalid',
  'free',
  'active',
  NOW(),
  NOW()
)
ON CONFLICT ("id") DO NOTHING;

-- Stripe customer IDs use random-nonce authenticated encryption. A separately
-- derived HMAC supports equality lookup without deterministic ciphertext.
-- Refuse legacy values: they require an explicit offline self-host migration,
-- and self-hosted operators must resolve any populated legacy rows before this upgrade.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "stripe_customer_lookup_hash" VARCHAR(64);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "tenants"
    WHERE "stripe_customer_id" IS NOT NULL
      AND (
        "stripe_customer_id" NOT LIKE 'v2:%' OR
        "stripe_customer_lookup_hash" !~ '^[0-9a-f]{64}$'
      )
  ) THEN
    RAISE EXCEPTION 'legacy Stripe customer IDs require offline v2 re-encryption before migration';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "tenants_stripe_customer_lookup_hash_key"
  ON "tenants"("stripe_customer_lookup_hash");
CREATE INDEX IF NOT EXISTS "idx_tenants_stripe_customer_lookup"
  ON "tenants"("stripe_customer_lookup_hash");
ALTER TABLE "tenants"
  DROP CONSTRAINT IF EXISTS "tenants_stripe_customer_v2_check",
  ADD CONSTRAINT "tenants_stripe_customer_v2_check"
    CHECK (
      ("stripe_customer_id" IS NULL AND "stripe_customer_lookup_hash" IS NULL) OR
      ("stripe_customer_id" LIKE 'v2:%' AND "stripe_customer_lookup_hash" ~ '^[0-9a-f]{64}$')
    );

-- Invitation URLs are bearer capabilities. Retain only a digest and an
-- explicit one-time representation marker so repeat execution cannot hash a
-- credential twice.
ALTER TABLE "invitations"
  ADD COLUMN IF NOT EXISTS "token_hash_algorithm" VARCHAR(20);

UPDATE "invitations"
SET
  "token" = encode(digest("token", 'sha256'), 'hex'),
  "token_hash_algorithm" = 'sha256'
WHERE "token_hash_algorithm" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "invitations"
    WHERE "token" !~ '^[0-9a-f]{64}$'
       OR "token_hash_algorithm" IS DISTINCT FROM 'sha256'
  ) THEN
    RAISE EXCEPTION 'invitation token migration left an unsupported representation';
  END IF;
END $$;

ALTER TABLE "invitations"
  ALTER COLUMN "token_hash_algorithm" SET DEFAULT 'sha256',
  ALTER COLUMN "token_hash_algorithm" SET NOT NULL,
  DROP CONSTRAINT IF EXISTS "invitations_token_hash_algorithm_check",
  ADD CONSTRAINT "invitations_token_hash_algorithm_check"
    CHECK ("token" ~ '^[0-9a-f]{64}$' AND "token_hash_algorithm" = 'sha256');

-- Stripe webhook delivery uses a retryable lease. A failed handler releases
-- the lease, while only a completed record receives duplicate-delivery 200s.
ALTER TABLE "stripe_events"
  ADD COLUMN IF NOT EXISTS "processing_started_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lease_token" UUID;
CREATE INDEX IF NOT EXISTS "idx_stripe_events_processing_lease"
  ON "stripe_events"("processed", "processing_started_at");

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "stripe_last_event_created_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "stripe_last_event_id" VARCHAR(255);

-- Feature flags are schema-owned objects. Runtime application roles must not
-- need CREATE privilege merely to read or update a flag.
CREATE TABLE IF NOT EXISTS "feature_flags" (
  "key" TEXT PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "updated_by" TEXT,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Claim URLs retain the original random token while only its digest remains in
-- the database. Legacy 64-hex values are raw random tokens and must be hashed
-- exactly once. The explicit algorithm marker makes this block repeatable
-- without trying to infer representation from the token's shape.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "claim_token" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "claim_token_hash_algorithm" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "claim_token_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_by_agent" BOOLEAN DEFAULT FALSE;

UPDATE "tenants"
SET "created_by_agent" = FALSE
WHERE "created_by_agent" IS NULL;

ALTER TABLE "tenants"
  ALTER COLUMN "created_by_agent" SET DEFAULT FALSE,
  ALTER COLUMN "created_by_agent" SET NOT NULL;

-- Some Compose/self-host baselines predate the agent-signup migrations. Make
-- the uniqueness contract explicit before using claim_token as a credential.
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_claim_token_key"
  ON "tenants"("claim_token");
CREATE INDEX IF NOT EXISTS "idx_tenants_claim_token"
  ON "tenants"("claim_token");

UPDATE "tenants"
SET
  "claim_token" = encode(digest("claim_token", 'sha256'), 'hex'),
  "claim_token_hash_algorithm" = 'sha256'
WHERE "claim_token" IS NOT NULL
  AND "claim_token_hash_algorithm" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "tenants"
    WHERE "claim_token" IS NOT NULL
      AND (
        "claim_token" !~ '^[0-9a-f]{64}$' OR
        "claim_token_hash_algorithm" IS DISTINCT FROM 'sha256'
      )
  ) THEN
    RAISE EXCEPTION 'claim token migration left an unsupported token representation';
  END IF;
END $$;

ALTER TABLE "tenants"
  DROP CONSTRAINT IF EXISTS "tenants_claim_token_hash_algorithm_check",
  ADD CONSTRAINT "tenants_claim_token_hash_algorithm_check"
    CHECK (
      ("claim_token" IS NULL AND "claim_token_hash_algorithm" IS NULL) OR
      ("claim_token" ~ '^[0-9a-f]{64}$' AND "claim_token_hash_algorithm" = 'sha256')
    );

-- Agent-first bootstrap keys are deliberately scoped and remain autonomous
-- until a successful human ownership claim revokes and rotates them. The
-- default capabilities preserve the existing tenant feature set for ordinary
-- keys without granting any platform capability.
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "user_id" UUID,
  ADD COLUMN IF NOT EXISTS "purpose" VARCHAR(50) NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[
    'memory:read', 'memory:write', 'context:manage', 'snapshot:manage'
  ]::TEXT[];

ALTER TABLE "api_keys"
  DROP CONSTRAINT IF EXISTS "api_keys_purpose_check",
  ADD CONSTRAINT "api_keys_purpose_check"
    CHECK ("purpose" IN ('standard', 'agent_bootstrap'));

CREATE INDEX IF NOT EXISTS "idx_api_keys_purpose" ON "api_keys"("purpose");
CREATE INDEX IF NOT EXISTS "idx_api_keys_expires_at" ON "api_keys"("expires_at");
CREATE INDEX IF NOT EXISTS "idx_api_keys_user_id" ON "api_keys"("user_id");

-- Identify autonomous workspaces only during the original cutover. Modern
-- agent-created workspaces already carry the explicit unclaimed state. Older
-- public Compose releases created an active tenant with no users and at least
-- one unbound key; that exact shape is upgraded to the explicit state. The
-- internal OAuth registry is excluded by the required key predicate.
CREATE TEMP TABLE "rembr_self_host_autonomous_tenants" (
  "tenant_id" UUID PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO "rembr_self_host_autonomous_tenants" ("tenant_id")
SELECT t."id"
FROM "tenants" t
JOIN "rembr_security_migration_run" run ON run."first_run" = TRUE
JOIN "rembr_security_migration_state" ms
  ON ms."migration_key" = '20260808000000_security_auth_boundary'
WHERE t."claimed_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "users" u WHERE u."tenant_id" = t."id"
  )
  AND (
    (t."created_by_agent" = TRUE AND t."status" = 'unclaimed') OR
    (
      t."created_by_agent" = FALSE
      AND t."status" = 'active'
      AND EXISTS (
        SELECT 1
        FROM "api_keys" candidate
        WHERE candidate."tenant_id" = t."id"
          AND candidate."created_at" <= ms."cutover_at"
          AND candidate."user_id" IS NULL
          AND candidate."purpose" = 'standard'
          AND candidate."revoked_at" IS NULL
          AND (
            candidate."expires_at" IS NULL OR
            candidate."expires_at" > ms."cutover_at"
          )
      )
    )
  );

-- Old public Compose tenants had no explicit autonomous marker. Promote only
-- the reviewed no-user/key shape; never reinterpret a claimed or suspended
-- workspace. This makes the preserved key usable under the new auth policy.
UPDATE "tenants" t
SET "status" = 'unclaimed', "created_by_agent" = TRUE
FROM "rembr_self_host_autonomous_tenants" autonomous
WHERE autonomous."tenant_id" = t."id"
  AND t."status" = 'active'
  AND t."created_by_agent" = FALSE;

-- Preserve existing verifier, project, capabilities, expiry and revocation
-- fields byte-for-byte. Only the purpose changes, and only for pre-cutover
-- unbound rows in a reviewed autonomous workspace. Reruns cannot undo later
-- operator restrictions.
UPDATE "api_keys" k
SET "purpose" = 'agent_bootstrap'
FROM "rembr_self_host_autonomous_tenants" autonomous,
     "rembr_security_migration_state" ms
WHERE autonomous."tenant_id" = k."tenant_id"
  AND ms."migration_key" = '20260808000000_security_auth_boundary'
  AND k."created_at" <= ms."cutover_at"
  AND k."user_id" IS NULL
  AND k."purpose" = 'standard';

-- Bound standard credentials retain their exact existing same-tenant user
-- binding. Remaining unbound standard keys flow through attribution or
-- fail-closed revocation below.

-- Quarantine malformed legacy privacy states rather than interpreting them as
-- tenant-wide. The sentinel has no matching user and keeps the record
-- inaccessible until an administrator repairs its ownership/project binding.
ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "user_id" UUID,
  ADD COLUMN IF NOT EXISTS "visibility" VARCHAR(20) DEFAULT 'shared';

UPDATE "memories"
SET "visibility" = 'shared'
WHERE "visibility" IS NULL;

ALTER TABLE "memories"
  ALTER COLUMN "visibility" SET DEFAULT 'shared',
  ALTER COLUMN "visibility" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_memories_user_id" ON "memories"("user_id");
CREATE INDEX IF NOT EXISTS "idx_memories_visibility" ON "memories"("visibility");
CREATE INDEX IF NOT EXISTS "idx_memories_tenant_visibility"
  ON "memories"("tenant_id", "visibility");

UPDATE "memories"
SET "visibility" = 'personal',
    "user_id" = COALESCE("user_id", '00000000-0000-0000-0000-000000000000'::uuid)
WHERE ("visibility" = 'project' AND "project_id" IS NULL)
   OR ("visibility" = 'personal' AND "user_id" IS NULL);

ALTER TABLE "memories"
  DROP CONSTRAINT IF EXISTS "memories_visibility_check",
  ADD CONSTRAINT "memories_visibility_check"
    CHECK ("visibility" IN ('personal', 'project', 'shared')),
  DROP CONSTRAINT IF EXISTS "memories_project_visibility_scope_check",
  ADD CONSTRAINT "memories_project_visibility_scope_check"
    CHECK ("visibility" <> 'project' OR "project_id" IS NOT NULL),
  DROP CONSTRAINT IF EXISTS "memories_personal_visibility_owner_check",
  ADD CONSTRAINT "memories_personal_visibility_owner_check"
    CHECK ("visibility" <> 'personal' OR "user_id" IS NOT NULL);

-- Attribute pre-cutover claimed-workspace keys before requiring an owner.
-- Prefer the same-tenant project creator. Otherwise bind only when exactly one
-- tenant user existed when the key was created. Ambiguous credentials are
-- revoked rather than guessed. The stable cutover marker makes reruns inert.
UPDATE "api_keys" k
SET "user_id" = p."created_by"
FROM "projects" p, "users" u, "tenants" t,
     "rembr_security_migration_state" ms
WHERE ms."migration_key" = '20260808000000_security_auth_boundary'
  AND k."created_at" <= ms."cutover_at"
  AND k."user_id" IS NULL
  AND k."purpose" = 'standard'
  AND k."tenant_id" = t."id"
  AND t."status" <> 'unclaimed'
  AND k."project_id" = p."id"
  AND p."tenant_id" = k."tenant_id"
  AND p."created_by" = u."id"
  AND u."tenant_id" = k."tenant_id";

WITH unique_legacy_owners AS (
  SELECT k."id" AS "key_id", MIN(u."id"::text)::uuid AS "user_id"
  FROM "api_keys" k
  JOIN "tenants" t ON t."id" = k."tenant_id" AND t."status" <> 'unclaimed'
  JOIN "users" u
    ON u."tenant_id" = k."tenant_id"
   AND u."created_at" <= k."created_at"
  JOIN "rembr_security_migration_state" ms
    ON ms."migration_key" = '20260808000000_security_auth_boundary'
  WHERE k."created_at" <= ms."cutover_at"
    AND k."user_id" IS NULL
    AND k."purpose" = 'standard'
  GROUP BY k."id"
  HAVING COUNT(*) = 1
)
UPDATE "api_keys" k
SET "user_id" = owner."user_id"
FROM unique_legacy_owners owner
WHERE owner."key_id" = k."id"
  AND k."user_id" IS NULL;

UPDATE "api_keys" k
SET "revoked_at" = COALESCE(k."revoked_at", NOW())
FROM "tenants" t, "rembr_security_migration_state" ms
WHERE ms."migration_key" = '20260808000000_security_auth_boundary'
  AND k."created_at" <= ms."cutover_at"
  AND k."tenant_id" = t."id"
  AND t."status" <> 'unclaimed'
  AND k."purpose" = 'standard'
  AND k."user_id" IS NULL;

ALTER TABLE "api_keys"
  DROP CONSTRAINT IF EXISTS "api_keys_owner_by_purpose_check",
  ADD CONSTRAINT "api_keys_owner_by_purpose_check"
    CHECK (
      ("purpose" = 'agent_bootstrap' AND "user_id" IS NULL) OR
      (
        "purpose" = 'standard' AND
        ("user_id" IS NOT NULL OR "revoked_at" IS NOT NULL)
      )
    );

-- Bind OAuth grants to client type, redirect, issuer, audience and PKCE.
ALTER TABLE "oauth_apps"
  ALTER COLUMN "client_secret" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "client_secret_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "client_type" VARCHAR(20) NOT NULL DEFAULT 'confidential',
  ADD COLUMN IF NOT EXISTS "token_endpoint_auth_method" VARCHAR(32) NOT NULL DEFAULT 'client_secret_post',
  ADD COLUMN IF NOT EXISTS "registration_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "allowed_scopes" TEXT[] NOT NULL DEFAULT ARRAY[
    'openid', 'profile', 'email', 'mcp:read', 'mcp:write', 'mcp:full',
    'read:memories', 'write:memories'
  ]::TEXT[];

-- Migrate every existing confidential secret before removing its plaintext
-- representation. The NULL predicate makes repeat execution non-destructive.
UPDATE "oauth_apps"
SET "client_secret_hash" = encode(digest("client_secret", 'sha256'), 'hex')
WHERE "client_secret" IS NOT NULL AND "client_secret_hash" IS NULL;

UPDATE "oauth_apps"
SET "client_secret" = NULL
WHERE "client_secret_hash" IS NOT NULL;

UPDATE "oauth_apps"
SET "token_endpoint_auth_method" = CASE
  WHEN "client_type" = 'public' THEN 'none'
  ELSE COALESCE("token_endpoint_auth_method", 'client_secret_post')
END;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "oauth_apps"
    WHERE "client_type" = 'confidential' AND "client_secret_hash" IS NULL
  ) THEN
    RAISE EXCEPTION 'confidential OAuth apps require a migrated client secret hash';
  END IF;
END $$;

ALTER TABLE "oauth_apps"
  DROP CONSTRAINT IF EXISTS "oauth_apps_client_type_check",
  ADD CONSTRAINT "oauth_apps_client_type_check"
    CHECK ("client_type" IN ('public', 'confidential')),
  DROP CONSTRAINT IF EXISTS "oauth_apps_secret_by_type_check",
  ADD CONSTRAINT "oauth_apps_secret_by_type_check"
    CHECK (
      ("client_type" = 'public' AND "client_secret_hash" IS NULL) OR
      ("client_type" = 'confidential' AND "client_secret_hash" IS NOT NULL)
    ),
  DROP CONSTRAINT IF EXISTS "oauth_apps_token_auth_method_check",
  ADD CONSTRAINT "oauth_apps_token_auth_method_check"
    CHECK (
      ("client_type" = 'public' AND "token_endpoint_auth_method" = 'none') OR
      ("client_type" = 'confidential' AND "token_endpoint_auth_method" IN ('client_secret_post', 'client_secret_basic'))
    );

ALTER TABLE "authorization_codes"
  ADD COLUMN IF NOT EXISTS "project_id" UUID,
  ADD COLUMN IF NOT EXISTS "code_challenge_method" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "issuer" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "resource" VARCHAR(255);

-- The protected-resource identifier changed to the canonical origin + /mcp.
-- Existing short-lived codes are deliberately consumed and existing tokens
-- revoked rather than guessing an environment-specific resource. Existing
-- self-hosted OAuth clients must reauthorise once after this upgrade.
UPDATE "authorization_codes"
SET "resource" = 'urn:rembr:reauthorization-required', "used" = TRUE
WHERE "resource" IS NULL;

ALTER TABLE "authorization_codes"
  ALTER COLUMN "resource" SET NOT NULL,
  DROP CONSTRAINT IF EXISTS "authorization_codes_pkce_method_check",
  ADD CONSTRAINT "authorization_codes_pkce_method_check"
    CHECK ("code_challenge_method" IS NULL OR "code_challenge_method" = 'S256');

CREATE INDEX IF NOT EXISTS "idx_auth_codes_project_id"
  ON "authorization_codes"("project_id");
CREATE INDEX IF NOT EXISTS "idx_auth_codes_principal_active"
  ON "authorization_codes"("user_id", "client_id", "used", "expires_at");
CREATE INDEX IF NOT EXISTS "idx_auth_codes_tenant_active"
  ON "authorization_codes"("tenant_id", "used", "expires_at");
CREATE INDEX IF NOT EXISTS "idx_oauth_apps_registration_expiry"
  ON "oauth_apps"("registration_expires_at");

UPDATE "oauth_apps" app
SET "last_used_at" = usage."last_used_at"
FROM (
  SELECT "client_id", MAX("created_at") AS "last_used_at"
  FROM "oauth_tokens"
  GROUP BY "client_id"
) usage
WHERE app."created_by" IS NULL
  AND app."last_used_at" IS NULL
  AND usage."client_id" = app."client_id";

UPDATE "oauth_apps"
SET "registration_expires_at" = "created_at" + INTERVAL '30 days'
WHERE "created_by" IS NULL
  AND "registration_expires_at" IS NULL;

ALTER TABLE "oauth_tokens"
  ADD COLUMN IF NOT EXISTS "project_id" UUID,
  ADD COLUMN IF NOT EXISTS "audience" TEXT,
  ADD COLUMN IF NOT EXISTS "resource" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(6);

UPDATE "oauth_tokens"
SET "resource" = 'urn:rembr:reauthorization-required',
    "audience" = 'urn:rembr:reauthorization-required',
    "revoked_at" = COALESCE("revoked_at", NOW())
WHERE "resource" IS NULL;

ALTER TABLE "oauth_tokens"
  ALTER COLUMN "resource" SET NOT NULL,
  DROP CONSTRAINT IF EXISTS "oauth_tokens_resource_audience_check",
  ADD CONSTRAINT "oauth_tokens_resource_audience_check"
    CHECK ("resource" = "audience");

CREATE INDEX IF NOT EXISTS "idx_oauth_tokens_revoked_at" ON "oauth_tokens"("revoked_at");
CREATE INDEX IF NOT EXISTS "idx_oauth_tokens_project_id" ON "oauth_tokens"("project_id");
CREATE INDEX IF NOT EXISTS "idx_oauth_tokens_principal_cleanup"
  ON "oauth_tokens"("user_id", "client_id", "revoked_at", "created_at");

-- Snapshot ownership protects historical copies even if the source memory is
-- later removed. Existing project-bound snapshots remain visible through the
-- project ACL; legacy unbound snapshots require explicit ownership repair.
ALTER TABLE "context_snapshots"
  ADD COLUMN IF NOT EXISTS "user_id" UUID,
  ADD COLUMN IF NOT EXISTS "visibility" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "audience_version" SMALLINT;

CREATE INDEX IF NOT EXISTS "idx_context_snapshots_user_visibility"
  ON "context_snapshots"("user_id", "visibility");

ALTER TABLE "snapshot_memories"
  ADD COLUMN IF NOT EXISTS "user_id" UUID,
  ADD COLUMN IF NOT EXISTS "project_id" UUID,
  ADD COLUMN IF NOT EXISTS "visibility" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "audience_version" SMALLINT;

-- Existing MCP installations enforce snapshot immutability with UPDATE
-- triggers. Suspend only those two named triggers for this one-time audience
-- backfill; the surrounding transaction and savepoint prevent a partial
-- migration from leaving them disabled.
SAVEPOINT rembr_snapshot_audience_backfill;
DO $snapshot_backfill_disable$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'context_snapshots'::regclass AND tgname = 'immutable_context_snapshots') THEN
    ALTER TABLE "context_snapshots" DISABLE TRIGGER "immutable_context_snapshots";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'snapshot_memories'::regclass AND tgname = 'immutable_snapshot_memories_update') THEN
    ALTER TABLE "snapshot_memories" DISABLE TRIGGER "immutable_snapshot_memories_update";
  END IF;
END
$snapshot_backfill_disable$;

-- audience_version is an explicit one-time marker. Snapshot audience is
-- immutable: a later change to a live source memory must never broaden or
-- otherwise rewrite the historical copy if this SQL is executed again.
UPDATE "snapshot_memories" sm
SET
  "user_id" = m."user_id",
  "project_id" = m."project_id",
  "visibility" = m."visibility"
FROM "memories" m, "context_snapshots" s
WHERE sm."memory_id" = m."id"
  AND sm."snapshot_id" = s."id"
  AND m."tenant_id" = s."tenant_id"
  AND sm."audience_version" IS NULL;

-- Deleted/cross-tenant sources and malformed historical copies must fail
-- closed. A sentinel owner deliberately matches no authenticated principal.
UPDATE "snapshot_memories"
SET "visibility" = 'personal',
    "user_id" = '00000000-0000-0000-0000-000000000000'::uuid,
    "project_id" = NULL
WHERE "audience_version" IS NULL
  AND (
    "visibility" IS NULL
    OR "visibility" NOT IN ('shared', 'project', 'personal')
    OR ("visibility" = 'personal' AND "user_id" IS NULL)
    OR ("visibility" = 'project' AND "project_id" IS NULL)
    OR NOT EXISTS (
      SELECT 1
      FROM "memories" m
      JOIN "context_snapshots" s
        ON s."id" = "snapshot_memories"."snapshot_id"
      WHERE m."id" = "snapshot_memories"."memory_id"
        AND m."tenant_id" = s."tenant_id"
    )
  );

UPDATE "snapshot_memories"
SET "audience_version" = 1
WHERE "audience_version" IS NULL;

-- Derive the snapshot audience from its most restrictive contained memory.
-- A snapshot containing personal memories from more than one owner is
-- quarantined to the sentinel owner rather than becoming tenant-readable.
-- Project binding is collected from the existing snapshot, immutable memory
-- copies and linked contexts. Only one tenant-compatible project is safe.
WITH source_projects AS (
  SELECT s."id" AS snapshot_id, s."project_id"
  FROM "context_snapshots" s
  WHERE s."project_id" IS NOT NULL
  UNION
  SELECT sm."snapshot_id", sm."project_id"
  FROM "snapshot_memories" sm
  WHERE sm."project_id" IS NOT NULL
  UNION
  SELECT sc."snapshot_id", c."project_id"
  FROM "snapshot_contexts" sc
  JOIN "contexts" c ON c."id" = sc."context_id"
), snapshot_audience AS (
  SELECT
    s."id" AS snapshot_id,
    BOOL_OR(sm."visibility" = 'personal') AS has_personal,
    BOOL_OR(sm."visibility" = 'project') AS has_project,
    COUNT(DISTINCT sm."user_id") FILTER (
      WHERE sm."visibility" = 'personal'
    ) AS personal_owner_count,
    MIN(sm."user_id"::text) FILTER (
      WHERE sm."visibility" = 'personal'
    )::uuid AS personal_owner,
    COUNT(DISTINCT sp."project_id") AS project_count,
    MIN(sp."project_id"::text)::uuid AS source_project,
    COUNT(DISTINCT sp."project_id") FILTER (
      WHERE p."id" IS NULL OR p."tenant_id" <> s."tenant_id"
    ) AS invalid_project_count
  FROM "context_snapshots" s
  LEFT JOIN "snapshot_memories" sm ON sm."snapshot_id" = s."id"
  LEFT JOIN source_projects sp ON sp.snapshot_id = s."id"
  LEFT JOIN "projects" p ON p."id" = sp."project_id"
  GROUP BY s."id"
)
UPDATE "context_snapshots" s
SET
  "visibility" = CASE
    WHEN a.has_personal
      AND a.personal_owner_count = 1
      AND a.project_count <= 1
      AND a.invalid_project_count = 0 THEN 'personal'
    WHEN a.has_personal THEN 'personal'
    WHEN a.has_project
      AND a.project_count = 1
      AND a.invalid_project_count = 0 THEN 'project'
    WHEN a.has_project THEN 'personal'
    WHEN a.project_count > 1 OR a.invalid_project_count > 0 THEN 'personal'
    ELSE 'shared'
  END,
  "user_id" = CASE
    WHEN a.has_personal
      AND a.personal_owner_count = 1
      AND a.project_count <= 1
      AND a.invalid_project_count = 0 THEN a.personal_owner
    WHEN a.has_personal
      OR a.has_project AND (a.project_count <> 1 OR a.invalid_project_count > 0)
      OR a.project_count > 1
      OR a.invalid_project_count > 0
      THEN '00000000-0000-0000-0000-000000000000'::uuid
    ELSE NULL
  END,
  "project_id" = CASE
    WHEN a.project_count = 1 AND a.invalid_project_count = 0
      THEN a.source_project
    ELSE NULL
  END,
  "audience_version" = 1
FROM snapshot_audience a
WHERE a.snapshot_id = s."id"
  AND s."audience_version" IS NULL;

DO $snapshot_backfill_enable$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'context_snapshots'::regclass AND tgname = 'immutable_context_snapshots') THEN
    ALTER TABLE "context_snapshots" ENABLE TRIGGER "immutable_context_snapshots";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'snapshot_memories'::regclass AND tgname = 'immutable_snapshot_memories_update') THEN
    ALTER TABLE "snapshot_memories" ENABLE TRIGGER "immutable_snapshot_memories_update";
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

ALTER TABLE "context_snapshots"
  ALTER COLUMN "visibility" SET DEFAULT 'shared',
  ALTER COLUMN "visibility" SET NOT NULL,
  ALTER COLUMN "audience_version" SET DEFAULT 1,
  ALTER COLUMN "audience_version" SET NOT NULL;

ALTER TABLE "snapshot_memories"
  ALTER COLUMN "visibility" SET DEFAULT 'shared',
  ALTER COLUMN "visibility" SET NOT NULL,
  ALTER COLUMN "audience_version" SET DEFAULT 1,
  ALTER COLUMN "audience_version" SET NOT NULL;

ALTER TABLE "context_snapshots"
  DROP CONSTRAINT IF EXISTS "context_snapshots_visibility_check",
  ADD CONSTRAINT "context_snapshots_visibility_check"
    CHECK ("visibility" IN ('personal', 'project', 'shared')),
  DROP CONSTRAINT IF EXISTS "context_snapshots_personal_owner_check",
  ADD CONSTRAINT "context_snapshots_personal_owner_check"
    CHECK ("visibility" <> 'personal' OR "user_id" IS NOT NULL),
  DROP CONSTRAINT IF EXISTS "context_snapshots_project_scope_check",
  ADD CONSTRAINT "context_snapshots_project_scope_check"
    CHECK ("visibility" <> 'project' OR "project_id" IS NOT NULL),
  DROP CONSTRAINT IF EXISTS "context_snapshots_audience_version_check",
  ADD CONSTRAINT "context_snapshots_audience_version_check"
    CHECK ("audience_version" >= 1);

ALTER TABLE "snapshot_memories"
  DROP CONSTRAINT IF EXISTS "snapshot_memories_visibility_check",
  ADD CONSTRAINT "snapshot_memories_visibility_check"
    CHECK ("visibility" IN ('personal', 'project', 'shared')),
  DROP CONSTRAINT IF EXISTS "snapshot_memories_personal_owner_check",
  ADD CONSTRAINT "snapshot_memories_personal_owner_check"
    CHECK ("visibility" <> 'personal' OR "user_id" IS NOT NULL),
  DROP CONSTRAINT IF EXISTS "snapshot_memories_project_scope_check",
  ADD CONSTRAINT "snapshot_memories_project_scope_check"
    CHECK ("visibility" <> 'project' OR "project_id" IS NOT NULL),
  DROP CONSTRAINT IF EXISTS "snapshot_memories_audience_version_check",
  ADD CONSTRAINT "snapshot_memories_audience_version_check"
    CHECK ("audience_version" >= 1);

CREATE INDEX IF NOT EXISTS "idx_snapshot_memories_user_visibility"
  ON "snapshot_memories"("user_id", "visibility");
CREATE INDEX IF NOT EXISTS "idx_snapshot_memories_project_id"
  ON "snapshot_memories"("project_id");

-- Abandoned autonomous registrations must never be reclaimed by the public
-- signup role: memories uses FORCE RLS, so a cross-tenant absence check made
-- without a tenant GUC would be unsound. Operators may invoke this bounded
-- owner function from a maintenance session. row_security=off makes the call
-- fail rather than silently accept a filtered view when its owner lacks the
-- required BYPASSRLS authority.
CREATE OR REPLACE FUNCTION "rembr_reclaim_abandoned_agent_tenants"(
  "p_limit" INTEGER DEFAULT 50
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $reclaim$
DECLARE
  deleted_count INTEGER := 0;
BEGIN
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'reclamation limit must be between 1 and 500';
  END IF;

  WITH abandoned AS (
    SELECT tenant.id
      FROM public.tenants tenant
      JOIN public.rembr_security_migration_state migration
        ON migration.migration_key = '20260808000000_security_auth_boundary'
     WHERE tenant.created_by_agent = TRUE
       AND tenant.status = 'unclaimed'
       AND tenant.claimed_at IS NULL
       AND tenant.created_at > migration.cutover_at
       AND tenant.created_at < NOW() - INTERVAL '30 days'
       AND tenant.claim_token_expires_at < NOW()
       AND NOT EXISTS (
         SELECT 1 FROM public.users app_user
          WHERE app_user.tenant_id = tenant.id
       )
       AND EXISTS (
         SELECT 1 FROM public.api_keys key
          WHERE key.tenant_id = tenant.id
            AND key.purpose = 'agent_bootstrap'
            AND key.revoked_at IS NULL
            AND key.last_used_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.api_keys key
          WHERE key.tenant_id = tenant.id
            AND key.last_used_at IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.memories memory
          WHERE memory.tenant_id = tenant.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.contexts context
           JOIN public.projects project ON project.id = context.project_id
          WHERE project.tenant_id = tenant.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.context_snapshots snapshot
          WHERE snapshot.tenant_id = tenant.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.usage_daily usage
          WHERE usage.tenant_id = tenant.id
       )
     ORDER BY tenant.created_at, tenant.id
     LIMIT p_limit
     FOR UPDATE OF tenant SKIP LOCKED
  )
  DELETE FROM public.tenants tenant
   USING abandoned
   WHERE tenant.id = abandoned.id;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$reclaim$;

REVOKE ALL ON FUNCTION "rembr_reclaim_abandoned_agent_tenants"(INTEGER) FROM PUBLIC;
DO $revoke_runtime_reclamation$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rembr_app') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.rembr_reclaim_abandoned_agent_tenants(INTEGER) FROM rembr_app';
  END IF;
END
$revoke_runtime_reclamation$;

-- These tables are application state, not schema-management surfaces. Grant
-- only the DML required by the shared runtime role when it exists; the stable
-- migration marker remains read-only and the owner maintenance function stays
-- revoked above.
DO $grant_runtime_security_state$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rembr_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_signup_rate_limits TO rembr_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_generation_reservations TO rembr_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feature_flags TO rembr_app';
    EXECUTE 'GRANT SELECT ON TABLE public.rembr_security_migration_state TO rembr_app';
  END IF;
END
$grant_runtime_security_state$;

COMMIT;
