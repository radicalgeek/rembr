# openclaw-rembr (`memory-rembr`)

Persistent, structured, cross-agent memory for [OpenClaw](https://openclaw.ai), backed by
[Rembr](https://github.com/radicalgeek/rembr) — an MCP-native memory service with
server-side embeddings, hybrid text + semantic search, temporal queries, and graph
reasoning, backed by PostgreSQL + pgvector.

There are two integration layers. They compose.

## Layer 1 — MCP registry (zero code)

Rembr is an MCP server; OpenClaw has a native MCP client registry. Register it:

```bash
# Hosted, API key (env-expanded — no literal secret in config):
openclaw mcp set rembr '{
  "url": "https://rembr.ai/mcp",
  "transport": "streamable-http",
  "headers": { "x-api-key": "${REMBR_API_KEY}" }
}'

# Or OAuth — Rembr supports Dynamic Client Registration, so no key at all:
openclaw mcp set rembr '{"url":"https://rembr.ai/mcp","auth":"oauth"}'
openclaw mcp login rembr
```

For self-hosted Rembr, use your instance's `/mcp` URL (the transport is always
`streamable-http`; Rembr has no stdio mode and needs PostgreSQL + pgvector behind it).

This gives agents Rembr's full consolidated tool surface — `memory`, `search`, `context`,
`snapshot`, and on capable plans the analytics tools (temporal search, causality tracing,
contradiction detection, memory graph).

**Visibility caveats**: `"minimal"` tool profiles hide MCP tools; `tools.deny:
["bundle-mcp"]` disables them; use per-server `toolFilter` to curate. Verify with
`openclaw mcp tools rembr`.

## Layer 2 — the `memory-rembr` plugin (memory slot)

This plugin makes Rembr the **memory backend** for OpenClaw's memory slot, implementing the
same contract as `memory-core` / `memory-lancedb`:

- **`memory_recall` / `memory_store` / `memory_forget`** tools, delegating to Rembr
- **Auto-recall** (`before_prompt_build`): relevant memories are injected as prepended
  context, with a hard 3-second timeout and a failure cooldown so an unreachable Rembr can
  never stall agent startup
- **Auto-capture** (`agent_end`): memory-worthy user statements ("remember…", "I prefer…",
  custom triggers) are persisted automatically, with per-session cursors and a per-turn cap
- **No embedding configuration** — Rembr embeds server-side, so the entire `embedding`
  block that other memory plugins require simply doesn't exist here
- **Safety**: recalled memories are framed as untrusted historical data; content that looks
  like prompt injection is refused at store time and at capture time

### Install

```json5
{
  plugins: {
    slots: { memory: "memory-rembr" },
    entries: {
      "memory-rembr": {
        enabled: true,
        config: {
          // url defaults to https://rembr.ai/mcp — set for self-hosted
          apiKey: "$KEY",
        },
      },
    },
  },
}
```

`apiKey` supports `${ENV_VAR}` expansion and falls back to the `REMBR_API_KEY` environment
variable, so config files never need a literal secret.

### Configuration reference

| Key | Default | Meaning |
|---|---|---|
| `url` | `https://rembr.ai/mcp` | Rembr MCP endpoint |
| `apiKey` | `$REMBR_API_KEY` | API key (`${ENV_VAR}` supported). Without one the plugin disables itself gracefully. |
| `autoRecall` | `true` | Inject relevant memories before each turn |
| `autoCapture` | `true` | Persist memory-worthy user statements after each turn |
| `recallLimit` | `5` | Max memories per recall |
| `minSimilarity` | `0.7` | Recall similarity threshold |
| `recallMaxChars` | `1000` | Max query length sent for recall |
| `captureMaxChars` | `500` | Max message length eligible for auto-capture |
| `customTriggers` | — | Extra literal phrases that mark a message memory-worthy |
| `defaultCategory` | `context` | Rembr category when none is detected (aliases like `fact`/`preference`/`decision` are normalized) |
| `timeoutMs` | `15000` | Request timeout |

There is **no `tenant` setting**: tenancy is bound to the API key. To scope memory per
project or board, issue a project-scoped Rembr API key and configure it per workspace.

### Coexistence with MEMORY.md

This plugin is *Rembr-augmented*: `MEMORY.md` and daily notes keep working as OpenClaw's
bootstrap context, while Rembr provides structured, durable, cross-workspace recall on top.
Memory-slot tools (`memory_recall` etc.) hit Rembr; file-based memory is untouched.

### Failure behavior

- Invalid config → plugin registers a warning service and stays disabled; the gateway boots.
- No API key → tools return configuration guidance instead of erroring.
- Rembr unreachable → recall enters a 60 s cooldown, hooks no-op, tools return readable
  errors. Agents keep working.

## Development

```sh
npm install        # includes `openclaw` as a devDependency for real SDK types
npm test           # vitest (54 tests, mocked fetch — no live server needed)
npm run build      # tsc --noEmit against the real plugin SDK types
```

The plugin ships TypeScript directly (`package.json#openclaw.extensions`), matching the
bundled memory plugins. The Rembr transport is a vendored ~150-line stateless MCP client
([rembr-client.ts](./rembr-client.ts)), shared logic with the
[opencode-rembr](../opencode-rembr) plugin. Architecture and roadmap: [PLAN.md](./PLAN.md).
