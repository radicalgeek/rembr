#!/usr/bin/env node
// Bootstrap a self-hosted, autonomous Rembr agent workspace + API key.
//
// Zero dependencies: generates an `mb_live_*` API key, prints the matching
// INSERT statements as SQL on stdout, and the key itself on stderr. Pipe the
// SQL into psql (directly or via docker compose):
//
//   node rembr-mcp/scripts/bootstrap-tenant.mjs \
//     | docker compose exec -T postgres psql -U rembr -d rembr
//
// The key is shown once and stored only as a hash. API_KEY_SECRET enables the
// engine's preferred HMAC-SHA256 format; otherwise the legacy SHA-256 format
// is used for compatibility.

import crypto from "node:crypto"
import { pathToFileURL } from "node:url"

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

function randomAlphanumeric(length) {
  let out = ""
  const unbiasedLimit = 256 - (256 % ALPHANUMERIC.length)
  while (out.length < length) {
    const bytes = crypto.randomBytes(length - out.length)
    for (const byte of bytes) {
      if (byte < unbiasedLimit) out += ALPHANUMERIC[byte % ALPHANUMERIC.length]
    }
  }
  return out
}

function boundedValue(value, label, maxLength) {
  const bounded = value.trim()
  if (!bounded || bounded.length > maxLength || /[\0\r\n]/.test(bounded)) {
    throw new Error(`${label} must contain 1-${maxLength} printable characters`)
  }
  return bounded
}

const encoded = (value) => Buffer.from(value, "utf8").toString("base64")

const planLimits = {
  free: { memory: 1000, search: 10000, project: 5 },
  pro: { memory: 25000, search: 250000, project: 25 },
  team: { memory: 250000, search: 2500000, project: 999 },
  business: { memory: 1000000, search: 10000000, project: 999 },
  enterprise: { memory: 2147483647, search: 2147483647, project: 2147483647 },
}

export function buildBootstrap(environment = process.env, suppliedApiKey) {
  const tenantName = boundedValue(
    environment.TENANT_NAME || "self-hosted",
    "TENANT_NAME",
    255,
  )
  const tenantEmail = boundedValue(
    environment.TENANT_EMAIL || "selfhost@localhost",
    "TENANT_EMAIL",
    255,
  ).toLowerCase()
  const keyName = boundedValue(
    environment.KEY_NAME || "bootstrap",
    "KEY_NAME",
    255,
  )

  if (!/^[^\s@]+@[^\s@]+$/.test(tenantEmail)) {
    throw new Error("TENANT_EMAIL must be a valid canonical email address")
  }

  const tenantPlan = (environment.TENANT_PLAN || "free").toLowerCase()
  if (!Object.hasOwn(planLimits, tenantPlan)) {
    throw new Error(`TENANT_PLAN must be one of: ${Object.keys(planLimits).join(", ")}`)
  }
  const limits = planLimits[tenantPlan]
  const requireNoActiveKeys = ["true", "1", "yes", "on"].includes(
    String(environment.REQUIRE_NO_ACTIVE_KEYS || "").toLowerCase(),
  )

  const apiKey = suppliedApiKey || `mb_live_${randomAlphanumeric(64)}`
  if (!/^mb_live_[A-Za-z0-9]{64}$/.test(apiKey)) {
    throw new Error("generated bootstrap credential has an invalid format")
  }
  const apiKeySecret = environment.API_KEY_SECRET
  const hashAlgorithm = apiKeySecret ? "hmac-sha256" : "sha256"
  const keyHash = apiKeySecret
    ? crypto.createHmac("sha256", apiKeySecret).update(apiKey).digest("hex")
    : crypto.createHash("sha256").update(apiKey).digest("hex")
  const keyPrefix = apiKey.slice(0, 20)
  const tenantNameEncoded = encoded(tenantName)
  const tenantEmailEncoded = encoded(tenantEmail)
  const keyNameEncoded = encoded(keyName)

  const sql = `-- rembr self-host bootstrap (generated ${new Date().toISOString()})
BEGIN;
DO $rembr_self_host_bootstrap$
DECLARE
  bootstrap_tenant_name TEXT := convert_from(
    decode('${tenantNameEncoded}', 'base64'), 'UTF8'
  );
  bootstrap_tenant_email TEXT := convert_from(
    decode('${tenantEmailEncoded}', 'base64'), 'UTF8'
  );
  bootstrap_key_name TEXT := convert_from(
    decode('${keyNameEncoded}', 'base64'), 'UTF8'
  );
  bootstrap_tenant_id UUID;
  bootstrap_project_id UUID;
  existing_status TEXT;
  existing_created_by_agent BOOLEAN;
  existing_plan TEXT;
  existing_project_is_personal BOOLEAN;
  existing_project_owner UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('rembr-self-host-bootstrap:' || bootstrap_tenant_email, 0)
  );

  SELECT id, status, created_by_agent, plan
    INTO bootstrap_tenant_id, existing_status, existing_created_by_agent,
         existing_plan
  FROM tenants
  WHERE email = bootstrap_tenant_email
  FOR UPDATE;

  IF FOUND THEN
    IF existing_status IS DISTINCT FROM 'unclaimed'
       OR existing_created_by_agent IS DISTINCT FROM TRUE
       OR existing_plan NOT IN ('free', 'dev')
    THEN
      RAISE EXCEPTION
        'self-host bootstrap email belongs to a claimed or non-agent tenant';
    END IF;
  ELSE
    INSERT INTO tenants (name, email, plan, status, created_by_agent)
    VALUES (
      bootstrap_tenant_name, bootstrap_tenant_email,
      '${tenantPlan}', 'unclaimed', TRUE
    )
    RETURNING id, plan INTO bootstrap_tenant_id, existing_plan;
  END IF;

  SELECT id, is_personal, owner_id
    INTO bootstrap_project_id, existing_project_is_personal,
         existing_project_owner
  FROM projects
  WHERE tenant_id = bootstrap_tenant_id
    AND name = 'Default Project'
  ORDER BY id
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF existing_project_is_personal IS DISTINCT FROM FALSE
       OR existing_project_owner IS NOT NULL
    THEN
      RAISE EXCEPTION
        'self-host bootstrap project has an incompatible ownership scope';
    END IF;
  ELSE
    INSERT INTO projects (tenant_id, name, description)
    VALUES (
      bootstrap_tenant_id,
      'Default Project',
      'Agent-created default project'
    )
    RETURNING id INTO bootstrap_project_id;
  END IF;

  IF EXISTS (SELECT 1 FROM api_keys WHERE key_hash = '${keyHash}') THEN
    RAISE EXCEPTION 'generated self-host bootstrap credential already exists';
  END IF;

  IF ${requireNoActiveKeys ? "TRUE" : "FALSE"} AND EXISTS (
    SELECT 1 FROM api_keys
    WHERE tenant_id = bootstrap_tenant_id
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
  ) THEN
    RAISE EXCEPTION 'self-host bootstrap tenant already has an active API key';
  END IF;

  INSERT INTO api_keys (
    tenant_id, project_id, user_id, key_hash, key_prefix, hash_algorithm,
    name, expires_at, purpose, capabilities
  ) VALUES (
    bootstrap_tenant_id,
    bootstrap_project_id,
    NULL,
    '${keyHash}',
    '${keyPrefix}',
    '${hashAlgorithm}',
    bootstrap_key_name,
    NULL,
    'agent_bootstrap',
    ARRAY[
      'memory:read', 'memory:write', 'context:manage', 'snapshot:manage'
    ]::TEXT[]
  );

  INSERT INTO tenant_plans (
    tenant_id, plan, memory_limit, search_limit_daily, project_limit
  ) VALUES (
    bootstrap_tenant_id,
    existing_plan,
    CASE existing_plan
      WHEN 'free' THEN ${planLimits.free.memory}
      WHEN 'pro' THEN ${planLimits.pro.memory}
      WHEN 'team' THEN ${planLimits.team.memory}
      WHEN 'business' THEN ${planLimits.business.memory}
      WHEN 'enterprise' THEN ${planLimits.enterprise.memory}
      ELSE ${planLimits.free.memory}
    END,
    CASE existing_plan
      WHEN 'free' THEN ${planLimits.free.search}
      WHEN 'pro' THEN ${planLimits.pro.search}
      WHEN 'team' THEN ${planLimits.team.search}
      WHEN 'business' THEN ${planLimits.business.search}
      WHEN 'enterprise' THEN ${planLimits.enterprise.search}
      ELSE ${planLimits.free.search}
    END,
    CASE existing_plan
      WHEN 'free' THEN ${planLimits.free.project}
      WHEN 'pro' THEN ${planLimits.pro.project}
      WHEN 'team' THEN ${planLimits.team.project}
      WHEN 'business' THEN ${planLimits.business.project}
      WHEN 'enterprise' THEN ${planLimits.enterprise.project}
      ELSE ${planLimits.free.project}
    END
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    plan = EXCLUDED.plan,
    memory_limit = EXCLUDED.memory_limit,
    search_limit_daily = EXCLUDED.search_limit_daily,
    project_limit = EXCLUDED.project_limit,
    updated_at = CURRENT_TIMESTAMP;
END
$rembr_self_host_bootstrap$;
COMMIT;
`

  const message = `
Rembr API key (shown once — store it now):

  ${apiKey}

Use it as REMBR_API_KEY for the console, agent plugins, and MCP clients
(x-api-key header). It is a non-expiring, userless agent_bootstrap credential
for the unclaimed workspace "${tenantName}" <${tenantEmail}>. Plan: ${tenantPlan}.
`

  return { sql, message }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { sql, message } = buildBootstrap()
  process.stdout.write(sql)
  process.stderr.write(message)
}
