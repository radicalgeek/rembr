# 🧠 Rembr MCP Server

**Context infrastructure for Recursive Language Models**

[![npm version](https://img.shields.io/npm/v/@rembr/mcp-server)](https://www.npmjs.com/package/@rembr/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> MIT proved RLM cuts AI costs 80%. Rembr makes it production-ready.

## What is Rembr?

Rembr is the **persistence layer** for the Recursive Language Model (RLM) pattern. While MIT's research demonstrated massive cost reductions through intelligent context management, RLM has a fatal flaw: **it forgets between sessions**.

Rembr solves this by providing:

- **20 consolidated MCP tools** (+ 82 legacy aliases) - Complete API for memory, context, snapshots, analytics, task management, RLM workflows
- **Semantic memory storage** - Store agent insights with automatic embeddings
- **Sub-50ms retrieval** - Fast hybrid semantic + text search
- **Cross-session persistence** - Knowledge compounds over time
- **Self-evolving maintenance** - Optional background jobs can rewrite, supersede, archive, and prune stale memories
- **MCP native** - Works with Claude Desktop, Cursor, Windsurf, and custom agents

## Quick Start

### Installation

```bash
npm install @rembr/mcp-server
```

### Configuration

Add to your MCP client config (Claude Desktop, VS Code, etc.):

```json
{
  "mcpServers": {
    "rembr": {
      "command": "npx",
      "args": ["@rembr/mcp-server"],
      "env": {
        "REMBR_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Usage

Once connected, your AI agent can:

**Store insights:**
```javascript
store_memory({
  content: "Auth flow uses JWT with 15min expiry",
  category: "facts",
  project: "backend-api"
})
```

**Retrieve context:**
```javascript
search_memory({
  query: "how does authentication work",
  limit: 10
})
```

**Knowledge compounds automatically** - Month 3 queries cost less than Month 1.

## MCP Tools

Tools are organized into 18 operation-based groups. Each tool accepts an `operation` parameter.
Legacy single-function tool names continue to work with a deprecation notice.

### Core Memory & Search
| Tool | Operations | Description |
|------|-----------|-------------|
| `memory` | create, get, update, delete, list, ingest | All memory CRUD + bulk document ingestion |
| `search` | query, smart, similar | Hybrid text + semantic search |
| `stats` | usage, embeddings, insights, predictions | Usage statistics and predictive analytics |

### Context & Snapshots
| Tool | Operations | Description |
|------|-----------|-------------|
| `context` | create, get, list, search, add_memory, delete | Context workspace management |
| `snapshot` | create, get, list, create_temporal, list_temporal | Immutable context snapshots for sub-agent handoff |

### Graph & Reasoning
| Tool | Operations | Description |
|------|-----------|-------------|
| `graph` | get, generate, insights, infer, compare, explore | Memory relationship graph + traversal |
| `contradictions` | detect | Find conflicting memories |
| `causality` | infer, trace, get, validate | Causal relationship analysis |

### Temporal & Audit
| Tool | Operations | Description |
|------|-----------|-------------|
| `temporal` | search, history | Point-in-time memory queries |
| `audit` | query, report, stats | Tamper-proof audit logs (SHA-256 chain) |
| `classify` | intent | Query intent classification |

### Task Management (RLM)
| Tool | Operations | Description |
|------|-----------|-------------|
| `manage_task` | create, get, update, delete, list, assign | Full task lifecycle |
| `task_state` | transition, valid_next, history | State machine transitions |
| `task_dependencies` | add, remove, blocked_by, blocking, cycles, critical_path | DAG with cycle detection |
| `task_search` | search, filter, aggregate | Full-text search + aggregations |
| `task_export` | export, import, validate | RLM portability (preserves acceptance criteria) |
| `task_analytics` | velocity, burndown, bottlenecks | Team productivity metrics |
| `task_handoff` | create, accept, reject, list_pending, get, history | Inter-agent task transfer |
| `task_iterations` | record, history, stuck_score, detect_stuck | Iteration tracking + stuck detection |
| `manage_acceptance_criteria` | add, validate, status, link_evidence, list, delete | Per-task acceptance criteria |
| `work_queue` | enqueue, bulk_enqueue, claim, complete, bulk_complete, fail, retry, stats, purge | Redis-style priority queue |

### RLM Session Management
| Tool | Operations | Description |
|------|-----------|-------------|
| `rlm_session` | create, get, list, update_status, export_state, import_state | Full RLM session lifecycle with state persistence |
| `rlm_iteration` | start, complete | Record iteration attempts |
| `rlm_evaluate_ac` | — | Evaluate acceptance criteria for a session |
| `rlm_regenerate` | — | Request plan regeneration when stuck |
| `plan_regeneration` | trigger, analyze_stuck, history, resolve | Structured unstuck mechanism |

### Multi-Server Architecture

Tools are partitioned by server type for specialized deployments:

```
SERVER_TYPE=core         → memory, search, stats, context, snapshot
SERVER_TYPE=rlm          → causality, temporal, classify, audit, task_*, rlm_*, work_queue
SERVER_TYPE=analytics    → graph, contradictions, context_analytics
SERVER_TYPE=contextpilot → budget, checkpoint, context_monitor
SERVER_TYPE=all          → everything (default)
```

See the [MCP Tools Reference](https://rembr.ai/docs/mcp-tools) for full parameter documentation.

## Architecture

```
YOUR AI AGENT
    ↓
┌─────────────────────────────┐
│     ★ REMBR LAYER ★         │
│                             │
│  STORE → INDEX → RETRIEVE   │
│                             │
│  MCP Native • Sub-50ms      │
└─────────────────────────────┘
    ↓
YOUR CODEBASE
(analyzed once, remembered forever)
```

### Key Features

- **Graph-Aware Search** - Semantic + text + relationship traversal
- **Auto Relationship Detection** - LLM-powered graph building
- **Context Workspaces** - Isolate memories by project
- **Snapshot Support** - Freeze context for sub-agent handoff
- **Multi-tenant** - Full tenant isolation with Row-Level Security
- **Fast** - Sub-50ms semantic search with HNSW indexing

### MCP Compatibility

Works with any Model Context Protocol client:
- ✅ Claude Desktop
- ✅ Claude Code (CLI)
- ✅ VS Code + MCP extension
- ✅ Cursor
- ✅ Custom agents via REST API

## ⚠️ OAuth Authentication Notes

**Database Connection Required**: The MCP server validates OAuth tokens by querying the database.

1. **DATABASE_URL format** - No trailing characters (especially `%`)
   ```
   postgresql://user:pass@host:port/db?connect_timeout=10
   ```

2. **Database accessibility** - Check with:
   ```bash
   kubectl logs -l app=rembr-mcp --tail=50
   ```

3. **VS Code OAuth Bug** - VS Code sends redirect URIs as client_id
   - See [../CRITICAL-VSCODE-OAUTH-FIX-2026-01-25.md](../CRITICAL-VSCODE-OAUTH-FIX-2026-01-25.md)

## Development

### Local Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with database credentials

# Build TypeScript
npm run build

# Run tests
npm test

# Run browser automation tests (Playwright)
npm run test:e2e

# Run browser tests on headless Linux (requires xvfb)
npm run test:e2e:headless
```

### Testing on Headless Linux Servers

Playwright UI tests require either a real X11 display or xvfb (X Virtual Framebuffer).

**Install xvfb:**
```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y xvfb

# Fedora/RHEL  
sudo dnf install -y xorg-x11-server-Xvfb

# Arch
sudo pacman -S xorg-server-xvfb
```

**Run tests with xvfb:**
```bash
npm run test:e2e:headless
```

The `test:e2e:headless` script automatically uses xvfb-run to create a virtual display.

**Alternative: Use Playwright Docker image**
```bash
docker run --rm -v $(pwd):/work -w /work \
  mcr.microsoft.com/playwright:v1.49.1-jammy \
  npm run test:e2e
```

See `tests/UI-TESTING.md` for complete testing documentation.

# Start development server
npm run dev
```

### Environment Variables

```bash
# Required (server refuses to start if missing)
DATABASE_URL=postgresql://user:pass@host:5432/dbname     # Or DB_HOST + DB_NAME + DB_USER + DB_PASSWORD
JWT_SECRET=<openssl rand -base64 32>                      # Min 32 characters
ADMIN_API_KEY=<openssl rand -hex 32>                      # RAD-45: Guards /admin/* endpoints (Header: X-Admin-Key)

# Recommended
METRICS_SECRET=<openssl rand -hex 32>                     # Guards /metrics endpoint (Bearer or X-Metrics-Token)

# Optional
OLLAMA_HOST=http://localhost:11434                        # Ollama embedding service
EMBEDDING_PROVIDER=ollama                                 # Or openai-compatible
EMBEDDING_BASE_URL=http://localhost:4000/v1               # OpenAI-compatible embeddings
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5      # Provider-specific embedding model
EMBEDDING_DIMENSIONS=768                                  # Vector dimensions
TEXT_GENERATION_PROVIDER=openai-compatible                # Optional relationship/memory evolution LLM
LM_STUDIO_BASE_URL=http://localhost:4000/v1               # OpenAI-compatible chat endpoint
LM_STUDIO_MODEL=qwen3                                     # Provider-specific chat model
MEMORY_EVOLUTION_APPLY_ENABLED=true                       # Let worker apply keep/rewrite/archive/supersede decisions
PORT=3000                                                 # HTTP server port
CORS_ORIGIN=http://localhost:8080                         # Allowed CORS origins (comma-separated)
LOG_LEVEL=info                                            # Log verbosity
NODE_ENV=production                                       # Environment (development|test|production)
PUBLIC_URL=http://localhost:3000                          # Public-facing URL
UI_BASE_URL=http://localhost:8080                         # UI/console URL
ENABLE_OPTIMIZATION=true                                  # Auto-optimization scheduler (default: true)
REDIS_HOST=localhost                                      # Redis host for caching
REDIS_PORT=6379                                           # Redis port
REDIS_PASSWORD=<secret>                                   # Redis password (if required)
DB_READ_HOST=<replica-host>                               # Read replica host (optional)
DB_READ_PASSWORD=<secret>                                 # Read replica password
```

For container deployments, inject secrets through your orchestrator's secret manager
and keep `.env` files out of version control.

## Deployment

### Self-hosted Docker Compose

```bash
cd ..
cp .env.example .env
docker compose --profile ollama up -d --build
```

### Manual container build

```bash
npm run build
docker build -t rembr-mcp:local .
docker run --env-file .env -p 3000:3000 rembr-mcp:local
```

### Health Checks

```bash
# Health endpoint
curl http://localhost:3000/health

# Metrics endpoint
curl -H "Authorization: Bearer $METRICS_SECRET" http://localhost:3000/metrics

# Logs
docker compose logs -f rembr-mcp rembr-maintenance-worker
```


**Common error patterns:**
- `Connection terminated due to connection timeout` - Too many parallel MCP calls, batch them sequentially
- `Connection reset by peer` - Client timeout during long operation
- `no unique or exclusion constraint` - Database schema mismatch, run migrations

## Database Schema

The schema is initialized via `manifests/06-postgres-init-db.yaml`.

### Core Tables

| Table | Purpose |
|-------|---------|
| `tenants` | Multi-tenant organizations |
| `users` | Individual users |
| `projects` | Project/workspace isolation |
| `api_keys` | API authentication |
| `memories` | Semantic memories with pgvector embeddings |
| `memory_embeddings` | Vector embeddings (768-dim) |
| `contexts` | Context workspaces |
| `context_snapshots` | Immutable context slices |
| `memory_relationships` | Knowledge graph edges |

### Memory Categories (12)

**Original (8):** facts, preferences, conversations, projects, learning, goals, context, reminders

**RLM-Optimized (4):** patterns, decisions, workflows, insights

### Row-Level Security

All tables enforce tenant isolation via PostgreSQL RLS policies. Every query is automatically scoped by `tenant_id`.

## Self-Hosting

### Requirements
- PostgreSQL 16+ with pgvector extension
- Ollama with nomic-embed-text model (or OpenAI API key)
- Node.js 18+
- Kubernetes cluster (or Docker Compose)

### Quick Start

```bash
git clone https://github.com/radicalgeek/rembr.git
cd rembr/rembr-mcp
cp .env.example .env
# Edit .env with your configuration
./build-and-deploy.sh
```

## Performance

| Operation | Average Latency |
|-----------|-----------------|
| Hybrid search | ~50ms |
| Semantic search | ~80ms |
| Graph traversal | ~120ms |
| Context search | ~30ms |
| Relationship detection | ~200ms/memory |
| Contradiction analysis | ~500ms/context |

Designed for 1M+ memories per tenant with horizontal scaling via read replicas.

## Pricing

| Plan | Memories | Searches/Day | Price |
|------|----------|--------------|-------|
| **Free** | 1,000 | 10,000 | £0 |
| **Pro** | 25,000 | 250,000 | £29/mo |
| **Team** | 250,000 | 2,500,000 | £149/mo |
| **Business** | Custom | Custom | Custom |

## Related Documentation

- [Repository Overview](../README.md) - Full stack architecture
- [Web Dashboard](../rembr-ui/README.md) - UI implementation
- [MCP Tools Reference](../docs/MCP-TOOLS-REFERENCE.md) - Complete API docs
- [RLM Patterns](../docs/rlm-patterns.md) - Implementation patterns

## Research

Rembr implements the Recursive Language Model pattern from:

**"Recursive Language Models for Task Decomposition"**  
*MIT, December 2024* (arXiv:2512.24601)

## License

ISC License - See LICENSE file for details.

---

**Last Updated:** January 26, 2026  
**Status:** Production (v1.2.0)  
**Maintainer:** Mark @ radicalgeek
