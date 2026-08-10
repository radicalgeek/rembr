# Getting Started with Rembr

> Connect your first MCP client in under 5 minutes.

---

## 1. Get your API key

Sign up at [rembr.ai](https://rembr.ai) — free tier includes **1,000 memories** and **10,000 searches/day** across **5 projects**. No credit card required.

Upgrade to **Pro** (£29/mo) for 25,000 memories, or **Team** (£149/mo) for 250,000 memories with full team collaboration.

Your API key looks like: `mb_live_...`

---

## 2. Connect your MCP client

### Claude Desktop

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "rembr": {
      "url": "https://rembr.ai/mcp",
      "headers": {
        "x-api-key": "mb_live_YOUR_KEY_HERE"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see Rembr tools available in the toolbar.

### Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "rembr": {
      "url": "https://rembr.ai/mcp",
      "headers": {
        "x-api-key": "mb_live_YOUR_KEY_HERE"
      }
    }
  }
}
```

### Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "rembr": {
      "url": "https://rembr.ai/mcp",
      "headers": {
        "x-api-key": "mb_live_YOUR_KEY_HERE"
      }
    }
  }
}
```

### VS Code + GitHub Copilot

Install the RLM integration package:

```bash
npm install -g @rembr/vscode
rembr-vscode-setup
```

This adds `@rlm` and `@ralph-rlm` custom agents, RLM skills, and memory integration to your Copilot workflow.

Then add Rembr as an MCP server in your VS Code settings or `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "rembr": {
      "url": "https://rembr.ai/mcp",
      "headers": { "x-api-key": "mb_live_YOUR_KEY_HERE" }
    }
  }
}
```

### Direct API / Custom agents

```bash
# The server is stateless — no initialize handshake or session header needed.
# Supply an untracked mode-0600 curl config containing the scoped x-api-key
# header; do not place the credential in shell history or process arguments.
# Store a memory in a single call:
curl -X POST https://rembr.ai/mcp \
  --config /run/secrets/rembr-curl.config \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"store_memory","arguments":{"content":"Hello from Rembr!","category":"facts"}},"id":1}'
```

---

## 3. Your first memory

In Claude Desktop, try:

> "Remember: my main project is called Moltbook. It's a task management tool built with Next.js and PostgreSQL."

Claude will call `store_memory` automatically. You'll see a confirmation.

Then open a **new conversation** and ask:

> "What's my main project?"

Claude will call `search_memory` and retrieve exactly what you stored — with no context in the current session.

---

## 4. Explore the dashboard

Visit [rembr.ai/dashboard](https://rembr.ai/dashboard) to:
- Browse all stored memories
- Search with the visual search interface
- View your memory graph (relationships between memories)
- Monitor usage and storage

---

## Key concepts

| Concept | What it is |
|---------|-----------|
| **Memory** | A single piece of stored information with content, category, and optional metadata |
| **Category** | One of 12 types (`facts`, `decisions`, `patterns`, `workflows`, etc.) used to organise memories |
| **Context** | A logical group of related memories (e.g. "Project Alpha") |
| **Snapshot** | An immutable point-in-time capture of memories, used for agent handoffs and temporal debugging |
| **Hybrid search** | Default search mode — combines semantic similarity (70%) + keyword matching (30%) for best results |
| **PII detection** | Built-in NLP engine that detects 21 types of personal information and can auto-redact |
| **File attachments** | Implemented but release-gated pending a verified production object store |
| **RLM session** | Recursive Language Model session — decomposition, iteration tracking, and stuck detection for autonomous agents |

---

## Common questions

**Q: Do my memories persist between sessions?**  
Yes. That's the whole point. Memories live in Rembr's database, not in the conversation context.

**Q: Can I use Rembr with multiple AI tools at once?**  
Yes. Same API key works everywhere. Store in Claude, retrieve in Cursor. The memory follows you.

**Q: How does search work?**  
By default, `search_memory` uses hybrid mode: 70% semantic (embedding similarity) + 30% keyword (full-text). You can override with `search_mode=text`, `semantic`, or `phrase`.

**Q: Is my data secure?**  
Memory access is authorised by tenant, project and user. PostgreSQL FORCE RLS
adds a database boundary for memories and selected MCP tables. Production
traffic uses TLS; verify at-rest encryption in the storage class/operator
configuration for your deployment. See [security docs →](/docs/security).

**Q: What's the rate limit?**  
All plans: 60 requests/minute per tenant (Redis-backed). You'll receive a `429` with `X-RateLimit-*` headers when limits are hit. Transport-layer rate limiting also applies to the `/mcp` endpoint.

**Q: Can I attach files to memories?**  
The attachment implementation is currently omitted from discovery and denied at
dispatch. It will be enabled only after the production object store, credentials,
network policy and recovery path have been configured and exercised together.

**Q: How does PII detection work?**  
Rembr has a built-in NLP engine that detects 21 types of personal information (email, phone, SSN, NINO, NHS numbers, etc.). Use `pii_nlp_detect` to scan content or `pii_nlp_redact` to automatically mask/remove PII.

---

## Next steps

- [MCP Tools Reference](/docs/mcp-tools) — all 102 tools documented across 15 categories
- [Agent Guide](/docs/agent-guide) — building AI agents with Rembr
- [Patterns Guide](/docs/patterns) — best practices and common patterns
- [Security](/docs/security) — authentication, PII detection, GDPR compliance

---

*Need help? Join the community at [discord.gg/rembr](https://discord.gg/rembr) or email support@rembr.ai*
