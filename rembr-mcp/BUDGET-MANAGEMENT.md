# Token Budget Management — REM-100

## Overview

The `budget` MCP tool provides token budget allocation and enforcement for ContextPilot. Define category-based budgets, check usage against limits, and use built-in templates for common use cases.

## Problem

Agents load everything into context without budgeting:
- **Context bloat** from mixed concerns (history + tools + memory + state)
- **No visibility** into which categories consume tokens
- **No warnings** before hitting context limits
- **Inefficient allocation** across categories

## Solution

Token Budget Management provides:

### 1. Budget Definition (`set`)
- **Total token budget** with category allocations
- **Soft limits** with warning/critical thresholds  
- **Compression triggers** for automatic optimization
- **Custom allocations** per category (conversation, tools, memory, etc.)

### 2. Budget Templates (`apply_template`)
Built-in templates for common use cases:
- **coding**: Optimized for coding tasks (heavy tool usage, memory retrieval)
- **research**: Optimized for research (large memory allocation)
- **conversation**: Optimized for chat (heavy conversation history)
- **automation**: Optimized for automation (frequent tool calls)

### 3. Budget Checking (`check`)
- **Usage tracking** per category
- **Utilization percentages** for each allocation
- **Status indicators**: ok, warning, critical, exceeded
- **Warnings** for categories approaching limits
- **Recommendations** for optimization (compression, reallocation)

### 4. Budget Listing (`list`)
- **View all budgets** for a tenant
- **Filter by active status**
- **Budget metadata** and allocations

## Usage

### Create Custom Budget
```javascript
{
  "name": "budget",
  "arguments": {
    "operation": "set",
    "budget_name": "my-agent-budget",
    "total_tokens": 100000,
    "allocations": {
      "system": 5000,
      "conversation": 30000,
      "tools": 25000,
      "memory": 30000,
      "working_state": 8000,
      "decisions": 2000
    },
    "thresholds": {
      "warning_percent": 75,
      "critical_percent": 90
    },
    "compression_trigger_percent": 80
  }
}
```

### Apply Built-in Template
```javascript
{
  "name": "budget",
  "arguments": {
    "operation": "apply_template",
    "budget_name": "my-coding-budget",
    "template": "coding"
  }
}
```

### Apply Template with Customizations
```javascript
{
  "name": "budget",
  "arguments": {
    "operation": "apply_template",
    "budget_name": "my-research-budget",
    "template": "research",
    "custom_total_tokens": 200000,
    "allocation_adjustments": {
      "memory": 100000
    },
    "thresholds": {
      "warning_percent": 80,
      "critical_percent": 95
    }
  }
}
```

### Check Budget Usage
```javascript
{
  "name": "budget",
  "arguments": {
    "operation": "check",
    "budget_name": "my-agent-budget",
    "current_usage": {
      "system": 4500,
      "conversation": 25000,
      "tools": 28000,
      "memory": 20000,
      "working_state": 6000,
      "decisions": 1500
    }
  }
}
```

### List All Budgets
```javascript
{
  "name": "budget",
  "arguments": {
    "operation": "list",
    "active_only": true
  }
}
```

## Response Formats

### Set Response
```json
{
  "success": true,
  "budget": {
    "budget_name": "my-agent-budget",
    "total_tokens": 100000,
    "allocations": {
      "system": 5000,
      "conversation": 30000,
      "tools": 25000,
      "memory": 30000,
      "working_state": 8000,
      "decisions": 2000
    },
    "thresholds": {
      "warning_percent": 75,
      "critical_percent": 90
    },
    "compression_trigger_percent": 80,
    "is_active": true
  }
}
```

### Check Response
```json
{
  "success": true,
  "check": {
    "budget_name": "my-agent-budget",
    "total_allocated": 100000,
    "total_used": 85000,
    "total_remaining": 15000,
    "overall_utilization_percent": 85,
    "overall_status": "critical",
    "category_usage": [
      {
        "category": "conversation",
        "allocated": 30000,
        "used": 25000,
        "remaining": 5000,
        "utilization_percent": 83.3,
        "status": "warning"
      },
      {
        "category": "tools",
        "allocated": 25000,
        "used": 28000,
        "remaining": 0,
        "utilization_percent": 112,
        "status": "exceeded"
      }
    ],
    "warnings": [
      "Category 'tools' exceeded budget (112% used)",
      "Category 'conversation' approaching limit (83% used)"
    ],
    "recommendations": [
      "Consider compressing context (85% utilization exceeds compression trigger of 80%)",
      "Review high-utilization categories: tools, conversation",
      "Consider reallocating budget from underutilized categories: decisions, system"
    ]
  }
}
```

### Apply Template Response
```json
{
  "success": true,
  "budget": {
    "budget_name": "my-coding-budget",
    "total_tokens": 100000,
    "allocations": {
      "system": 5000,
      "conversation": 20000,
      "tools": 30000,
      "memory": 25000,
      "working_state": 15000,
      "decisions": 5000
    },
    "thresholds": {
      "warning_percent": 75,
      "critical_percent": 90
    },
    "compression_trigger_percent": 80,
    "template_applied": "coding",
    "template_description": "Optimized for coding tasks with heavy tool usage and memory retrieval"
  }
}
```

### List Response
```json
{
  "success": true,
  "budget_count": 2,
  "budgets": [
    {
      "budget_name": "my-coding-budget",
      "total_tokens": 100000,
      "allocations": { "...": "..." },
      "is_active": true
    },
    {
      "budget_name": "my-research-budget",
      "total_tokens": 150000,
      "allocations": { "...": "..." },
      "is_active": true
    }
  ]
}
```

## Built-in Templates

### Coding Template (100k tokens)
Optimized for coding tasks with heavy tool usage:
- **system**: 5,000 (5%)
- **conversation**: 20,000 (20%)
- **tools**: 30,000 (30%) — Heavy tool allocation
- **memory**: 25,000 (25%)
- **working_state**: 15,000 (15%)
- **decisions**: 5,000 (5%)

### Research Template (100k tokens)
Optimized for research with large memory needs:
- **system**: 5,000 (5%)
- **conversation**: 15,000 (15%)
- **tools**: 20,000 (20%)
- **memory**: 45,000 (45%) — Heavy memory allocation
- **working_state**: 10,000 (10%)
- **decisions**: 5,000 (5%)

### Conversation Template (50k tokens)
Optimized for chat agents:
- **system**: 3,000 (6%)
- **conversation**: 30,000 (60%) — Heavy conversation history
- **tools**: 5,000 (10%)
- **memory**: 8,000 (16%)
- **working_state**: 2,000 (4%)
- **decisions**: 2,000 (4%)

### Automation Template (75k tokens)
Optimized for automation with frequent tool calls:
- **system**: 5,000 (7%)
- **conversation**: 10,000 (13%)
- **tools**: 40,000 (53%) — Heavy tool allocation
- **memory**: 10,000 (13%)
- **working_state**: 8,000 (11%)
- **decisions**: 2,000 (3%)

## Budget Status Indicators

### ok
- Utilization: 0-74% (below warning threshold)
- Action: None required

### warning
- Utilization: 75-89% (at/above warning threshold)
- Action: Monitor usage, consider optimization

### critical
- Utilization: 90-99% (at/above critical threshold)
- Action: Compress context or reallocate budget

### exceeded
- Utilization: ≥100%
- Action: Immediate compression or budget increase needed

## Integration with ContextPilot

Budget Management works with other ContextPilot tools:

### Budget-Aware Search (REM-103)
```javascript
{
  "name": "search",
  "arguments": {
    "operation": "query",
    "query": "user preferences",
    "token_budget_category": "memory",  // Uses budget allocation
    "max_tokens": 25000  // Enforced by budget check
  }
}
```

### Context Analytics (REM-101)
Check analytics to inform budget adjustments:
- High waste in a category? Reduce allocation
- Low utilization? Reallocate to high-usage categories
- Compression not triggered? Increase compression_trigger_percent

### Smart Compression (REM-99)
Triggered automatically when budget.compression_trigger_percent exceeded:
- Budget check recommends compression at 80% utilization
- Compression preserves decisions, compresses filler
- Freed tokens can be reallocated to other categories

## Workflow Example

1. **Define budget** using template:
   ```javascript
   { "operation": "apply_template", "template": "coding", "budget_name": "session-123" }
   ```

2. **Track usage** throughout session:
   ```javascript
   { "operation": "check", "budget_name": "session-123", "current_usage": {...} }
   ```

3. **Receive warnings**:
   - "Category 'tools' approaching limit (82% used)"
   - "Consider compressing context (85% utilization)"

4. **Take action**:
   - Trigger compression if >80%
   - Reallocate budget from underutilized categories
   - Increase total budget if needed

5. **Monitor with analytics**:
   - Use `context_analytics` to identify waste sources
   - Adjust allocations based on actual usage patterns

## Database Schema

Leverages `context_budgets` table from migration 010:
- **id**: UUID primary key
- **tenant_id**: Tenant isolation
- **budget_name**: Unique per tenant
- **total_tokens**: Total budget allocation
- **allocations**: JSONB category allocations
- **thresholds**: JSONB warning/critical percentages
- **compression_trigger_percent**: When to suggest compression
- **is_active**: Enable/disable budget
- **metadata**: Template info, custom data

## Evidence

- **"Context windows are finite"**: Explicit token budgeting pattern
- **"The case for cron over heartbeats"**: Context bloat from mixed concerns
- **Cost-Aware Agent Routing**: 70% cost reduction through smart routing
- **REM-102**: ContextPilot Foundation provides database schema
- **REM-103**: Budget-Aware Search consumes budget allocations

## Future Enhancements

- **Automatic reallocation**: Dynamic budget adjustment based on usage
- **Cross-session analytics**: Budget efficiency across multiple sessions
- **Budget templates per agent type**: Specialized templates for different agent personas
- **Budget forecasting**: Predict when limits will be reached
- **Integration with billing**: Track token costs per budget category

---

**Related Documentation:**
- [ContextPilot Foundation (REM-102)](./docs/contextpilot/)
- [Budget-Aware Search (REM-103)](./BUDGET-AWARE-SEARCH.md)
- [Context Analytics (REM-101)](./CONTEXT-ANALYTICS.md)
- [Migration 010](./src/migrations/010-contextpilot-schema.sql)

**Status:** ✅ Complete (REM-100, 2026-02-26)
