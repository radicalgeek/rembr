# Self-Hosting Rembr

Run the full Rembr memory engine plus a web console on your own hardware. The
self-hosted stack uses the same multi-tenant, agent-facing engine that powers
rembr.ai, without its login, billing or feature-flag services. It starts with no
predictable tenant or credential; an operator mints the first scoped API key once,
after which agents use the MCP surface directly.

## What you get

- **rembr-mcp** — the memory engine: MCP server with memory CRUD, hybrid semantic search,
  contexts, snapshots, graph reasoning, temporal queries, causal tracing, audit and PII
  tooling. PostgreSQL + pgvector backed, server-side embeddings.
- **rembr-console** — a lightweight web UI (browse/search/create/delete memories,
  contexts, snapshots, stats). A pure MCP client with zero runtime dependencies.
- **PostgreSQL 16 + pgvector**, and optionally a local **Ollama** for embeddings.

## Quick start (Docker Compose)

```bash
git clone https://github.com/radicalgeek/rembr.git && cd rembr
cp .env.example .env          # generate every required secret in this file

# 1. Start the database and engine (add --profile ollama for local embeddings)
docker compose --profile ollama up -d --build
docker compose exec ollama ollama pull nomic-embed-text

# 2. Create your tenant + API key (printed once — save it)
node rembr-mcp/scripts/bootstrap-tenant.mjs \
  | docker compose exec -T postgres psql -U rembr -d rembr

# 3. Put the printed key in .env as REMBR_API_KEY, generate a distinct
#    REMBR_CONSOLE_AUTH_TOKEN, then start the console
docker compose up -d rembr-console
```

`POSTGRES_PASSWORD` is the database-owner credential. `DB_APP_PASSWORD` is a
distinct 64-or-more-character hexadecimal password for the non-owner
`rembr_app` runtime role. The bootstrap service validates it, applies the
versioned self-host authentication and MCP security migrations in order, preserves
FORCE RLS, restricts elevated functions to the two credential lookup signatures,
and starts MCP only after the checks succeed. Set `PUBLIC_URL` to the stable
origin agents use and set `OAUTH_AUDIENCE` to that exact origin plus `/mcp`
(for example, `https://memory.example/mcp`) so OAuth tokens remain bound to the
agent-facing resource.

- Console: http://localhost:8080 (enter `REMBR_CONSOLE_AUTH_TOKEN` in the login control)
- MCP endpoint: http://localhost:3000/mcp (`x-api-key` header)
- Health: http://localhost:3000/health

### Embeddings

Search quality depends on an embedding provider. Two options:

- **Local Ollama** (default): start with `--profile ollama` and pull `nomic-embed-text`
  once. Fully local, no external calls.
- **An unauthenticated OpenAI-compatible endpoint** (for example a local LM Studio
  or trusted gateway): set `EMBEDDING_PROVIDER=openai-compatible` plus
  `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` in `.env`.
  Direct API-key-authenticated embedding providers are not supported by this
  self-host profile.

Embeddings are generated server-side — agents and the console only ever send text.

## Optional Jev relationship inference

Rembr's local relationship engine remains the default and always writes its
decision first. Self-hosters can optionally enable Jev (TypeSafe System One) to
review bounded relationship candidates. A Jev result is applied only when it
passes the `0.8` confidence gate. Low-confidence responses, timeouts, invalid
responses, exhausted budgets and unavailable provider credit all retain the
local decision.

This integration sends the two candidate memory texts to
`https://api.typesafe.ai/v1/systemone`. It is disabled by default. Before any
request, Rembr rejects content already marked as containing PII and performs a
second local PII and secret scan. A fixed egress proxy limits the optional
worker to the TypeSafe endpoint.

To enable it for one existing tenant and project:

1. Generate an independent database password and run UUID:

   ```bash
   openssl rand -hex 32
   uuidgen | tr '[:upper:]' '[:lower:]'
   ```

2. Find the target IDs as the database owner:

   ```bash
   docker compose exec postgres psql -U rembr -d rembr \
     -c "SELECT t.id AS tenant_id, p.id AS project_id, t.name, p.name FROM tenants t JOIN projects p ON p.tenant_id = t.id ORDER BY t.name, p.name;"
   ```

3. Set these values in `.env`:

   ```dotenv
   SYSTEM_ONE_INTEGRATION_ENABLED=true
   SYSTEM_ONE_SHADOW_CAPTURE_ENABLED=true
   DB_SHADOW_PASSWORD=<independent-64-character-hex-value>
   TYPESAFE_API_KEY=<typesafe-api-key>
   SYSTEM_ONE_SHADOW_TENANT_ID=<tenant-uuid>
   SYSTEM_ONE_SHADOW_PROJECT_ID=<project-uuid>
   SYSTEM_ONE_SHADOW_RUN_ID=<new-run-uuid>
   ```

4. Apply the database migrations and create the least-privilege worker login:

   ```bash
   docker compose run --rm rembr-db-bootstrap
   ```

5. Activate a hard request, token and cost budget. Replace the UUIDs with the
   same values from `.env`; only the database owner can call this function:

   ```bash
   docker compose exec postgres psql -U rembr -d rembr -v ON_ERROR_STOP=1 -c \
     "SELECT rembr_admin_activate_relationship_live('<tenant-uuid>', '<project-uuid>', '<run-uuid>', 250, 750000, 0.05, 5);"
   ```

6. Start the MCP service and the optional worker profile:

   ```bash
   docker compose --profile jev up -d --build
   ```

The activation arguments are maximum requests, maximum input tokens, maximum
cost in US dollars and maximum requests per worker cycle. The database reserves
budget before each single-attempt request, so a worker restart cannot bypass the
limits.

Stop a run immediately with the matching IDs:

```bash
docker compose exec postgres psql -U rembr -d rembr -v ON_ERROR_STOP=1 -c \
  "SELECT rembr_admin_stop_relationship_live('<tenant-uuid>', '<project-uuid>', '<run-uuid>');"
docker compose --profile jev stop system-one-worker system-one-egress-proxy
```

Stopping closes capture and provider access, cancels pending work and abandons
uncompleted reservations. Set both `SYSTEM_ONE_INTEGRATION_ENABLED` and
`SYSTEM_ONE_SHADOW_CAPTURE_ENABLED` back to `false` before the next ordinary
Compose restart if Jev should remain disabled.

## Connecting agents

Your self-hosted endpoint works with every Rembr integration — point them at
`http://your-host:3000/mcp` with your API key:

- **Claude Code**: the `rembr` plugin (`claude-code-rembr/`) — set `REMBR_URL` + `REMBR_API_KEY`
- **OpenCode**: `opencode-rembr` plugin, or a remote MCP entry in `opencode.json`
- **OpenClaw**: `memory-rembr` memory-slot plugin (`openclaw-rembr/`)
- **Codex**: `[mcp_servers.rembr]` in `~/.codex/config.toml`, or the `codex-rembr` stdio bridge
- **Anything that speaks MCP**: streamable HTTP at `/mcp`

## Extra tenants / keys

The bootstrap script reuses one unclaimed, agent-created workspace per canonical
email and is configurable:

```bash
TENANT_NAME=team-a TENANT_EMAIL=team-a@example.com KEY_NAME=ci \
  node rembr-mcp/scripts/bootstrap-tenant.mjs \
  | docker compose exec -T postgres psql -U rembr -d rembr
```

Each successful run adds a new project-bound, non-expiring `agent_bootstrap`
credential without revoking an earlier key. A matching email already owned by a
claimed or non-agent tenant fails closed. Keys are stored as SHA-256 hashes; the
plaintext is printed once and never persisted.

## Upgrading an existing Compose volume

1. Back up `rembr-pgdata` and stop MCP/console writers.
2. Add independently generated `DB_APP_PASSWORD`, `API_KEY_SECRET`,
   `ADMIN_API_KEY`, `METRICS_SECRET` and `REMBR_CONSOLE_AUTH_TOKEN` values,
   plus a stable `PUBLIC_URL` and matching
   `OAUTH_AUDIENCE=${PUBLIC_URL}/mcp`, to `.env`. Do not reuse the database
   owner, JWT, API-key or console secrets. Keep the existing self-host API key
   as `REMBR_API_KEY`; legacy 32-character and current 64-character keys remain
   supported, so this upgrade does not require credential rotation.
3. Pull the reviewed release and run `docker compose run --rm
   rembr-db-bootstrap`. The runner is idempotent, connects with the owner only
   for migrations, applies the self-host authentication migration before MCP
   migration 030, rotates `rembr_app`, and fails before MCP starts if its role/RLS/function
   checks do not pass.
   The migration fails closed on case-insensitive email collisions and legacy
   or non-v2 Stripe customer IDs that require offline v2 re-encryption; resolve
   either condition before retrying.
   Existing OAuth grants are intentionally revoked because their resource
   audience cannot be inferred safely, so OAuth clients must reauthorise once.
4. Start MCP, verify `/health` for liveness and `/ready` for database-aware
   readiness, then perform a real agent bootstrap, store, recall, project-scope
   and tenant-isolation rehearsal before enabling remote traffic.

The owner password remains available only to PostgreSQL and the one-shot
bootstrap service. MCP connects as `rembr_app`; the console never receives a
database credential.

## Production notes

- Generate independent strong values for every secret in `.env`; never expose Postgres.
- Keep the owner and `rembr_app` passwords distinct. Re-run the bootstrap after
  intentional app-role rotation and audit database logins after each upgrade.
- The schema includes authentication, signup, OAuth, plan and tenant tables, so
  `rembr_app` keeps the complete application privileges those workflows need;
  elevated database functions remain explicitly allowlisted.
- MCP and console host ports bind loopback by default. For remote agents, place the MCP
  endpoint behind an authenticated TLS reverse proxy or deliberately set
  `REMBR_BIND_ADDRESS` with equivalent firewall controls.
- The console requires its own bearer token and defaults to read-only. Set
  `REMBR_CONSOLE_MODE=read-write` only when its create/delete controls are required.
- The engine exposes `/health` for process liveness, `/ready` for bounded
  dependency-aware readiness, and `/metrics` for Prometheus; set
  `METRICS_SECRET` in production.
- Back up the `rembr-pgdata` volume; memories, contexts, and snapshots all live in
  PostgreSQL.

### OSS test and dependency checks

Use Node.js 22.12+ or 24 for the development test runner. In `rembr-mcp`,
`npm run test:unit` runs without external services. `npm run test:integration`
requires a disposable PostgreSQL database with pgvector and a database owner
account that can create the isolated test databases and the `rembr_app` role:

```sh
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rembr_test npm run test:integration
```

Use a dedicated test PostgreSQL instance. The tests create their own fixtures
and schemas; the runtime workflow suites initialise separate `rembr_test_*`
databases from the OSS schema and migrations. Model responses are deterministic
test doubles, so no model endpoint, Stripe account or paid API key is required.
`npm test` runs both suites sequentially. CI runs both suites and audits all
production and development dependencies with `npm audit --audit-level=moderate`.
The server tool partition checks run in the unit suite; causal, temporal and
operational audit workflows run directly against PostgreSQL.
