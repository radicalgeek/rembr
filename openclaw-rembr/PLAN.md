# OpenClaw × Rembr Memory Integration — Plan (v2)

*Rewritten 2026-06-10. Supersedes the earlier draft. All claims verified against the
OpenClaw source (extensions/memory-lancedb, docs.openclaw.ai/cli/mcp, /tools/plugin,
/concepts/memory) and the Rembr codebase in this repo.*

## 1. Objective

Make Rembr a first-class memory backend for [OpenClaw](https://openclaw.ai): a `memory-rembr`
plugin that owns the `plugins.slots.memory` slot, delegating storage and recall to a Rembr
MCP server — plus a zero-code MCP-registry path for the rest of Rembr's tool surface.

## 2. Corrections from the v1 draft

| v1 claim | Reality (verified) |
|---|---|
| "98 MCP tools across 12 categories" | Live surface is ~18–20 **consolidated** tools (core server: `memory`, `search`, `stats`, `context`, `snapshot`). 83 legacy names (`store_memory`, …) route through for compat. New code targets the consolidated tools with `operation` params. |
| Self-hosted via stdio (`node dist/index.js`) | **No stdio transport exists.** rembr-mcp is HTTP-only (stateless `POST /mcp`). Self-hosted instances also register as `streamable-http`, pointed at localhost; they need PostgreSQL + pgvector. |
| Hosted at `https://mcp.rembr.ai/mcp` | Hosted endpoint is **`https://rembr.ai/mcp`** (prod ingress host is `rembr.ai`; test is `test.rembr.ai`). |
| "MCP/REST API" | MCP only. No REST endpoints. |
| `tenant` config knob | Tenancy is **bound to the credential**, not a request parameter. Project scoping = project-scoped API keys. |
| Rembr needs batch ops, health endpoint, embedding pass-through | Top-N recall is one `search` call; `/health` exists; embeddings are **server-side** (pass-through neither exists nor is needed). All three "Rembr-side requirements" are already satisfied — open question 1 resolves to "Rembr owns embeddings". |
| Hooks `before_prompt_build` / `after_agent_reply` | `before_prompt_build` is **real** (returns `{ prependContext }`). The post-turn hook is **`agent_end`** (with `session_end` for cleanup). Verified in memory-lancedb source. |
| Memory slot contract = `memory_search` + `memory_get` | The bundled memory plugins declare `contracts.tools: ["memory_recall", "memory_store", "memory_forget"]` in their manifest. That trio is the contract to implement. |

The v1 architecture (external MCP server → memory-slot adapter; MCP registry first, plugin
second) was correct and is retained.

## 3. The verified OpenClaw plugin contract

From `extensions/memory-lancedb` (the reference memory-slot implementation):

- **Manifest** `openclaw.plugin.json`: `{ id, kind: "memory", contracts: { tools:
  ["memory_recall", "memory_store", "memory_forget"] }, configSchema (JSON Schema), uiHints }`.
- **Entry**: `export default definePluginEntry({ id, name, kind: "memory", configSchema,
  register(api) })` — `definePluginEntry` imported from `openclaw/plugin-sdk/plugin-entry`
  (resolved by the host at runtime; packages ship TypeScript directly via
  `package.json#openclaw.extensions: ["./index.ts"]`).
- **Tools**: `api.registerTool({ name, label, description, parameters: <TypeBox schema>,
  execute(toolCallId, params) → { content: [{type:"text",text}], details } }, { name })`.
- **Hooks**: `api.on("before_prompt_build", ev => ({ prependContext }))` for auto-recall;
  `api.on("agent_end", (ev, ctx) => …)` for auto-capture (per-session cursors so the same
  messages aren't re-captured); `api.on("session_end", …)` for cursor cleanup.
- **Lifecycle**: `api.registerService({ id, start, stop })`; invalid config → register a
  warning service and return (plugin disabled, gateway unaffected).
- **Safety conventions worth copying**: recall responses framed as *untrusted historical
  data*, prompt-injection screening before store, recall timeouts + cooldown so a slow
  memory backend can never stall agent startup.

## 4. Architecture (two layers, same shape as opencode-rembr)

```
┌────────────────────────────────────────────────────────────┐
│                    OpenClaw gateway                        │
│                                                            │
│  Layer 1 — MCP registry (zero code)                        │
│    openclaw mcp set rembr '{"url":"https://rembr.ai/mcp",  │
│      "transport":"streamable-http", …}'                    │
│    → full Rembr surface (memory/search/context/snapshot/   │
│      temporal/causality/contradictions…) for runtimes      │
│      that consume the registry                             │
│                                                            │
│  Layer 2 — memory-rembr plugin (memory slot)               │
│    plugins.slots.memory = "memory-rembr"                   │
│    • memory_recall / memory_store / memory_forget          │
│    • before_prompt_build → auto-recall (prependContext)    │
│    • agent_end → auto-capture (triggers, cursors, cap 3)   │
│    • session_end → cursor cleanup                          │
│    • vendored stateless Rembr MCP client (same ~150-line   │
│      client as opencode-rembr)                             │
└────────────────────────────────────────────────────────────┘
```

### Layer 1 recipe (works today)

```bash
# Hosted, API key:
openclaw mcp set rembr '{
  "url": "https://rembr.ai/mcp",
  "transport": "streamable-http",
  "headers": { "x-api-key": "${REMBR_API_KEY}" }
}'

# Hosted, OAuth (Rembr supports Dynamic Client Registration — no key in config):
openclaw mcp set rembr '{"url":"https://rembr.ai/mcp","auth":"oauth"}'
openclaw mcp login rembr
```

Caveats to document: `"minimal"` tool profiles hide MCP tools; `tools.deny: ["bundle-mcp"]`
disables them; use per-server `toolFilter` to curate. Self-hosted: same registration with a
localhost URL.

### Layer 2 — memory-rembr design

- **Embeddings**: none in the plugin. Rembr embeds server-side — the entire `embedding`
  config block that memory-lancedb needs simply disappears.
- **Tool mapping** (consolidated tools, not legacy aliases):
  - `memory_recall(query, limit?)` → `search` `{operation:"query", query, limit,
    min_similarity}`
  - `memory_store(text, importance?, category?)` → `memory` `{operation:"create", content,
    category, metadata:{importance, source}}` after injection screening; category aliases
    from the OpenClaw ecosystem (`preference`, `fact`, `decision`, `entity`, `other`) are
    normalized to Rembr's categories
  - `memory_forget(query?, memoryId?)` → by id: `memory` `{operation:"delete", id}`; by
    query: return candidates (Rembr search results include ids) and ask for an explicit
    `memoryId` — no fuzzy auto-delete of server-side memories
- **Auto-recall**: `before_prompt_build` → recall with a hard timeout (default 3 s) and a
  failure cooldown; inject as `prependContext` with untrusted-data framing. Never blocks
  startup: timeout/failure → no injection.
- **Auto-capture**: `agent_end` → extract user text, trigger-phrase + length heuristics
  (`remember`, `my name is`, `i prefer`, custom triggers), per-session cursors, max 3
  stores per turn, injection screening before store.
- **Config** (`plugins.entries.memory-rembr.config`): `url` (default `https://rembr.ai/mcp`),
  `apiKey` (supports `${ENV_VAR}` expansion; falls back to `REMBR_API_KEY`), `autoRecall`,
  `autoCapture`, `recallLimit` (5), `minSimilarity` (0.7), `recallMaxChars` (1000),
  `captureMaxChars` (500), `customTriggers`, `defaultCategory` (`context`), `timeoutMs`.
  No `tenant` knob (credential-bound); project scoping via project-scoped API keys.
- **Dual-memory coordination**: Rembr-augmented (v1's Option B) — MEMORY.md stays the
  bootstrap source of truth; Rembr adds structured, durable, cross-workspace recall on top.
  Rembr-primary/exclusive remain stretch goals.

## 5. Phases

- **Phase 0 — research & validation** ✅ *(this document; contract extracted from
  memory-lancedb source)*
- **Phase 1 — MCP registry recipe** ✅ *(2026-06)*: README with `openclaw mcp set` for API-key
  and OAuth paths + tool-profile caveats (see README.md, "Layer 1 — MCP registry"); live probe
  against a running instance still to be exercised.
- **Phase 2 — memory-rembr plugin** ✅ *(2026-06)*: manifest, entry, the three contract tools,
  auto-recall/auto-capture/session hooks, config with env expansion, vendored Rembr client,
  unit tests against a faked plugin API (54 passing), build green.
- **Phase 3 — deep integration** *(3–5 days — outstanding)*: skills for
  context/snapshot handoff around `sessions_spawn`, temporal debugging, graph reasoning,
  dreaming integration (`detect_contradictions` → stale-MEMORY.md sweeps). Board/AxiaCraft
  mapping stays, via project-scoped keys.
- **Hardening** *(1–2 days)*: live e2e against a Rembr instance, latency benchmark
  (<500 ms added bootstrap budget), fallback drills.

Total: **~8–12 days** (down from 11–16).

## 6. Risks (delta from v1)

v1's risk table stands. Two additions:

| Risk | Mitigation |
|---|---|
| `openclaw/plugin-sdk/*` is not published to npm (workspace-only) — third-party plugins typecheck against the `openclaw` host package | devDep on `openclaw` for types; runtime imports resolve in-host. Pin `compat.pluginApi` in the manifest. |
| Rembr search results are text blobs, not structured entries | Fine for recall/injection; `memory_forget`-by-query returns candidates instead of parsing ids heuristically. Structured MCP results from Rembr would be a nice later improvement. |

## 7. Success metrics

Unchanged from v1, minus the embedding-alignment item (moot), plus:

- [ ] `openclaw mcp add rembr --url https://rembr.ai/mcp` probe succeeds (Phase 1)
- [ ] memory-rembr owns the memory slot; `memory_recall`/`memory_store`/`memory_forget`
      round-trip against Rembr (Phase 2)
- [ ] Auto-recall injects within the 3 s budget or silently skips (Phase 2)
- [ ] Gateway boots and agents function normally with Rembr unreachable (Phase 2)
- [ ] Context/snapshot handoff skill works with `sessions_spawn` (Phase 3)
