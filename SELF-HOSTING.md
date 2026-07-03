# Self-Hosting Rembr

Run the full Rembr memory engine plus a web console on your own hardware. The self-hosted
stack is the same multi-tenant engine that powers rembr.ai, bootstrapped with a single
default tenant — no login system, no billing, no feature flags.

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
cp .env.example .env          # set JWT_SECRET and POSTGRES_PASSWORD

# 1. Start the database and engine (add --profile ollama for local embeddings)
docker compose --profile ollama up -d --build
docker compose exec ollama ollama pull nomic-embed-text

# 2. Create your tenant + API key (printed once — save it)
node rembr-mcp/scripts/bootstrap-tenant.mjs \
  | docker compose exec -T postgres psql -U rembr -d rembr

# 3. Put the printed key in .env as REMBR_API_KEY, then start the console
docker compose up -d rembr-console
```

- Console: http://localhost:8080
- MCP endpoint: http://localhost:3000/mcp (`x-api-key` header)
- Health: http://localhost:3000/health

### Embeddings

Search quality depends on an embedding provider. Two options:

- **Local Ollama** (default): start with `--profile ollama` and pull `nomic-embed-text`
  once. Fully local, no external calls.
- **Any OpenAI-compatible endpoint**: set `EMBEDDING_PROVIDER=openai-compatible` plus
  `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` in `.env`.

Embeddings are generated server-side — agents and the console only ever send text.

## Connecting agents

Your self-hosted endpoint works with every Rembr integration — point them at
`http://your-host:3000/mcp` with your API key:

- **Claude Code**: the `rembr` plugin (`claude-code-rembr/`) — set `REMBR_URL` + `REMBR_API_KEY`
- **OpenCode**: `opencode-rembr` plugin, or a remote MCP entry in `opencode.json`
- **OpenClaw**: `memory-rembr` memory-slot plugin (`openclaw-rembr/`)
- **Codex**: `[mcp_servers.rembr]` in `~/.codex/config.toml`, or the `codex-rembr` stdio bridge
- **Anything that speaks MCP**: streamable HTTP at `/mcp`

## Extra tenants / keys

The bootstrap script is idempotent per email and configurable:

```bash
TENANT_NAME=team-a TENANT_EMAIL=team-a@example.com KEY_NAME=ci \
  node rembr-mcp/scripts/bootstrap-tenant.mjs \
  | docker compose exec -T postgres psql -U rembr -d rembr
```

Keys are stored as SHA-256 hashes; the plaintext is printed once and never persisted.

## Production notes

- Set strong values for `JWT_SECRET` and `POSTGRES_PASSWORD`; never expose Postgres
  publicly.
- The console has no authentication by design (single-tenant) — keep it on a trusted
  network or behind your own reverse proxy auth.
- The engine exposes `/health` (liveness) and `/metrics` (Prometheus; set
  `METRICS_SECRET` in production).
- Back up the `rembr-pgdata` volume; memories, contexts, and snapshots all live in
  PostgreSQL.
