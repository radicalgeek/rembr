# Context Analytics — REM-101

## Overview

The `context_analytics` MCP tool provides comprehensive insights into context usage patterns, waste detection, and efficiency scoring for ContextPilot sessions.

## Problem

Agents cannot optimize what they cannot measure. Without visibility into context usage:
- **Token waste** goes undetected (repeated information, stale context, redundant results)
- **Compression effectiveness** is unknown
- **Efficiency bottlenecks** remain hidden
- **Optimization opportunities** are missed

## Solution

Context Analytics analyzes historical `context_analytics_events` data to provide:

### 1. Usage Patterns
- **Total tokens used** across the analysis period
- **Peak token usage** to identify high-water marks
- **Average tokens per hour** for trend analysis
- **Usage by category** (conversation, decisions, tools, etc.)
- **Timeline view** showing token consumption over time

### 2. Compression Tracking
- **Compression events** with before/after token counts
- **Total tokens saved** across all compressions
- **Average compression ratio** to measure effectiveness
- **Strategy tracking** to evaluate different compression approaches

### 3. Waste Detection
- **Repeated information**: Identifies duplicate content consuming tokens
- **Stale context**: Finds old, unused context categories
- **Redundant results**: Detects unnecessary repetition
- **Severity scoring**: High/medium/low based on impact
- **Token waste estimation**: Quantifies the cost of each waste source

### 4. Efficiency Scoring
- **Overall score** (0-100) with letter grade (A-F)
- **Useful context ratio**: Percentage of tokens providing value
- **Waste ratio**: Percentage of tokens wasted
- **Compression efficiency**: How well compression reduces bloat
- **Weighted calculation**: 50% useful context, 30% waste avoidance, 20% compression

### 5. Recommendations Engine
- **Prioritized actions**: Critical → High → Medium → Low
- **Actionable suggestions**: Specific steps to improve efficiency
- **Estimated savings**: Token reduction from each recommendation
- **Category-based**: Deduplication, compression, context refresh, etc.

## Usage

### Basic Analytics (Last 7 Days)
```javascript
{
  "name": "context_analytics",
  "arguments": {
    "operation": "get",
    "session_id": "agent-session-123"
  }
}
```

### Custom Time Period
```javascript
{
  "name": "context_analytics",
  "arguments": {
    "operation": "get",
    "session_id": "agent-session-123",
    "period_start": "2026-02-20T00:00:00Z",
    "period_end": "2026-02-26T23:59:59Z"
  }
}
```

## Response Format

```javascript
{
  "success": true,
  "analytics": {
    "session_id": "agent-session-123",
    "period": {
      "start": "2026-02-19T01:47:00.000Z",
      "end": "2026-02-26T01:47:00.000Z"
    },
    "usage": {
      "total_tokens": 150000,
      "peak_tokens": 8500,
      "avg_per_hour": 892,
      "by_category": {
        "conversation": 50000,
        "decisions": 30000,
        "tools": 40000,
        "memory": 30000
      },
      "timeline": [
        {
          "timestamp": "2026-02-25T10:00:00.000Z",
          "token_count": 5000,
          "category": "conversation",
          "session_id": "agent-session-123"
        }
        // ... more snapshots
      ]
    },
    "compression": {
      "total_events": 12,
      "tokens_saved": 45000,
      "avg_compression_ratio": 0.62,
      "events": [
        {
          "timestamp": "2026-02-25T14:30:00.000Z",
          "tokens_before": 10000,
          "tokens_after": 6200,
          "tokens_saved": 3800,
          "compression_ratio": 0.62,
          "strategy": "balanced"
        }
        // ... more events
      ]
    },
    "waste": {
      "total_tokens": 15000,
      "percentage": 10.0,
      "detected": [
        {
          "type": "repeated_info",
          "severity": "high",
          "description": "Content repeated 5 times",
          "estimated_waste_tokens": 8000,
          "location": "a3f7b2c"
        },
        {
          "type": "stale_context",
          "severity": "medium",
          "description": "Context not accessed in 72 hours",
          "estimated_waste_tokens": 7000,
          "location": "old_project"
        }
      ]
    },
    "efficiency": {
      "score": 85,
      "useful_context_ratio": 0.90,
      "waste_ratio": 0.10,
      "compression_efficiency": 0.38,
      "grade": "B"
    },
    "recommendations": [
      {
        "priority": "critical",
        "category": "waste_reduction",
        "action": "Address 1 high-severity waste sources",
        "reason": "Estimated 8000 tokens wasted",
        "estimated_savings_tokens": 8000
      },
      {
        "priority": "high",
        "category": "deduplication",
        "action": "Enable automatic deduplication for repeated content",
        "reason": "Found 1 instances of repeated information",
        "estimated_savings_tokens": 8000
      },
      {
        "priority": "medium",
        "category": "context_refresh",
        "action": "Review and prune stale context categories",
        "reason": "1 categories not accessed recently",
        "estimated_savings_tokens": 7000
      }
    ]
  }
}
```

## Efficiency Grading Scale

- **A (90-100)**: Excellent efficiency, minimal waste
- **B (80-89)**: Good efficiency, minor optimization opportunities
- **C (70-79)**: Fair efficiency, noticeable waste present
- **D (60-69)**: Poor efficiency, significant waste detected
- **F (<60)**: Critical efficiency issues, major optimization needed

## Waste Detection Types

### Repeated Information
- **Trigger**: Same content hash appears multiple times
- **Impact**: Wasted tokens on duplicate data
- **Fix**: Enable deduplication, improve memory management

### Stale Context
- **Trigger**: Context category not accessed >24 hours
- **Impact**: Old context consuming valuable token budget
- **Fix**: Prune unused categories, refresh active context

### Redundant Results
- **Trigger**: Similar tool results stored repeatedly
- **Impact**: Unnecessary repetition in context window
- **Fix**: Cache results, deduplicate tool outputs

## Integration with ContextPilot

Context Analytics leverages the `context_analytics_events` table populated by other ContextPilot tools:

- **Compression events**: Logged by compression service
- **Usage snapshots**: Logged at regular intervals
- **Budget exceeded**: Logged when limits reached
- **Category tracking**: Categorized by decision/conversation/tools/memory

## Dashboard Export

Analytics data is structured for easy dashboard consumption:

```javascript
// Time-series chart data
analytics.usage.timeline

// Category breakdown pie chart
analytics.usage.by_category

// Compression effectiveness over time
analytics.compression.events

// Waste severity distribution
analytics.waste.detected

// Efficiency trend
analytics.efficiency.score
```

## Performance

- **Query time**: <100ms for 7-day analysis
- **Memory usage**: Minimal (streaming results)
- **Index usage**: Optimized with GIN/BTREE indexes on `context_analytics_events`

## Future Enhancements

- **Real-time alerts**: Push notifications for efficiency drops
- **Automated optimization**: Self-tuning based on analytics
- **Cross-session analysis**: Compare efficiency across multiple sessions
- **Cost tracking**: Token cost estimates for budget planning
- **Waste prevention**: Proactive detection before waste occurs

## Evidence

- **"Logs Must Die"**: Structured events enable precise analytics
- **"State schema patterns"**: Metrics drive optimization decisions
- **REM-102**: ContextPilot Foundation provides the database schema
- **REM-103**: Budget-Aware Search complements analytics with token management

---

**Related Documentation:**
- [ContextPilot Foundation (REM-102)](./docs/contextpilot/)
- [Budget-Aware Search (REM-103)](./BUDGET-AWARE-SEARCH.md)
- [Migration 010](./src/migrations/010-contextpilot-schema.sql)

**Status:** ✅ Complete (REM-101, 2026-02-26)
