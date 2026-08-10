# Rembr MCP API Migration Guide

**Tool Consolidation: 41 tools → 18 operation-based tools**

This guide helps you migrate from the legacy individual tool names to the new consolidated tool API.

---

## Is Migration Required?

**No — your existing integrations continue to work.**

All legacy tool names are preserved as backward-compatible aliases. They route to the correct consolidated tool and return the same responses. A deprecation warning is injected into the response text so you know which new tool to use.

Migration is recommended to:
- Reduce token usage (fewer tool names in context)
- Benefit from pagination metadata and new operations
- Avoid future breaking changes when legacy aliases are eventually removed

---

## Quick Reference

### Memory Operations

| Legacy Tool | New Tool | Operation |
|-------------|----------|-----------|
| `store_memory` | `memory` | `operation: "create"` |
| `get_memory` | `memory` | `operation: "get"` |
| `update_memory` | `memory` | `operation: "update"` |
| `delete_memory` | `memory` | `operation: "delete"` |
| `list_memories` | `memory` | `operation: "list"` |
| `list_personal_memories` | `memory` | `operation: "list_personal"` |
| `set_memory_visibility` | `memory` | `operation: "set_visibility"` |
| `ingest_document` | `memory` | `operation: "ingest"` |

### Search

| Legacy Tool | New Tool | Operation |
|-------------|----------|-----------|
| `search_memory` | `search` | `operation: "query"` |
| `enhanced_search` | `search` | `operation: "smart"` |
| `find_similar_memories` | `search` | `operation: "similar"` |

### Statistics & Analytics

| Legacy Tool | New Tool | Operation |
|-------------|----------|-----------|
| `get_stats` | `stats` | `operation: "usage"` |
| `get_embedding_stats` | `stats` | `operation: "embeddings"` |
| `get_memory_insights` | `stats` | `operation: "insights"` |
| `generate_memory_insights` | `stats` | `operation: "generate_insights"` |
| `get_predictive_analytics` | `stats` | `operation: "predictions"` |

### Context Management

| Legacy Tool | New Tool | Operation |
|-------------|----------|-----------|
| `list_contexts` | `context` | `operation: "list"` |
| `create_context` | `context` | `operation: "create"` |
| `search_context` | `context` | `operation: "search"` |
| `add_memory_to_context` | `context` | `operation: "add_memory"` |

### Snapshots

| Legacy Tool | New Tool | Operation |
|-------------|----------|-----------|
| `create_snapshot` | `snapshot` | `operation: "create"` |
| `get_snapshot` | `snapshot` | `operation: "get"` |
| `list_snapshots` | `snapshot` | `operation: "list"` |
| `create_temporal_snapshot` | `snapshot` | `operation: "create_temporal"` |
| `list_temporal_snapshots` | `snapshot` | `operation: "list_temporal"` |

### Graph & Reasoning

| Legacy Tool | New Tool | Operation |
|-------------|----------|-----------|
| `get_memory_graph` | `graph` | `operation: "get"` |
| `generate_context_graph` | `graph` | `operation: "generate"` |
| `get_context_insights` | `graph` | `operation: "insights"` |
| `infer_memory_relationships` | `graph` | `operation: "infer"` |
| `compare_snapshots` | `graph` | `operation: "compare"` |
| `detect_contradictions` | `contradictions` | `operation: "detect"` |
| `detect_memory_contradictions` | `contradictions` | `operation: "detect"` |
| `infer_causality` | `causality` | `operation: "infer"` |
| `trace_causality` | `causality` | `operation: "trace"` |
| `get_causal_links` | `causality` | `operation: "get"` |
| `validate_causal_link` | `causality` | `operation: "validate"` |

### Temporal & Audit

| Legacy Tool | New Tool | Operation |
|-------------|----------|-----------|
| `search_at_time` | `temporal` | `operation: "search"` |
| `get_memory_history` | `temporal` | `operation: "history"` |
| `query_audit_log` | `audit` | `operation: "query"` |
| `generate_compliance_report` | `audit` | `operation: "report"` |
| `get_audit_stats` | `audit` | `operation: "stats"` |
| `classify_query_intent` | `classify` | `operation: "intent"` |

---

## Before / After Examples

### Storing a memory

**Before (legacy):**
```
store_memory({
  content: "Deployed v2.3.1 with hot-fix for auth token expiry",
  category: "decisions",
  project: "backend-api"
})
```

**After (consolidated):**
```
memory({
  operation: "create",
  content: "Deployed v2.3.1 with hot-fix for auth token expiry",
  category: "decisions",
  metadata: { project: "backend-api" }
})
```

---

### Searching memories

**Before:**
```
search_memory({ query: "authentication token", limit: 10 })
```

**After:**
```
search({ operation: "query", query: "authentication token", limit: 10 })
```

---

### Creating a context

**Before:**
```
create_context({ name: "sprint-42", description: "Sprint 42 work" })
```

**After:**
```
context({ operation: "create", name: "sprint-42", description: "Sprint 42 work" })
```

---

## New Tools (No Legacy Equivalent)

These tools are new in this release and have no legacy alias:

| Tool | Description |
|------|-------------|
| `manage_task` | Task lifecycle (create/get/update/delete/list/assign) |
| `task_state` | State machine transitions with history |
| `task_dependencies` | DAG management with cycle detection |
| `task_search` | Full-text search + aggregations |
| `task_export` | Export/import tasks with acceptance criteria |
| `task_analytics` | Velocity, burndown, bottleneck analysis |
| `task_handoff` | Inter-agent task transfer |
| `task_iterations` | Iteration recording + stuck detection |
| `manage_acceptance_criteria` | Per-task acceptance criteria |
| `work_queue` | Priority queue (enqueue/claim/complete/bulk ops) |
| `rlm_session` | RLM session lifecycle + state persistence |
| `rlm_iteration` | RLM iteration tracking |
| `rlm_evaluate_ac` | Evaluate acceptance criteria for a session |
| `rlm_regenerate` | Request plan regeneration |
| `plan_regeneration` | Structured unstuck mechanism |

---

## Pagination Metadata

All list and search operations now return pagination metadata:

```json
{
  "items": [...],
  "metadata": {
    "returned": 10,
    "total_available": 487,
    "execution_time_ms": 45,
    "has_more": true,
    "suggested_filters": ["category: 'facts'"]
  }
}
```

This is additive — existing code that ignores the `metadata` field continues to work unchanged.

---

## Multi-Server Deployment (New)

Tools are now partitioned by server type for high-volume deployments:

```bash
# Install and build the exact lockfile once, then use the local runtime.
npm ci
npm run build

# Core memory operations only
SERVER_TYPE=core npm start

# RLM + task management tools only  
SERVER_TYPE=rlm npm start

# All tools (default, same as before)
SERVER_TYPE=all npm start
```

Single-server deployments don't need to change anything — `SERVER_TYPE=all` is the default.

---

## Timeline

Legacy tool names are **not being removed** in this release. They will continue to work indefinitely while we collect migration feedback. A removal timeline will be communicated at least 90 days in advance.
