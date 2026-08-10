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
// The key is shown once and stored only as a SHA-256 hash (matching the
// engine's api_keys verification: key_hash = sha256 hex, key_prefix = first
// 20 chars).

import crypto from "node:crypto"
import { pathToFileURL } from "node:url"

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

function randomAlphanumeric(length) {
  const bytes = crypto.randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) out += ALPHANUMERIC[bytes[i] % ALPHANUMERIC.length]
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

  const apiKey = suppliedApiKey || `mb_live_${randomAlphanumeric(64)}`
  if (!/^mb_live_[A-Za-z0-9]{64}$/.test(apiKey)) {
    throw new Error("generated bootstrap credential has an invalid format")
  }
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex")
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
      'free', 'unclaimed', TRUE
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

  INSERT INTO api_keys (
    tenant_id, project_id, user_id, key_hash, key_prefix, hash_algorithm,
    name, expires_at, purpose, capabilities
  ) VALUES (
    bootstrap_tenant_id,
    bootstrap_project_id,
    NULL,
    '${keyHash}',
    '${keyPrefix}',
    'sha256',
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
    bootstrap_tenant_id, existing_plan, 1000, 10000, 5
  )
  ON CONFLICT (tenant_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM tenant_plans
    WHERE tenant_id = bootstrap_tenant_id
      AND plan = existing_plan
      AND memory_limit = 1000
      AND search_limit_daily = 10000
      AND project_limit = 5
  ) THEN
    RAISE EXCEPTION 'self-host bootstrap tenant has incompatible plan limits';
  END IF;
END
$rembr_self_host_bootstrap$;
COMMIT;
`

  const message = `
Rembr API key (shown once — store it now):

  ${apiKey}

Use it as REMBR_API_KEY for the console, agent plugins, and MCP clients
(x-api-key header). It is a non-expiring, userless agent_bootstrap credential
for the unclaimed workspace "${tenantName}" <${tenantEmail}>.
`

  return { sql, message }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { sql, message } = buildBootstrap()
  process.stdout.write(sql)
  process.stderr.write(message)
}
