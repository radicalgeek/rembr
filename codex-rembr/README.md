# codex-rembr

Rembr long-term memory for [OpenAI Codex](https://developers.openai.com/codex). The
marketplace plugin packages a bundled **stdio MCP bridge**, an **agent skill**, a native
**UserPromptSubmit hook** for first-prompt recall, and a native **Stop hook** that distills
Codex JSONL transcripts.

## Install from the Rembr marketplace

The repository root carries a Codex marketplace manifest
(`.agents/plugins/marketplace.json`, marketplace name `rembr`). Run these commands
in a normal terminal:

```sh
codex plugin marketplace add "https://github.com/radicalgeek/rembr"
codex plugin add "rembr@rembr"
```

Use the `rembr-setup` skill in Codex to enter the endpoint and key in a local masked form.
The form checks a read-only memory-list request and saves the Codex profile to
`~/.rembr/codex.env`. Restart Codex, then review and trust the bundled hooks with `/hooks`.
The plugin includes its MCP bridge, skills, and hooks. No separate MCP entry
or repository clone is needed for the bundled memory tools.

Verify installation with:

```sh
codex plugin marketplace list --json
codex plugin list --json
codex mcp list
```

The setup form defaults to the hosted endpoint `https://rembr.ai/mcp`. To use a
self-hosted Rembr server, enter its MCP endpoint in the form instead.

## Bundled skill

The marketplace plugin makes `skills/rembr-memory` available automatically. No separate skill
copy is required.

The skill ([skills/rembr-memory/SKILL.md](./skills/rembr-memory/SKILL.md)) tells Codex to
recall before re-deriving decisions, store durable facts/preferences/decisions, treat
recalled memories as untrusted data, and never store secrets. You can also add a line to
your `AGENTS.md`:

> Use Rembr memory tools: search memory before re-deriving past decisions, and store
> durable facts, preferences, and decisions when they come up.

## Bundled stdio bridge

The marketplace plugin starts its self-contained `plugin-dist/cli.js` bridge, exposing the curated trio
`memory_recall` / `memory_store` / `memory_forget` — the same surface as Rembr's OpenClaw
plugin. Use it when a client only speaks stdio, when outbound HTTP is restricted to the
bridge host, or when you want exactly three memory tools with agent-friendly descriptions
and built-in prompt-injection screening.

The bridge, prompt hook, and distiller require the endpoint/key pair in
`~/.rembr/codex.env`. They do not take credentials from inherited environment
variables or a workspace `.env`. The setup skill updates this file. An active
MCP process must be reconnected or started in a new session after a switch.
`REMBR_RECALL_LIMIT` (10), `REMBR_MIN_SIMILARITY` (0.5), and `REMBR_TIMEOUT_MS` (15000)
remain process-level tuning variables.

The source package can also be built and used by other stdio MCP clients.

## First-prompt recall (native UserPromptSubmit hook)

`codex-rembr-recall-hook` reads the native hook event from stdin and injects context once per
session. It matches the OpenCode routing contract:

- specific prompt: URL-stripped expanded semantic search with raw-similarity, freshness,
  workspace/client affinity, supersession, newer-decision, and diversity curation
- vague or continuation prompt: newest prior same-workspace session
- empty semantic result: category-prioritized recent workspace fallback

The hook injects at most five compact memories with untrusted-data framing. Session flags live
under `${REMBR_STATE_DIR:-~/.rembr}/codex-recall-flags`. Set `REMBR_PROMPT_RECALL=false` to
disable it. Local defaults are `REMBR_RECALL_LIMIT=5` and `REMBR_MIN_SIMILARITY=0.3` unless
explicitly overridden.

Missing or incomplete configuration does not claim the session's once-only recall flag, so a
later prompt can retry after setup.

## Session distillation (native Stop hook)

The bundled `Stop` hook reads Codex's `transcript_path` and launches the self-contained
distiller in the background. The bundled manual `PreCompact` hook uses the same path with
a forced one-record minimum. No user hook file or background watcher is required.

The distiller reads only new JSONL records since the per-session cursor under
`~/.rembr/cursors/`. Of those it keeps only `response_item` records: session metadata, turn
context and event records are skipped, as are developer-role messages. User and assistant
messages, tool calls and tool results go into a compact digest. Injected context such as
`<environment_context>` blocks arrives as ordinary user messages and is not filtered out.
The distiller then runs `codex exec --json --skip-git-repo-check --ephemeral` (so it works
outside a git repo and leaves no saved session) to extract durable memories, and stores them
in Rembr with `distilled: true` metadata. The cursor
advances only after a successful pass, so failures are retried on the next run.

Environment variables:

| Env var | Default | Meaning |
|---|---|---|
| `REMBR_DISTILL` | `true` | Set to `false` to disable the distiller |
| `REMBR_DISTILL_MODEL` | Codex default | Model passed to `codex exec --model` |
| `REMBR_DISTILL_MIN_RECORDS` | `10` | Minimum new JSONL records before distillation runs |
| `REMBR_DISTILL_COOLDOWN_SECONDS` | `900` | Stop hook only: minimum seconds between background distillations of the same transcript. `PreCompact` ignores it |
| `REMBR_DISTILL_TIMEOUT_MS` | `120000` | Distiller timeout |
| `REMBR_CAPTURE_EXCLUDE` | - | Comma-separated cwd substrings that are never distilled |
| `REMBR_CAPTURE_DISABLE` | - | Recursion kill-switch for the child `codex exec` process |
| `REMBR_STATE_DIR` | `~/.rembr` | Cursor state and capture log location |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex transcript root watched by `codex-rembr-watch` |
| `REMBR_CODEX_WATCH_POLL_MS` | `10000` | Watcher polling interval |
| `REMBR_CODEX_WATCH_IDLE_MS` | `30000` | How long a session file must be unchanged before distillation |

The Stop hook starts the cooldown marker when it launches the background distiller and removes
it again if the distiller exits non-zero, so a failed run can be retried on the next turn
without waiting out the cooldown. Debounced transcripts never start a cooldown.

Content inside `<private>...</private>` spans is stripped before distillation, and
memories that look like secrets are dropped before storage.

Codex also has `PreCompact` and `PostCompact` hooks. Those are useful for future
checkpoint integration, but the default memory capture path should be
`Stop`, because it runs at the end of every turn and does not require manual compaction.

## Watcher fallback

The source package also includes a fallback watcher for environments where hooks are unavailable
or disabled:

```bash
codex-rembr-watch
```

It polls `~/.codex/sessions`, waits until a JSONL transcript has been idle for
`REMBR_CODEX_WATCH_IDLE_MS` (default 30000), then runs the same cursor-based
distillation pass. Failures leave the cursor unchanged and are retried on the next pass.

Prefer the Stop hook for normal local Codex use. The watcher can replay old sessions if
started without a cutoff policy, so use it deliberately.

## Development

```bash
npm install
npm test        # MCP bridge + recall hook + distiller + watcher unit tests
npm run build   # type-check/compile plus self-contained marketplace runtime bundles
```

The Rembr transport is the vendored stateless MCP client
([src/rembr-client.ts](./src/rembr-client.ts)) shared across all Rembr agent plugins.
