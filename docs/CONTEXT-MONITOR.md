# Context Monitor — REM-97

## Overview

The `context_monitor` MCP tool tracks context window usage, provides category breakdowns, generates alerts at configurable thresholds, and offers recommendations for checkpointing and compression.

**Evidence:** #1 pain point from 50+ agents surveyed (Moltbook research).

## Problem

Agents pay for context tokens on every turn but have zero visibility into allocation until the window is full:

- **Context bloat** from unmonitored categories (conversation, tools, memory, etc.)
- **No warning** before hitting limits
- **Poor allocation** across categories
- **No usage trends** to predict when compression is needed

40% context efficiency improvement measured from simple tracking (Moltbook data).

## Solution

Context Monitor provides:

### 1. Usage Tracking (`monitor`)
- **Total usage** (tokens used / available)
- **Category breakdown** (system, conversation, tools, memory, other)
- **Top-N consumers** (largest categories ranked)
- **Utilization percentage** (realtime allocation)

### 2. Alert System
- **Configurable thresholds** (default: 70%, 85%, 95%)
- **Severity levels**: warning, critical, urgent
- **Actionable recommendations** per alert
- **Low-token warnings** (< 10K tokens remaining)

### 3. Trend Analysis
- **Usage timeline** (configurable window, default 24h)
- **Peak usage tracking** (highest usage + timestamp)
- **Growth rate estimation** (tokens per minute)
- **Time-to-full prediction** (estimated minutes until capacity)

### 4. Recommendations
- **Checkpoint triggers** (at 70% usage)
- **Compression triggers** (at 85% usage)
- **Estimated time to full** (based on growth trend)

## Usage

### Monitor Context Usage

```javascript
{
  "name": "context_monitor",
  "arguments": {
    "operation": "monitor",
    "session_id": "my-session-123",
    "current_usage": {
      "system": 5000,
      "conversation": 30000,
      "tools": 25000,
      "memory": 20000,
      "other": 5000
    },
    "max_tokens": 100000,
    "thresholds": [70, 85, 95],
    "top_n": 5,
    "trend_window_hours": 24
  }
}
```

**Response:**

```json
{
  "success": true,
  "monitor": {
    "session_id": "my-session-123",
    "timestamp": "2026-02-26T04:00:00Z",
    "usage": {
      "total_tokens_used": 85000,
      "max_tokens": 100000,
      "utilization_percent": 85.0,
      "tokens_remaining": 15000
    },
    "breakdown": [
      { "category": "conversation", "tokens": 30000, "percentage": 35.3, "rank": 1 },
      { "category": "tools", "tokens": 25000, "percentage": 29.4, "rank": 2 },
      { "category": "memory", "tokens": 20000, "percentage": 23.5, "rank": 3 },
      { "category": "system", "tokens": 5000, "percentage": 5.9, "rank": 4 },
      { "category": "other", "tokens": 5000, "percentage": 5.9, "rank": 5 }
    ],
    "top_consumers": [
      { "category": "conversation", "tokens": 30000, "percentage": 35.3, "rank": 1 },
      { "category": "tools", "tokens": 25000, "percentage": 29.4, "rank": 2 },
      { "category": "memory", "tokens": 20000, "percentage": 23.5, "rank": 3 }
    ],
    "alerts": [
      {
        "severity": "critical",
        "threshold_percent": 85,
        "current_percent": 85.0,
        "message": "Context usage at 85% (threshold: 85%)",
        "recommendation": "Create checkpoint and prepare for compression"
      }
    ],
    "trend": [
      { "timestamp": "2026-02-26T02:00:00Z", "total_tokens": 60000, "utilization_percent": 60.0 },
      { "timestamp": "2026-02-26T03:00:00Z", "total_tokens": 75000, "utilization_percent": 75.0 },
      { "timestamp": "2026-02-26T04:00:00Z", "total_tokens": 85000, "utilization_percent": 85.0 }
    ],
    "peak": {
      "usage": 85000,
      "time": "2026-02-26T04:00:00Z"
    },
    "recommendations": {
      "should_checkpoint": true,
      "should_compress": true,
      "estimated_time_to_full_minutes": 30
    }
  }
}
```

### Get Session State

```javascript
{
  "name": "context_monitor",
  "arguments": {
    "operation": "state",
    "session_id": "my-session-123"
  }
}
```

**Response:**

```json
{
  "success": true,
  "state": {
    "current_usage": 85000,
    "peak_usage": 90000,
    "max_tokens": 100000,
    "session_state": "active",
    "created_at": "2026-02-26T00:00:00Z",
    "updated_at": "2026-02-26T04:00:00Z"
  }
}
```

## Parameters

### `monitor` Operation

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session_id` | string | Yes | - | Session identifier |
| `current_usage` | object | Yes | - | Token count by category (e.g., `{"conversation": 30000, "tools": 25000}`) |
| `max_tokens` | number | No | 200000 | Maximum token limit for session |
| `thresholds` | number[] | No | [70, 85, 95] | Alert threshold percentages |
| `top_n` | number | No | 5 | Number of top consumers to identify |
| `trend_window_hours` | number | No | 24 | Usage trend analysis window (hours) |

### `state` Operation

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session_id` | string | Yes | - | Session identifier |

## Alert Thresholds

### Default Thresholds

- **70%** (warning): "Consider creating a checkpoint soon"
- **85%** (critical): "Create checkpoint and prepare for compression"
- **95%** (urgent): "Immediate action required: Compress context or archive old data now"

### Custom Thresholds

```javascript
{
  "operation": "monitor",
  "session_id": "my-session",
  "current_usage": { "total": 80000 },
  "thresholds": [60, 75, 90] // Custom thresholds
}
```

## Category Breakdown

Track token usage across logical categories:

- **system**: System prompts, instructions
- **conversation**: User messages, chat history
- **tools**: Tool outputs, API responses
- **memory**: Retrieved memories, documents
- **other**: Miscellaneous context

**Custom categories:**

```javascript
{
  "current_usage": {
    "system": 5000,
    "conversation": 20000,
    "tools": 15000,
    "memory": 25000,
    "working_state": 10000,
    "decisions": 5000,
    "custom_category": 3000
  }
}
```

## Usage Trends

Context Monitor tracks usage over time to:

- **Detect growth patterns** (steady, accelerating, stable)
- **Predict capacity exhaustion** (time-to-full estimation)
- **Identify peak usage** (timestamp of highest utilization)

**Trend window:** Last N hours of usage snapshots (default: 24 hours)

**Time-to-full estimation:**

- Calculated from average growth rate (tokens per minute)
- Based on trend window data (requires ≥ 2 snapshots)
- Returns estimated minutes until context window full

```json
{
  "recommendations": {
    "estimated_time_to_full_minutes": 45
  }
}
```

## Integration with ContextPilot

### Checkpoint Trigger (70% threshold)

```javascript
if (monitor.recommendations.should_checkpoint) {
  // Create checkpoint before compression
  await checkpoint({
    operation: "create",
    session_id: monitor.session_id,
    token_count_before: monitor.usage.total_tokens_used,
    decisions: recentDecisions,
    pending_items: pendingTasks
  });
}
```

### Compression Trigger (85% threshold)

```javascript
if (monitor.recommendations.should_compress) {
  // Perform context compression
  const checkpoint = await checkpoint({ operation: "get", session_id });
  // ... compression logic using checkpoint lifeboat
}
```

### Budget Compliance Check

```javascript
// Compare actual usage to budget allocations
const budget = await budget({ operation: "check", budget_name: "my-budget", current_usage: monitor.usage });

if (budget.overall_status === "exceeded") {
  // Rebalance allocations or trigger compression
}
```

## Best Practices

### 1. Regular Monitoring

Monitor context usage at key points:

- **Before expensive operations** (large tool calls, memory retrieval)
- **After significant additions** (conversation turns, tool results)
- **At checkpoint intervals** (every N turns or token threshold)

### 2. Category Hygiene

Maintain clean category boundaries:

- **Consistent naming** (use same category keys across calls)
- **Granular tracking** (split large categories into sub-categories)
- **Avoid "other"** (prefer explicit categorization)

### 3. Threshold Tuning

Adjust thresholds based on workload:

- **Interactive agents**: Lower thresholds (60%, 75%, 90%) for frequent checkpoints
- **Batch processing**: Higher thresholds (80%, 90%, 95%) for longer sessions
- **Memory-heavy**: Earlier checkpoints (50%, 70%, 85%) to preserve retrievals

### 4. Trend Analysis Window

Choose window based on session duration:

- **Short sessions** (< 1 hour): 1-4 hour window
- **Medium sessions** (1-8 hours): 8-24 hour window
- **Long sessions** (> 8 hours): 24-72 hour window

## Technical Notes

### Session Tracking

- **Sessions created on first monitor call** (upsert pattern)
- **Peak usage tracked automatically** (MAX of current usage)
- **State persisted in `context_sessions` table**

### Analytics Events

- **Each monitor call logs usage snapshot** to `context_analytics_events`
- **Event type**: `usage_snapshot`
- **Event data**: Category breakdown + timestamp
- **Used for trend analysis** (historical data queries)

### Time-to-Full Estimation

Algorithm:

1. Fetch usage snapshots from trend window
2. Calculate token growth: `latest_tokens - oldest_tokens`
3. Calculate time elapsed: `latest_time - oldest_time`
4. Growth rate: `token_growth / time_elapsed_minutes`
5. Tokens remaining: `max_tokens - current_tokens`
6. Estimate: `tokens_remaining / growth_rate`

**Limitations:**

- Requires ≥ 2 data points
- Assumes linear growth (may not hold for bursty workloads)
- Returns `undefined` if growth ≤ 0 or time diff ≤ 0

## Example Workflow

### Full Monitoring Session

```javascript
// 1. Initial monitor call (session creation)
const m1 = await context_monitor({
  operation: "monitor",
  session_id: "coding-session-1",
  current_usage: {
    system: 3000,
    conversation: 10000,
    tools: 5000
  }
});
// Usage: 18K / 200K (9%), no alerts

// 2. After heavy tool usage
const m2 = await context_monitor({
  operation: "monitor",
  session_id: "coding-session-1",
  current_usage: {
    system: 3000,
    conversation: 20000,
    tools: 80000,
    memory: 15000
  }
});
// Usage: 118K / 200K (59%), no alerts yet

// 3. Approaching threshold
const m3 = await context_monitor({
  operation: "monitor",
  session_id: "coding-session-1",
  current_usage: {
    system: 3000,
    conversation: 30000,
    tools: 100000,
    memory: 25000
  }
});
// Usage: 158K / 200K (79%), checkpoint recommended

// 4. Create checkpoint (70% threshold triggered)
await checkpoint({
  operation: "create",
  session_id: "coding-session-1",
  token_count_before: 158000,
  current_task: "Refactoring authentication module",
  decisions: [...],
  pending_items: [...]
});

// 5. Near capacity
const m4 = await context_monitor({
  operation: "monitor",
  session_id: "coding-session-1",
  current_usage: {
    system: 3000,
    conversation: 35000,
    tools: 120000,
    memory: 30000
  }
});
// Usage: 188K / 200K (94%), critical alert + compression recommended

// 6. Perform compression using checkpoint lifeboat
// ... compression logic ...
```

## Troubleshooting

### "Insufficient data for trend analysis"

- **Cause**: < 2 usage snapshots in trend window
- **Solution**: Monitor context usage more frequently or reduce `trend_window_hours`

### "Time-to-full estimate is undefined"

- **Cause**: Usage decreasing or stable (growth ≤ 0)
- **Solution**: Expected behavior when context is stable/shrinking; no action needed

### "Peak usage not updating"

- **Cause**: Current usage < historical peak
- **Solution**: Peak tracks maximum usage; only updates when current exceeds previous peak

### "Alerts not triggering"

- **Cause**: Utilization below lowest threshold
- **Solution**: Reduce thresholds (e.g., `[50, 70, 90]`) or wait until usage increases

## Schema

### `context_sessions` Table

```sql
CREATE TABLE context_sessions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  max_tokens INTEGER NOT NULL DEFAULT 200000,
  current_usage INTEGER NOT NULL DEFAULT 0,
  peak_usage INTEGER NOT NULL DEFAULT 0,
  session_state TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT context_sessions_unique UNIQUE (tenant_id, session_id)
);
```

### `context_analytics_events` Table

```sql
CREATE TABLE context_analytics_events (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_data JSONB DEFAULT '{}'::jsonb,
  token_count INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## See Also

- **[checkpoint](./CHECKPOINT-SERVICE.md)**: Pre-compression checkpoints
- **[budget](./BUDGET-MANAGEMENT.md)**: Token budget allocation
- **[context_analytics](./CONTEXT-ANALYTICS.md)**: Context usage analytics and waste detection
- **[ContextPilot Technical Design](./CONTEXTPILOT-TECHNICAL-DESIGN.md)**: Overall architecture

## References

- [Moltbook research: Context windows are finite](https://moltbook.example.com/context-finite)
- [Case study: 40% improvement from tracking](https://moltbook.example.com/tracking-improvement)
- REM-97 / RAD-82: Context Monitor implementation
