# MCP Tools Reference

> **Rembr MCP Server** — 83 tools across 15 categories  
> Protocol: Model Context Protocol (MCP) 2024-11-05  
> Auth: `x-api-key` header + session negotiation via `initialize`

---

## Quick Start

```json
{
  "mcpServers": {
    "rembr": {
      "url": "https://rembr.ai/mcp",
      "headers": { "x-api-key": "mb_live_YOUR_KEY" }
    }
  }
}
```

All tools are available after a standard MCP `initialize` handshake. The server returns a `mcp-session-id` header that must be passed on subsequent requests.

---

## Tool Categories

| # | Category | Count | Tools |
|---|----------|-------|-------|
| 1 | **Core Memory** | 6 | `store_memory`, `search_memory`, `list_memories`, `get_memory`, `update_memory`, `delete_memory` |
| 2 | **Enhanced Memory** | 5 | `find_similar_memories`, `filter_memories`, `batch_memories`, `set_memory_visibility`, `list_personal_memories` |
| 3 | **Search** | 3 | `enhanced_search`, `saved_searches`, `classify_query_intent` |
| 4 | **Context Management** | 4 | `create_context`, `list_contexts`, `search_context`, `add_memory_to_context` |
| 5 | **Snapshots & Temporal** | 10 | `create_snapshot`, `get_snapshot`, `list_snapshots`, `create_temporal_snapshot`, `list_temporal_snapshots`, `compare_snapshots`, `search_at_time`, `get_memory_history`, `snapshot_timeline`, `snapshot_diff`, `snapshot_nearest`, `snapshot_category_evolution` |
| 6 | **Graph & Relationships** | 5 | `get_memory_graph`, `generate_context_graph`, `infer_memory_relationships`, `get_memory_insights`, `generate_memory_insights` |
| 7 | **Contradictions** | 2 | `detect_contradictions`, `detect_memory_contradictions` |
| 8 | **Causal Reasoning** | 4 | `trace_causality`, `infer_causality`, `get_causal_links`, `validate_causal_link` |
| 9 | **Audit & Compliance** | 10 | `query_audit_log`, `generate_compliance_report`, `get_audit_stats`, `audit_health`, `audit_metrics`, `audit_evaluate_thresholds`, `audit_alerts`, `audit_anomaly_detect`, `audit_metrics_prometheus`, `gdpr` |
| 10 | **Analytics & Reporting** | 10 | `get_stats`, `get_embedding_stats`, `get_predictive_analytics`, `get_usage_analytics`, `get_performance_metrics`, `get_memory_growth`, `get_category_breakdown`, `get_pii_analytics`, `build_report`, `export_memories`, `get_context_insights` |
| 11 | **PII Detection** | 4 | `pii`, `pii_nlp_detect`, `pii_nlp_redact`, `pii_nlp_score` |
| 12 | **File Storage** | 5 | `upload_attachment`, `list_attachments`, `get_attachment_url`, `delete_attachment`, `get_storage_usage` |
| 13 | **RLM Integration** | 4 | `rlm_session`, `rlm_evaluate_ac`, `rlm_iteration`, `rlm_regenerate` |
| 14 | **Task Management & Work Queue** | 7 | `manage_task`, `task_state`, `task_dependencies`, `task_search`, `work_queue`, `plan_compaction`, `plan_regeneration` |
| 15 | **System** | 1 | `rembr-server` |

---

## 1. Core Memory

### `store_memory`
Store a new memory with optional category and metadata.

```
Required: content (string)
Optional: category, metadata (object), relevance_score (0.0–1.0), tags (string[])
```

**Categories:** `facts` `preferences` `conversations` `projects` `learning` `goals` `context` `reminders` `patterns` `decisions` `workflows` `insights`

**Example:**
```
store_memory(
  content="Our backend uses PostgreSQL 16 with pgvector for embeddings",
  category="projects",
  metadata={"project": "rembr", "area": "infrastructure"}
)
```

### `search_memory`
Hybrid search across memories. Default mode combines semantic embeddings (70%) + full-text (30%).

```
Required: query (string)
Optional: category, limit (1–50), min_similarity (0.0–1.0), search_mode, metadata_filter
search_mode: hybrid | semantic | text | phrase
```

### `list_memories`
List memories with pagination and optional filters.

```
Optional: category, limit, offset, sort_by (created_at|updated_at), sort_order (asc|desc)
```

### `get_memory`
Retrieve a single memory by UUID.

```
Required: memory_id (string)
```

### `update_memory`
Update an existing memory's content, category, metadata, or tags.

```
Required: memory_id (string)
Optional: content, category, metadata, relevance_score, tags
```

### `delete_memory`
Delete a memory by UUID.

```
Required: memory_id (string)
```

---

## 2. Enhanced Memory

### `find_similar_memories`
Find memories similar to a given memory using vector similarity.

```
Required: memory_id (string)
Optional: limit, min_similarity
```

### `filter_memories`
Advanced filtering with date ranges, metadata fields, sorting, and pagination.

```
Optional: category, tags, metadata_filter, created_after, created_before, sort_by, sort_order, limit, offset
```

### `batch_memories`
Bulk create, update, or delete memories in a single call.

```
Required: operation (create|update|delete), items (array)
```

### `set_memory_visibility`
Change a memory's visibility scope.

```
Required: memory_id, visibility (personal|shared|project)
```

### `list_personal_memories`
List only personal-visibility memories for the current user.

```
Optional: category, limit, offset
```

---

## 3. Search

### `enhanced_search`
Multi-strategy search with intent classification and relationship expansion.

```
Required: query (string)
Optional: strategies (array), limit, min_similarity, metadata_filter
```

### `saved_searches`
Save, execute, list, or delete named search queries.

```
Required: operation (save|execute|list|delete)
Optional: name, query, parameters
```

### `classify_query_intent`
Pre-classify a query to route to the optimal search strategy.

```
Required: query (string)
```

---

## 4. Context Management

### `create_context`
Create a logical grouping / workspace for organising memories.

```
Required: name (string)
Optional: description
```

### `list_contexts`
List all contexts for the current tenant.

### `search_context`
Search within a specific context using scoped hybrid search.

```
Required: context_id (string), query (string)
Optional: limit, min_similarity
```

### `add_memory_to_context`
Associate a memory with a context (many-to-many).

```
Required: memory_id (string), context_id (string)
```

---

## 5. Snapshots & Temporal

### `create_snapshot`
Create an immutable point-in-time capture of memories. Requires at least one matching memory.

```
Required: name (string)
Optional: query, context_id, ttl_hours, category
```

### `get_snapshot` / `list_snapshots`
Retrieve a snapshot by ID or list all snapshots with timeline metadata.

### `create_temporal_snapshot` / `list_temporal_snapshots`
Named snapshots optimised for fast temporal queries.

### `compare_snapshots`
Diff two snapshots with a context diff viewer showing additions, removals, and changes.

```
Required: snapshot_id_1 (string), snapshot_id_2 (string)
```

### `search_at_time`
Time-travel query: what did the memory store contain at a specific point in time?

```
Required: query (string), as_of_time (ISO 8601 timestamp)
Optional: category, limit
```

### `get_memory_history`
Full version history of a specific memory.

```
Required: memory_id (string)
```

### `snapshot_timeline`
Visualise snapshot history on a timeline with metadata.

### `snapshot_diff`
Detailed structural diff between two snapshots.

```
Required: snapshot_id_1, snapshot_id_2
```

### `snapshot_nearest`
Find the snapshot closest to a given timestamp.

```
Required: timestamp (ISO 8601)
```

### `snapshot_category_evolution`
Track category distribution changes across snapshots over time.

---

## 6. Graph & Relationships

### `get_memory_graph`
Build a relationship graph of memories within a context.

```
Required: context_id (string)
Optional: depth, min_relevance
```

### `generate_context_graph`
Generate an interactive context graph with cluster analysis.

### `infer_memory_relationships`
Auto-detect semantic relationships for a specific memory.

```
Required: memory_id (string)
```

### `get_memory_insights` / `generate_memory_insights`
Pattern analysis and deep insight generation across the memory graph.

```
Optional: analysis_type (patterns|relationships|usage|categories|domains)
```

---

## 7. Contradictions

### `detect_contradictions`
Find conflicting memories within a context.

```
Required: context_id (string)
Optional: min_confidence
```

### `detect_memory_contradictions`
Advanced cross-memory contradiction detection with confidence scoring.

```
Optional: min_confidence, contradiction_types (factual|temporal|semantic)
```

---

## 8. Causal Reasoning

### `trace_causality`
Trace causal reasoning chains from a memory. Critical for RLM debugging.

```
Required: memory_id (string)
Optional: max_depth, min_confidence
```

### `infer_causality`
Infer causal relationship between two memories.

```
Required: source_memory_id, target_memory_id
```

### `get_causal_links`
List all causal links for a memory.

```
Required: memory_id (string)
```

### `validate_causal_link`
Validate a proposed causal relationship.

```
Required: link_id (string)
```

---

## 9. Audit & Compliance

### `query_audit_log`
Query the tamper-resistant (hash-chained) audit trail with filters.

```
Optional: action, user_id, resource_type, start_time, end_time, limit
```

### `generate_compliance_report`
Generate SOC2/GDPR compliance audit report.

```
Optional: report_type, start_date, end_date
```

### `get_audit_stats`
Audit logging statistics and health metrics.

### `audit_health`
System health check for the audit subsystem.

### `audit_metrics`
Detailed audit metrics (event counts, latency, coverage).

### `audit_evaluate_thresholds`
Evaluate configurable alert thresholds and return violations.

### `audit_alerts`
Get or acknowledge audit alerts.

```
Optional: operation (list|acknowledge), alert_id
```

### `audit_anomaly_detect`
Anomaly detection on audit patterns (unusual access, timing, volume).

### `audit_metrics_prometheus`
Prometheus-format audit metrics for external monitoring.

### `gdpr`
GDPR operations: right to erasure, consent audit trail, data export (Article 20).

```
Required: operation (request_forget_me|export_data|log_consent|list_consents|check_retention)
Optional: user_id, resource_type, resource_id, consent_type
```

---

## 10. Analytics & Reporting

### `get_stats`
Overall memory count, category breakdown, search statistics.

### `get_embedding_stats`
Embedding pipeline health: pending count, success rate, average latency.

### `get_predictive_analytics`
Forecast memory growth and quality trends.

### `get_usage_analytics`
Per-tenant usage analytics (API calls, searches, storage).

### `get_performance_metrics`
Latency percentiles, throughput, error rates.

### `get_memory_growth`
Memory growth over time (daily/weekly/monthly).

### `get_category_breakdown`
Category distribution analysis.

### `get_pii_analytics`
PII detection analytics: scan counts, entity types found, redaction stats.

### `build_report`
Custom report builder with configurable metrics and date ranges.

```
Required: report_type (string)
Optional: start_date, end_date, metrics (array)
```

### `export_memories`
Bulk export memories in JSON or CSV format.

```
Optional: format (json|csv), category, start_date, end_date
```

### `get_context_insights`
Usage and relevance insights for contexts.

---

## 11. PII Detection

### `pii`
Multi-operation PII tool (detect, redact, audit, scan).

```
Required: operation (detect|redact|audit|scan)
Optional: content, memory_id, mode (mask|hash|label|remove)
```

### `pii_nlp_detect`
NLP-based PII entity detection — 21 entity types including email, phone, SSN, NINO, IBAN, NHS number, JWT, AWS keys.

```
Required: content (string)
Optional: sensitivity (low|medium|high)
```

### `pii_nlp_redact`
Redact detected PII from text using configurable modes.

```
Required: content (string)
Optional: mode (mask|hash|label|remove)
```

### `pii_nlp_score`
Privacy risk scoring for content.

```
Required: content (string)
```

---

## 12. File Storage

MinIO-backed attachment storage for memories.

### `upload_attachment`
Upload a file attachment to a memory.

```
Required: memory_id (string), filename (string), content (base64 string)
Optional: content_type
```

### `list_attachments`
List all attachments for a memory.

```
Required: memory_id (string)
```

### `get_attachment_url`
Get a signed download URL for an attachment.

```
Required: attachment_id (string)
```

### `delete_attachment`
Delete an attachment.

```
Required: attachment_id (string)
```

### `get_storage_usage`
Storage quota and usage per tenant.

---

## 13. RLM Integration

### `rlm_session`
Manage Recursive Language Model decomposition sessions.

```
Required: operation (create|get|update|list|close)
Optional: task_id, task_title, acceptance_criteria (array), initial_plan
```

### `rlm_evaluate_ac`
Evaluate acceptance criteria for an RLM task with evidence linking.

```
Required: session_id (string)
Optional: criterion_id, evidence
```

### `rlm_iteration`
Track iteration attempts with stuck detection (score 0–100).

```
Required: session_id (string), iteration_number (number)
Optional: status, output, error
```

Stuck detection scoring: plateau (+35pts), repeating errors (+25pts), high iteration count (+20pts), idle time (+20pts). Score ≥70 = stuck.

### `rlm_regenerate`
Trigger plan regeneration when a session is stuck.

```
Required: session_id (string)
Optional: reason_type (stuck_detection|manual|failure_threshold|timeout), new_plan
```

---

## 14. Task Management & Work Queue

### `manage_task`
Full task CRUD with state machine.

```
Required: operation (create|get|update|delete|list|assign)
Optional: title, description, status, assigned_to, priority, metadata
```

### `task_state`
Get or transition task state (pending → in_progress → blocked/completed/failed).

```
Required: task_id (string)
Optional: new_state, reason
```

### `task_dependencies`
DAG dependency management with cycle detection and critical path analysis.

```
Required: operation (add|remove|list|check_ready)
Optional: task_id, depends_on_task_id
```

### `task_search`
Search tasks with filters.

```
Optional: status, assigned_to, priority, query, limit, offset
```

### `work_queue`
Redis-backed distributed work queue for multi-agent workflows.

```
Required: operation (enqueue|claim|complete|fail|stats|bulk_enqueue|bulk_complete)
Optional: task_type, priority, payload, queue_name, agent_id, item_id
```

### `plan_compaction`
Compact memories when a tenant's plan is downgraded. Applies grace period using subscription end date.

```
Required: tenant_id (string)
Optional: target_plan
```

### `plan_regeneration`
Auto-regeneration of plans when an RLM session is stuck.

```
Required: session_id (string)
Optional: reason_type, new_plan
```

---

## 15. System

### `rembr-server`
Server info, health check, and capabilities advertisement.

---

## Authentication

| Method | Header | Notes |
|--------|--------|-------|
| API Key | `x-api-key: mb_live_...` | Recommended for agents |
| OAuth 2.0 | `Authorization: Bearer ...` | Claude Desktop (PKCE flow) |
| Admin | `X-Admin-Key: ...` | Admin-only endpoints |
| Session | `mcp-session-id: mcp_...` | Returned by `initialize` |

**Flow:**
1. `POST /mcp` with `initialize` payload → receive `mcp-session-id` in response headers
2. Include `mcp-session-id` on all subsequent tool calls

---

## Search Modes Reference

| Mode | Algorithm | Best for |
|------|-----------|----------|
| `hybrid` | 0.7 semantic + 0.3 text | Default — best general recall |
| `semantic` | Embeddings only | Conceptual similarity, paraphrases |
| `text` | Full-text (pg_trgm) | Exact keywords, IDs, proper nouns |
| `phrase` | Multi-word exact match | Quoted phrases, specific sequences |

---

## Memory Categories

| Category | Use for |
|----------|---------|
| `facts` | Objective information, data points |
| `preferences` | User/agent preferences and settings |
| `conversations` | Chat history, meeting notes |
| `projects` | Project-specific context and state |
| `learning` | Lessons learned, insights gained |
| `goals` | Objectives and success criteria |
| `context` | Session context, current state |
| `reminders` | Time-sensitive or action items |
| `patterns` | Recurring behaviours, code patterns, best practices |
| `decisions` | Decisions made and their rationale |
| `workflows` | Process definitions, deployment procedures |
| `insights` | Analytical conclusions, predictions |

---

## Changelog

| Version | Change |
|---------|--------|
| v1.12.0 | 83 tools, context checkpoints, engagement events, admin dashboard |
| v1.11.0 | PII schema in prod/test, smart compression, budget-aware search |
| v1.30.0 (staging) | Rate limiting fail-closed fix (Redis → in-process Map fallback) |
| v1.26.0 (staging) | Text search fix — pg_trgm index restored, all search modes working |
| v1.25.0 (staging) | Zod validation on all tools, unified auth middleware |

---

*Last updated: 2026-04-07*
