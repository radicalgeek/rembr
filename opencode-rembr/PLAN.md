# OpenCode × Rembr Memory Integration — Plan (v2)

*Rewritten 2026-06-10. Supersedes the 2026-05-29 draft. All claims below verified against
the OpenCode docs (opencode.ai/docs/plugins, /docs/mcp-servers), the Rembr codebase in this
repo, and prior-art OpenCode memory plugins.*

## 1. Objective

Make Rembr a first-class persistent memory layer for [OpenCode](https://opencode.ai) agents:
durable, cross-session, similarity-searchable memory backed by the Rembr MCP server.

## 2. What changed from the v1 draft

The v1 draft assumed two interfaces that don't exist:

1. **OpenCode has no `MemoryProvider` interface, config UI panels, or plugin marketplace.**
   Its extension surface is: (a) native **remote MCP server** registration in `opencode.json`,
   with `{env:VAR}` header substitution and automatic OAuth via Dynamic Client Registration
   (RFC 7591) on a 401; and (b) **plugins** — JS/TS modules (local files or npm packages)
   that receive `{ project, client, $, directory, worktree }` and return lifecycle hooks
   (`session.created`, `session.idle`, `session.compacted`, `tool.execute.before/after`,
   `chat.message`, `experimental.session.compacting`, …) and custom tools via the `tool`
   helper from `@opencode-ai/plugin`.
2. **Rembr has no REST API.** The server is MCP-protocol-only: stateless `POST /mcp`
   (post MCP-2026-07-28 migration), plus `/health`, `/metrics`, `/ping`. The tool surface is
   consolidated tools — `memory` (operations: create/get/update/delete/list/…), `search`
   (query/smart/similar), `context`, `snapshot`, etc. — with legacy names (`store_memory`,
   `search_memory`, …) routed for backwards compatibility. Auth: `x-api-key` header, OAuth
   Bearer, or JWT; scoping is tenant/project/user bound to the credential (the old
   `mcp_sessions` concept was removed in migration 026).

Two findings that **strengthen** the integration:

- **Rembr already supports Dynamic Client Registration** (`.well-known/oauth-authorization-server`
  advertises `registration_endpoint: /api/register`, PKCE S256, `authorization_code` +
  `refresh_token`). OpenCode's auto-OAuth should work against Rembr with zero manual key handling
  (`opencode mcp auth rembr`).
- **Embeddings are server-side** (OpenAI-compatible provider / Ollama, configurable). Clients send
  raw text. No embedding configuration in the plugin at all.

## 3. Prior art (the pattern to follow)

There is an established "memory plugin" pattern in the OpenCode ecosystem:

| Project | Pattern |
|---|---|
| [Mem0](https://docs.mem0.ai/integrations/opencode) | Two modes: MCP-only (remote MCP in `opencode.json`) or full plugin (chat-message hook injects memory context into the system prompt, compaction hook stores session state, pre/post-tool hooks, slash commands). |
| [Supermemory](https://github.com/supermemoryai/opencode-supermemory) | Session-start context injection (user profile + project memories + semantic matches), keyword-triggered auto-save ("remember", "save this"), smart compaction at 80% context, single `supermemory` tool with operations, `bunx … install` CLI. |
| [opencode-mem](https://github.com/tickernelz/opencode-mem) | Fully local vector DB variant of the same hook pattern. |
| [opencode-agent-memory](https://github.com/joshuadavidthomas/opencode-agent-memory) | Letta-style editable memory blocks on disk. |

Rembr's differentiators in this field: **self-hostable**, MCP-native (no proprietary REST API),
multi-tenant with project scoping, OAuth/DCR (no plaintext keys), and the wider tool surface
(contexts, snapshots, temporal/causality, contradiction detection) available to power users via
plain MCP registration.

## 4. Architecture (two layers)

```
┌──────────────────────────────────────────────────────────┐
│                     OpenCode agent                       │
│                                                          │
│  Layer 1 — native MCP registration (zero code)          │
│    opencode.json mcp.rembr → POST https://…/mcp          │
│    auth: OAuth (DCR) or x-api-key via {env:…}            │
│    → agent gets `memory`, `search`, `context`, … tools   │
│                                                          │
│  Layer 2 — `opencode-rembr` plugin (npm)                 │
│    • curated tools: rembr_remember / rembr_recall /      │
│      rembr_forget (embedded stateless MCP client)        │
│    • session-start recall: inject relevant memories      │
│    • auto-capture: persist session summary on            │
│      session.idle / compaction                           │
│    • health check + structured logging                   │
└──────────────────────────────────────────────────────────┘
```

Layer 1 ships today as documentation. Layer 2 is the deliverable of this plan.

### Layer 1 recipe (already works)

```json
{
  "mcp": {
    "rembr": {
      "type": "remote",
      "url": "https://rembr.ai/mcp",
      "headers": { "x-api-key": "{env:REMBR_API_KEY}" },
      "oauth": false
    }
  }
}
```

Or omit `headers`/`oauth` and run `opencode mcp auth rembr` to use OAuth + DCR.

### Layer 2 — plugin design

- **Package**: `opencode-rembr` (npm, TypeScript, ESM), installed via
  `"plugin": ["opencode-rembr"]` in `opencode.json`.
- **Rembr client**: minimal stateless MCP client over `fetch` — JSON-RPC `tools/call` to
  `POST /mcp`, accepts both `application/json` and `text/event-stream` responses, timeout +
  single retry, `x-api-key` or Bearer auth. No SDK dependency (the server is stateless; no
  session handshake required).
- **Tools** (curated; the full 18-tool surface stays behind Layer 1):
  - `rembr_remember(content, category?)` → `memory` / `create`
  - `rembr_recall(query, limit?)` → `search` / `query` (hybrid)
  - `rembr_forget(id)` → `memory` / `delete`
- **Hooks**:
  - first `chat.message` of a session → recall memories relevant to the prompt/project and
    inject as context (Mem0/Supermemory pattern; exact hook shape taken from
    `@opencode-ai/plugin` types at build time)
  - `session.idle` / `session.compacted` → if `autoRemember`, store session title + summary
    (`category: "conversations"`, metadata: sessionID, project dir); deduped per session
  - startup → `GET /health` check, structured log via `client.app.log`
- **Config** (env first, then file): `REMBR_URL` (default `https://rembr.ai/mcp`),
  `REMBR_API_KEY`; options in `.opencode/rembr.json` or `~/.config/opencode/rembr.json`:
  `autoRemember` (default true), `maxRecall` (default 10), `minSimilarity` (default 0.7),
  `category` defaults. **No `embedding_model` setting** — server-side concern.
- **Scoping**: OpenCode project → Rembr project via project-scoped API key (or tenant default).
  Finer namespacing via Rembr `context` tool is a power-user feature, not plugin config.

## 5. Phases

- **Phase 0 — research & validation** ✅ *(this document)*
- **Phase 1 — Layer 1 recipe** ✅ *(2026-06)*: README section with the `opencode.json` snippet,
  OAuth and API-key paths (see README.md, "Layer 1 — plain MCP registration").
- **Phase 2 — plugin v1** ✅ *(2026-06)*: package scaffold, stateless MCP client, the three
  curated tools, session-start recall, auto-capture, config loading, unit tests (vitest,
  mocked fetch — 32 passing), build green.
- **Phase 3 — polish & release** *(1–2 days — outstanding)*: keyword-triggered saves
  ("remember this…"), toast/status surface, npm publish (not yet published as of 2026-06-10),
  announce alongside the Mem0/Supermemory comparisons.

Total: **roughly 4–6 working days** (down from ~2 developer-weeks in v1, because Layer 1 is free
and there is no HTTP client/REST layer to build).

## 6. Acceptance criteria

- [ ] `opencode.json` MCP recipe works against a live Rembr instance with both API key and
      OAuth/DCR auth (no plaintext key in the workspace on the OAuth path).
- [ ] `"plugin": ["opencode-rembr"]` + `REMBR_API_KEY` gives an agent `rembr_remember` /
      `rembr_recall` / `rembr_forget` tools.
- [ ] A memory stored in one OpenCode session is recalled in a fresh session (restart in between).
- [ ] With `autoRemember`, an idle session persists a summary memory to Rembr automatically.
- [ ] Rembr unreachable → plugin logs a warning and OpenCode continues unaffected
      (tools return an error string; hooks no-op).
- [ ] Unit tests cover client request/response (JSON + SSE), config resolution, and
      auto-capture dedup.

## 7. Out of scope (v1)

- Generic MCP bridge for other editors (v1 draft's "Model B") — Layer 1 *is* that already.
- Shared Rembr TypeScript SDK with the OpenClaw effort — revisit only if OpenClaw lacks native
  MCP support; OpenCode needs no SDK.
- Exposing analytics/RLM tools (causality, contradictions, …) through the plugin — available
  via Layer 1 for users who want them.
