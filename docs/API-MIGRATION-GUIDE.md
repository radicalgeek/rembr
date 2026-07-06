# API Migration Guide — Tool Consolidation (42 → 41 Tools)

This guide covers breaking changes from the 42-tool monolith to the current 41-tool consolidated API.

---

## Overview

The tool consolidation (RAD-18, Phase 1) reduced the MCP surface from 42 verbose single-operation tools to 11 unified multi-operation tools plus 30 retained specific tools. This reduces attack surface, simplifies onboarding, and groups related operations logically.

**Total tool count: 41** *(README previously stated 42 — this was incorrect and has been corrected)*

---

## What Changed

### Removed Tools (replaced by unified equivalents)

| Old Tool (removed) | New Tool | Operation parameter |
|--------------------|----------|-------------------|
| `create_memory` | `memory` or `store_memory` | `operation="create"` |
| `retrieve_memory` | `memory` or `get_memory` | `operation="get"` |
| `update_memory_content` | `memory` or `update_memory` | `operation="update"` |
| `remove_memory` | `memory` or `delete_memory` | `operation="delete"` |
| `list_recent_memories` | `memory` or `list_memories` | `operation="list"` |
| `semantic_search` | `search` or `search_memory` | `operation="query"`, `search_mode="semantic"` |
| `text_search` | `search` or `search_memory` | `operation="query"`, `search_mode="text"` |
| `phrase_search` | `search` or `search_memory` | `operation="query"`, `search_mode="phrase"` |
| `smart_search` | `search` | `operation="smart"` |
| `find_similar` | `search` or `find_similar_memories` | `operation="similar"` |
| `create_context_group` | `context` or `create_context` | `operation="create"` |
| `get_context_group` | `context` | `operation="get"` |
| `list_context_groups` | `context` or `list_contexts` | `operation="list"` |
| `search_context_group` | `context` or `search_context` | `operation="search"` |
| `add_to_context` | `context` or `add_memory_to_context` | `operation="add_memory"` |
| `delete_context_group` | `context` | `operation="delete"` |
| `create_checkpoint` | `snapshot` or `create_snapshot` | `operation="create"` |
| `get_checkpoint` | `snapshot` or `get_snapshot` | `operation="get"` |
| `list_checkpoints` | `snapshot` or `list_snapshots` | `operation="list"` |
| `memory_graph` | `graph` or `get_memory_graph` | `operation="get"` |
| `context_graph` | `graph` | `operation="generate"` |
| `graph_insights` | `graph` | `operation="insights"` |
| `infer_relationships` | `graph` or `infer_memory_relationships` | `operation="infer"` |
| `compare_graph_snapshots` | `graph` | `operation="compare"` |
| `find_contradictions` | `contradictions` or `detect_contradictions` | `operation="detect"` |
| `memory_statistics` | `stats` or `get_stats` | `operation="usage"` |
| `embedding_statistics` | `stats` or `get_embedding_stats` | `operation="embeddings"` |
| `memory_insights_summary` | `stats` | `operation="insights"` |
| `predict_memory_usage` | `stats` or `get_predictive_analytics` | `operation="predictions"` |
| `temporal_query` | `temporal` or `search_at_time` | `operation="search"` |
| `memory_version_history` | `temporal` or `get_memory_history` | `operation="history"` |

---

## Migration Examples

### Storing a memory

**Before (old):**
```json
{
  "tool": "create_memory",
  "content": "Our DB is PostgreSQL 15",
  "category": "facts"
}
```

**After (option A — unified):**
```json
{
  "tool": "memory",
  "operation": "create",
  "content": "Our DB is PostgreSQL 15",
  "category": "facts"
}
```

**After (option B — specific, recommended):**
```json
{
  "tool": "store_memory",
  "content": "Our DB is PostgreSQL 15",
  "category": "facts"
}
```

---

### Searching memories

**Before (old — separate tools per mode):**
```json
{ "tool": "semantic_search", "query": "database configuration" }
{ "tool": "text_search", "query": "PostgreSQL" }
```

**After:**
```json
{ "tool": "search_memory", "query": "database configuration", "search_mode": "semantic" }
{ "tool": "search_memory", "query": "PostgreSQL", "search_mode": "text" }
```

Or using the unified tool:
```json
{ "tool": "search", "operation": "query", "query": "PostgreSQL", "search_mode": "text" }
```

---

### Context operations

**Before:**
```json
{ "tool": "create_context_group", "name": "Project Alpha" }
{ "tool": "add_to_context", "context_id": "...", "memory_id": "..." }
```

**After:**
```json
{ "tool": "create_context", "name": "Project Alpha" }
{ "tool": "add_memory_to_context", "context_id": "...", "memory_id": "..." }
```

---

### Snapshots

**Before:**
```json
{ "tool": "create_checkpoint", "name": "pre-deploy", "context_id": "..." }
```

**After:**
```json
{ "tool": "create_snapshot", "name": "pre-deploy", "context_ids": ["..."] }
```

Note: `context_id` (singular) → `context_ids` (array). Snapshots now support multiple contexts.

---

## Breaking Changes Summary

| Area | Breaking Change |
|------|----------------|
| Tool names | All 31 removed tools above — use new equivalents |
| `create_checkpoint` parameter | `context_id` → `context_ids` (array) |
| Tool count | Was 42 (documented incorrectly), now 41 |
| Auth header | `Authorization: Bearer` no longer accepted for API keys — use `x-api-key` (OAuth tokens still use `Authorization: Bearer`) |
| Session | ~~`mcp-session-id` header required after `initialize`~~ **Superseded (2026-06):** the server is now fully stateless — sessions were removed entirely and `mcp-session-id` headers are ignored |
| `store_memory` | Now requires `category` field (was optional before v1.25.0) |

---

## Authentication Changes

The API moved from `Authorization: Bearer {key}` to `x-api-key: {key}` for MCP tool calls.

**Before:**
```
Authorization: Bearer mb_live_...
```

**After:**
```
x-api-key: mb_live_...
```

**Stateless protocol (since June 2026):** the server no longer issues or accepts sessions.
No `initialize` handshake is required — call tools directly, authenticating every request:

```
POST /mcp
x-api-key: mb_live_...

{"jsonrpc":"2.0","method":"tools/call",...}
```

`initialize` is still answered for older clients but creates no state; any
`mcp-session-id` header is ignored, and GET/DELETE `/mcp` return 405. See
`rembr-mcp/MCP-2026-07-28-MIGRATION.md` for details.

---

## Non-Breaking Additions Since v1.0

The following tools were **added** after the initial consolidation and require no migration:

- `filter_memories` — advanced structured filtering with date ranges and metadata conditions
- `batch_memories` — bulk delete/update matching a filter
- `saved_searches` — save and reuse search filter templates
- `pii_nlp_detect` / `pii_nlp_redact` / `pii_nlp_score` — NLP-based 21-type PII detection
- `snapshot_timeline` / `snapshot_diff` / `snapshot_nearest` / `snapshot_category_evolution`
- `audit_health` / `audit_metrics` / `audit_evaluate_thresholds` / `audit_alerts` / `audit_anomaly_detect` / `audit_metrics_prometheus`
- `rlm_session` / `rlm_evaluate_ac` / `rlm_iteration` / `rlm_regenerate`
- `work_queue` — multi-agent Redis-backed task queue
- `manage_task` / `task_state` / `task_dependencies` / `task_search` / `task_analytics` / `task_export`
- `gdpr` — right to erasure, consent trail, data export
- `upload_attachment` / `list_attachments` / `get_attachment_url` / `delete_attachment` / `get_storage_usage`
- `get_usage_analytics` / `get_performance_metrics` / `get_memory_growth` / `get_category_breakdown` / `get_pii_analytics` / `build_report` / `export_memories`
- `context_analytics` / `context_monitor` / `checkpoint` / `budget` / `causality` / `compression`

---

## Support

If you encounter unexpected 400/404 responses after migrating, check:
1. Tool name matches the new API (see table above)
2. `x-api-key` header is used for API keys (`Authorization: Bearer` for OAuth tokens)
3. `category` field is included on `store_memory` calls

---

*Last updated: 2026-06-10 (stateless protocol migration)*
