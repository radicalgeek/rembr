#!/usr/bin/env node
// Bootstrap a self-hosted Rembr tenant + API key.
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

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

function randomAlphanumeric(length) {
  const bytes = crypto.randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) out += ALPHANUMERIC[bytes[i] % ALPHANUMERIC.length]
  return out
}

const tenantName = process.env.TENANT_NAME || "self-hosted"
const tenantEmail = process.env.TENANT_EMAIL || "selfhost@localhost"
const keyName = process.env.KEY_NAME || "bootstrap"

const apiKey = `mb_live_${randomAlphanumeric(32)}`
const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex")
const keyPrefix = apiKey.slice(0, 20)

const esc = (value) => value.replace(/'/g, "''")

process.stdout.write(`-- rembr self-host bootstrap (generated ${new Date().toISOString()})
WITH tenant AS (
  INSERT INTO tenants (name, email)
  VALUES ('${esc(tenantName)}', '${esc(tenantEmail)}')
  ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
  RETURNING id
)
INSERT INTO api_keys (tenant_id, key_hash, key_prefix, hash_algorithm, name)
SELECT id, '${keyHash}', '${keyPrefix}', 'sha256', '${esc(keyName)}'
FROM tenant;
`)

process.stderr.write(`
Rembr API key (shown once — store it now):

  ${apiKey}

Use it as REMBR_API_KEY for the console, agent plugins, and MCP clients
(x-api-key header). Tenant: "${tenantName}" <${tenantEmail}>.
`)
