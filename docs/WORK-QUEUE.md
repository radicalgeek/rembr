# Work Queue & Agent Handoff

**Rembr Multi-Agent Work Queue**  
**Last Updated**: February 2026

---

## Overview

The work queue provides a **persistent, priority-ordered task queue** for orchestrating work across multiple agents. It supports:

- **Priority scheduling** — critical > high > normal > low, FIFO within each tier
- **Atomic claim** — `FOR UPDATE SKIP LOCKED` prevents two agents claiming the same item
- **Lease timeouts** — claimed items expire and become re-claimable if the agent crashes
- **Agent handoff payloads** — structured context passed between agents at completion
- **Dead-letter queue** — items exceeding `max_attempts` move to `dead_letter` status
- **Idempotency keys** — prevent duplicate enqueue on retry
- **Queue statistics** — pending/claimed/completed/failed counts, age, avg completion time

---

## Task Lifecycle

```
enqueue()
    │
    ▼
 pending
    │
    ├─ claim() ──────────────► claimed
    │                              │
    │                    ┌─────────┴─────────┐
    │                complete()           fail()
    │                    │                   │
    │                    ▼                   ▼
    │               completed            failed ──(attempts < max)──► pending
    │                                       │
    │                                 (attempts >= max)
    │                                       │
    │                                       ▼
    │                                  dead_letter
    │                                       │
    └──────────────── retry() ◄─────────────┘
```

---

## Quick Start

### Enqueue a task

```json
{
  "tool": "work_queue",
  "arguments": {
    "operation": "enqueue",
    "queue_name": "analysis",
    "task_type": "cluster_memories",
    "priority": "high",
    "payload": { "context_id": "ctx-abc123", "algorithm": "DBSCAN" },
    "handoff": {
      "summary": "Cluster memories in context abc123",
      "instructions": "Use DBSCAN with min_cluster_size=5. Report cluster labels.",
      "context": { "previous_step": "embedding_complete" }
    },
    "max_attempts": 3,
    "idempotency_key": "cluster-abc123-2026-02-27"
  }
}
```

### Claim the next task

```json
{
  "tool": "work_queue",
  "arguments": {
    "operation": "claim",
    "queue_name": "analysis",
    "agent_id": "agent-analyst-01",
    "lease_seconds": 300
  }
}
```

**Response:**
```json
{
  "result": {
    "item": {
      "id": "item-uuid",
      "queue_name": "analysis",
      "task_type": "cluster_memories",
      "priority": "high",
      "status": "claimed",
      "payload": { "context_id": "ctx-abc123" },
      "handoff": { "summary": "Cluster memories...", "instructions": "..." },
      "attempt_count": 1,
      "claimed_by": "agent-analyst-01"
    },
    "lease_expires_at": "2026-02-27T07:35:00Z"
  }
}
```

### Complete with handoff

```json
{
  "tool": "work_queue",
  "arguments": {
    "operation": "complete",
    "item_id": "item-uuid",
    "agent_id": "agent-analyst-01",
    "handoff": {
      "summary": "Clustering complete — 7 clusters found",
      "context": { "cluster_ids": ["c1", "c2", "c3", "c4", "c5", "c6", "c7"], "outliers": 3 },
      "memory_ids": ["mem-result-001"],
      "instructions": "Review cluster c3 — it contains contradictory memories",
      "target_agent_type": "reviewer"
    }
  }
}
```

### Report failure

```json
{
  "tool": "work_queue",
  "arguments": {
    "operation": "fail",
    "item_id": "item-uuid",
    "agent_id": "agent-analyst-01",
    "failure_reason": "Embedding model timeout after 3 retries"
  }
}
```

If `attempt_count >= max_attempts`, the item moves to `dead_letter` instead of back to `pending`.

---

## Handoff Payload Schema

The handoff payload transfers context from one agent (or one stage) to the next.

```typescript
interface HandoffPayload {
  summary: string;           // Human-readable summary of what was done / what's needed
  context: Record<string, unknown>;  // Arbitrary structured data
  memory_ids?: string[];     // Memory IDs relevant to the next stage
  instructions?: string;     // Explicit instructions for the next agent
  target_agent_type?: string; // Hint about what kind of agent should pick this up
}
```

A handoff can be attached at **enqueue time** (instructions for whoever claims it) or at **complete time** (results + instructions for the downstream task).

---

## Operations Reference

| Operation | Required Params | Optional Params |
|-----------|----------------|----------------|
| `enqueue` | `task_type`, `payload` | `queue_name`, `priority`, `handoff`, `max_attempts`, `scheduled_after`, `idempotency_key` |
| `claim` | `agent_id` | `queue_name`, `lease_seconds` |
| `complete` | `item_id`, `agent_id` | `handoff` |
| `fail` | `item_id`, `agent_id`, `failure_reason` | — |
| `retry` | `item_id` | — |
| `renew_lease` | `item_id`, `agent_id` | `lease_seconds` |
| `list` | — | `queue_name`, `status_filter`, `task_type`, `agent_id`, `limit`, `offset` |
| `get` | `item_id` | — |
| `stats` | — | `queue_name` |
| `purge` | — | `queue_name`, `older_than_days` |

---

## Queue Statistics

```json
{
  "tool": "work_queue",
  "arguments": { "operation": "stats" }
}
```

**Response:**
```json
{
  "queues": [
    {
      "queue_name": "analysis",
      "pending": 12,
      "claimed": 3,
      "completed": 847,
      "failed": 5,
      "dead_letter": 1,
      "total": 868,
      "oldest_pending_age_seconds": 45.2,
      "avg_completion_seconds": 127.8
    }
  ]
}
```

---

## Lease Renewal

For tasks that take longer than the lease duration, call `renew_lease` periodically:

```json
{
  "tool": "work_queue",
  "arguments": {
    "operation": "renew_lease",
    "item_id": "item-uuid",
    "agent_id": "agent-analyst-01",
    "lease_seconds": 300
  }
}
```

If the lease expires without renewal or completion, the item returns to `pending` and can be claimed by another agent.

---

## Maintenance

### Retry dead-letter items

```json
{ "operation": "retry", "item_id": "item-uuid" }
```

This resets `attempt_count` to the current count (not zero) and moves status back to `pending`.

### Purge old items

```json
{ "operation": "purge", "queue_name": "analysis", "older_than_days": 7 }
```

Deletes `completed` and `dead_letter` items older than the specified age. Returns count of deleted rows.

---

## Database

The queue is backed by a PostgreSQL table `work_queue`, auto-created on first use via `ensureSchema()`.

Key design choices:
- `FOR UPDATE SKIP LOCKED` — zero-overhead atomic claiming, no polling conflicts
- `CASE` expression for priority ordering — avoids storing magic integers
- `ON CONFLICT DO UPDATE` on `(tenant_id, idempotency_key)` — safe idempotent enqueue
- `scheduled_after` column — supports delayed/scheduled tasks
