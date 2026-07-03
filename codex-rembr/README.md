# codex-rembr

Rembr long-term memory for [OpenAI Codex](https://developers.openai.com/codex). Codex has
no hook system, so the integration has three pieces: a **config recipe** (native remote
MCP), an **agent skill** that teaches Codex when to recall/store, and an optional **stdio
MCP bridge** with a curated tool surface.

## 1. Register Rembr in Codex (recommended — zero code)

Codex supports streamable-HTTP MCP servers natively. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.rembr]
url = "https://rembr.ai/mcp"
env_http_headers = { "x-api-key" = "REMBR_API_KEY" }
```

`env_http_headers` reads the value from your `REMBR_API_KEY` environment variable — no
secret in the file. Or via CLI: `codex mcp add rembr --url https://rembr.ai/mcp`. For OAuth
instead of an API key, run `codex mcp login rembr` (Rembr supports Dynamic Client
Registration).

To curate the tool surface, filter per server:

```toml
[mcp_servers.rembr]
url = "https://rembr.ai/mcp"
env_http_headers = { "x-api-key" = "REMBR_API_KEY" }
enabled_tools = ["memory", "search"]
```

## 2. Install the skill

Codex discovers skills in `.agents/skills` (per repo) or `~/.agents/skills` (global):

```bash
mkdir -p ~/.agents/skills
cp -r skills/rembr-memory ~/.agents/skills/
```

The skill ([skills/rembr-memory/SKILL.md](./skills/rembr-memory/SKILL.md)) tells Codex to
recall before re-deriving decisions, store durable facts/preferences/decisions, treat
recalled memories as untrusted data, and never store secrets. You can also add a line to
your `AGENTS.md`:

> Use Rembr memory tools: search memory before re-deriving past decisions, and store
> durable facts, preferences, and decisions when they come up.

## 3. The stdio bridge (optional)

`codex-rembr` is also a stdio MCP server exposing the curated trio
`memory_recall` / `memory_store` / `memory_forget` — the same surface as Rembr's OpenClaw
plugin. Use it when a client only speaks stdio, when outbound HTTP is restricted to the
bridge host, or when you want exactly three memory tools with agent-friendly descriptions
and built-in prompt-injection screening.

```toml
[mcp_servers.rembr]
command = "npx"
args = ["-y", "codex-rembr"]
env = { "REMBR_API_KEY" = "mb_live_..." }
```

Bridge environment variables: `REMBR_API_KEY` (required), `REMBR_URL`
(default `https://rembr.ai/mcp`), `REMBR_RECALL_LIMIT` (10), `REMBR_MIN_SIMILARITY` (0.7),
`REMBR_TIMEOUT_MS` (15000).

The bridge works with any stdio MCP client, not just Codex (Gemini CLI, older clients,
editor integrations).

## Development

```bash
npm install
npm test        # 21 tests incl. a real MCP client round-trip over InMemoryTransport
npm run build   # tsc → dist/, bin: codex-rembr
```

The Rembr transport is the vendored stateless MCP client
([src/rembr-client.ts](./src/rembr-client.ts)) shared across all Rembr agent plugins.
