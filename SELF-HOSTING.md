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

- Console: http://localhost:8080 (enter `REMBR_CONSOLE_AUTH_TOKEN` in the login control;
  set `CONSOLE_PORT` when that host port is already in use)
- MCP endpoint: http://localhost:3000/mcp (`x-api-key` header)
- Health: http://localhost:3000/health

### Embeddings

Search quality depends on an embedding provider. Three options:

- **Local Ollama** (default): start with `--profile ollama` and pull `nomic-embed-text`
  once. Fully local, no external calls.
- **An unauthenticated OpenAI-compatible endpoint** (for example a local LM Studio
  or trusted gateway): set `EMBEDDING_PROVIDER=openai-compatible` plus
  `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` in `.env`.
  The generic `openai-compatible` provider sends no credentials; use the Azure
  provider below for API-key-authenticated endpoints.
- **Azure OpenAI**: set `EMBEDDING_PROVIDER=azure` plus `AZURE_OPENAI_ENDPOINT`,
  `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`, and
  `AZURE_OPENAI_API_VERSION`. Azure uses deployment-based URLs and an `api-key`
  header rather than the OpenAI `/v1` + bearer shape, and accepts a native
  `dimensions` parameter — set `EMBEDDING_DIMENSIONS=768` so a `text-embedding-3-*`
  deployment returns vectors matching the default schema. For Azure text
  generation, set `TEXT_GENERATION_PROVIDER=azure` and `AZURE_OPENAI_TEXT_DEPLOYMENT`.

Embeddings are generated server-side — agents and the console only ever send text.

### Background maintenance

The maintenance worker is an opt-in Compose profile (`--profile maintenance`). It
always backfills missing and stale embeddings and deletes expired context
snapshots. The MCP server embeds new memories itself when they are stored, so the
worker is not needed for every new memory; it picks up memories left without an
embedding (for example after the inline attempts fail) and re-embeds stale ones,
even when all optional job flags are `false`. Its optional job types are relationship inference, contradiction
detection, memory evolution review (these can use an OpenAI-compatible chat
endpoint), and expired-memory cleanup. In this stack every optional job type
defaults to off; enable the ones you want explicitly in `.env`:

```bash
TEXT_GENERATION_PROVIDER=openai-compatible
LM_STUDIO_BASE_URL=http://your-openai-compatible-host:4000/v1
LM_STUDIO_MODEL=qwen3
MAINTENANCE_RELATIONSHIP_ENABLED=true
MAINTENANCE_CONTRADICTION_ENABLED=true
MEMORY_EVOLUTION_ENABLED=true
MEMORY_EVOLUTION_ASSESSMENT_ENABLED=true
MAINTENANCE_CLEANUP_ENABLED=true
```

The `LM_STUDIO_*` names are kept for backwards compatibility; the endpoint can be
OpenAI or any local/provider gateway that implements the OpenAI chat completions API.

- Relationship inference and contradiction detection add relationship records.
- Memory evolution is proposal-only. It records an audit decision (keep, rewrite,
  archive, supersede, or prune) and never changes the memory itself. Without
  `MEMORY_EVOLUTION_ASSESSMENT_ENABLED=true` it records `keep` without calling a model.
  `MEMORY_EVOLUTION_APPLY_ENABLED` is reserved and currently has no effect.
- Cleanup permanently deletes memories whose retention period has expired.

The worker binary itself runs a job type unless its flag is exactly `false`, so a
deployment that runs it outside this Compose file should set each flag explicitly.
For example, a historical import can keep embedding backfill active while leaving
relationship inference, contradiction detection, evolution, and cleanup disabled.

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

Set `TENANT_PLAN=pro` (or another supported plan: free, pro, team, business,
enterprise) to assign explicit plan limits to a new workspace. Set
`REQUIRE_NO_ACTIVE_KEYS=true` to fail when the tenant already holds an active
key. If `API_KEY_SECRET` is available, new keys use HMAC-SHA256; otherwise the
script retains legacy SHA-256 compatibility.

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
- The console can instead run in hosted session mode (`REMBR_CONSOLE_AUTH_MODE=session`),
  where each user signs in with their own API key and the console holds it in a
  bounded server-side session. `REMBR_API_KEY` and `REMBR_CONSOLE_AUTH_TOKEN` are then
  unused. Session mode is opt-in: put the console behind TLS, set
  `REMBR_CONSOLE_ALLOWED_ORIGINS` to its exact public origin, and see
  `rembr-console/README.md` for session lifetime and login-throttle settings.
- The engine exposes `/health` for process liveness, `/ready` for bounded
  dependency-aware readiness, and `/metrics` for Prometheus; set
  `METRICS_SECRET` in production.
- `RATE_LIMIT_DISABLED=true` bypasses all request quotas. Use it only on a trusted
  private deployment; the default is `false`.
- Back up the `rembr-pgdata` volume; memories, contexts, and snapshots all live in
  PostgreSQL.
