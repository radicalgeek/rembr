# claude-code-rembr (`rembr`)

Persistent, cross-session memory for [Claude Code](https://code.claude.com), backed by
[Rembr](https://github.com/radicalgeek/rembr). One plugin gives you:

- **The Rembr MCP server**, bundled: `memory`, `search`, `context`, `snapshot` tools
  available as `mcp__plugin_rembr_rembr__*` through a local stdio-to-HTTP bridge
- **First-prompt recall**: a `UserPromptSubmit` hook runs once per session. Specific prompts
  receive curated semantic matches. Vague or continuation prompts restore up to five memories
  from the newest prior same-workspace session. A specific search with no relevant result injects
  nothing. The exact injected block is also shown to the user
- **Auto-capture**: a `UserPromptSubmit` hook stores memory-worthy prompts ("remember…",
  "I prefer…") automatically
- **Session distillation**: an async `Stop` hook reads the new transcript lines since the
  last pass and uses a headless `claude -p` call to extract durable conclusions (decisions,
  root causes, verified fixes, preferences) into Rembr. No manual "remember" is needed.
  Only the main interactive thread is distilled: subagent turns are skipped, and
  `claude -p` runs are not distilled because the process exits before the async hook finishes
- **Skills**: `/rembr:setup`, `/rembr:remember`, and `/rembr:recall`
- **Zero npm dependencies**: hook scripts and the MCP bridge are plain Node ESM

## Install in Claude Desktop Code

Start a **Local** session in the **Code** tab. Open **+ > Plugins > Browse plugins**,
select **Rembr** from the registered marketplace, and install it **for you**.
Then send one prompt: `/rembr:setup`. The plugin opens a local masked form for
the Rembr endpoint and your personal key. It defaults to the hosted endpoint
`https://rembr.ai/mcp`; replace it with your own deployment's MCP endpoint
when self-hosting. It accepts any HTTPS endpoint, or HTTP on loopback for a local
deployment. The form verifies the credentials through a read-only call and
saves them in `~/.rembr/.env`. Start a fresh local Code session to activate its
MCP tools. Do not put the key in a chat prompt. Node.js must be available to
local Code sessions.

If the Rembr marketplace is not registered yet, add it from the manifest at this
repository's root, then install the plugin:

```bash
/plugin marketplace add radicalgeek/rembr
/plugin install rembr@rembr
```

Already installed an older version? Open **+ > Plugins > Manage plugins > Rembr**,
choose **Update now**, then send `/rembr:setup` if you have no working config.
Confirm **Rembr** appears in **+ > Plugins**, the `plugin:rembr:rembr` server
connects, and a read-only memory search works. Do not edit the installed plugin.

The terminal CLI reads the same user-scope installation. The plugin's MCP
bridge and hooks require both the endpoint and key in `~/.rembr/.env`.
Legacy `~/.rembr/config.json` and `REMBR_*` process variables cannot activate
an installed plugin against the wrong backend. Neither the remote connection
nor the setup form relies on Desktop's plugin `userConfig` dialog.

### Without the plugin (MCP only)

```bash
claude mcp add --transport http rembr https://rembr.ai/mcp --header "x-api-key: ${REMBR_API_KEY}"
```

This gives you the tools but no first-prompt recall, auto-capture, or skills.

## Optional behavior (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `REMBR_API_KEY` | None | Direct script compatibility only. Installed plugin components require `~/.rembr/.env`. |
| `REMBR_URL` | `https://rembr.ai/mcp` | Direct script compatibility only. Installed plugin components require `~/.rembr/.env`. |
| `REMBR_AUTO_RECALL` | `true` | Enable automatic first-prompt recall |
| `REMBR_AUTO_CAPTURE` | `true` | Store trigger-phrase prompts automatically |
| `REMBR_PROMPT_RECALL` | `true` | Route the first prompt to semantic recall or prior-session restoration |
| `REMBR_RECALL_LIMIT` | `10` | Candidate pool before the five-memory display cap |
| `REMBR_MIN_SIMILARITY` | `0.3` | Recall similarity threshold |
| `REMBR_TIMEOUT_MS` | `15000` | Hook request timeout in milliseconds |
| `REMBR_DISTILL` | `true` | Distill sessions into memories at each Stop |
| `REMBR_DISTILL_MODEL` | `haiku` | Model for the headless distiller call |
| `REMBR_DISTILL_MIN_RECORDS` | `3` | Debounce: skip passes with fewer new transcript records |
| `REMBR_DISTILL_TIMEOUT_MS` | `120000` | Distiller call timeout |
| `REMBR_CAPTURE_EXCLUDE` | None | Comma-separated cwd substrings that must never be distilled (e.g. a workspace whose content may not leave the machine) |
| `REMBR_STATE_DIR` | `~/.rembr` | Recall flags, cursor state, and capture log location |

## How it behaves

- **First prompt**: claims the session atomically, then follows the OpenCode routing contract.
  A specific prompt strips URLs, requests an expanded candidate pool, and curates by raw
  semantic similarity, freshness, workspace/client affinity, supersession, and diversity.
  A vague or continuation prompt restores the newest prior session in the same workspace.
  Semantic emptiness falls back to prioritized recent workspace context. At most five entries
  are injected, wrapped as untrusted historical data, and shown visibly through `systemMessage`.
- **Each prompt**: if the prompt contains a memory trigger ("remember", "my name is",
  "I prefer", "from now on", …) it's stored to Rembr with `autoCaptured: true` metadata.
  Content that looks like prompt injection is never stored. Capture remains active after the
  first-prompt recall flag has been claimed.
- **Session stop**: an async hook digests the transcript lines added since the previous
  pass (per-session cursor in `~/.rembr/cursors/`) and asks a headless `claude -p` session,
  acting as an observer, to extract only durable conclusions. Extracted memories are
  category-validated and secret-filtered before storing; `<private>…</private>` spans are
  stripped from the digest. The cursor advances only after a fully successful pass, so a
  failed distillation is retried at the next Stop. The child session runs with
  `REMBR_CAPTURE_DISABLE=1` so its own hooks never recall or capture recursively.
- **Failure**: if Rembr is unreachable, hooks emit `{}` and the session continues.
  The distiller logs each outcome in `~/.rembr/capture.log`.

## Development

```bash
npm install   # Install the test runner only
npm test
```

Hook logic lives in [scripts/lib.mjs](./scripts/lib.mjs) (shared, tested);
[user-prompt-submit.mjs](./scripts/user-prompt-submit.mjs) is a thin stdin/stdout wrapper.
The Rembr transport is the same stateless MCP `tools/call` pattern used by the
[opencode-rembr](../opencode-rembr) and [openclaw-rembr](../openclaw-rembr) plugins.
