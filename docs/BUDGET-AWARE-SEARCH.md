# Budget-Aware Memory Search (REM-103)

**Status:** Phase 2 (Intelligence) - ContextPilot  
**Dependencies:** REM-102 (ContextPilot Database Schema)

## Overview

Budget-aware memory search extends the `memory_search` MCP tool with token budget constraints, preventing agents from exceeding context window limits when retrieving memories.

## Problem

Agents often search for memories and load all results without considering token budgets, leading to:
- Context window overflow
- Truncated important content
- Degraded agent performance
- Wasted API costs

## Solution

Add optional `max_tokens` and `token_budget_category` parameters to memory search. Results are:
1. Ranked by relevance (semantic + graph signals)
2. Annotated with token counts
3. Truncated to fit within budget
4. Returned with metadata about truncation

## Usage

### Direct Token Limit

```json
{
  "tool": "search",
  "operation": "query",
  "query": "AI ethics discussions",
  "max_tokens": 5000
}
```

### Budget Category Lookup

```json
{
  "tool": "search",
  "operation": "query",
  "query": "project status updates",
  "token_budget_category": "conversation"
}
```

The system fetches the allocation for `conversation` from the `context_budgets` table for the current tenant.

## Response Format

```json
{
  "results": [
    {
      "id": "uuid",
      "content": "...",
      "tags": ["..."],
      "metadata": {...},
      "_token_count": 342,
      "score": 0.87
    }
  ],
  "total_tokens": 4892,
  "truncated": true,
  "original_count": 25
}
```

If no results fit:
```json
{
  "results": [],
  "total_tokens": 0,
  "truncated": true,
  "original_count": 10,
  "warning": "No results fit within 100 token budget. Smallest result requires ~342 tokens."
}
```

## Token Estimation

Tokens are estimated using **character count / 4**, a rough approximation that works well for most text:
- Content tokens
- Tag tokens (joined with ", ")
- Metadata tokens (JSON stringified)

### Future Enhancement

Could be upgraded to use `tiktoken` for precise token counts if needed:
```typescript
import { encoding_for_model } from 'tiktoken';
const enc = encoding_for_model('gpt-4');
const tokens = enc.encode(text).length;
```

## Integration with Context Budgets

Budget categories are defined in the `context_budgets` table:

```sql
INSERT INTO context_budgets (tenant_id, budget_name, total_tokens, allocations)
VALUES (
  'tenant-uuid',
  'agent-context-budget',
  200000,
  '{"conversation": 50000, "decisions": 10000, "search": 20000, "background": 120000}'::jsonb
);
```

When `token_budget_category` is provided, the system:
1. Looks up the active budget for the tenant
2. Extracts the allocation for the specified category
3. Uses it as `max_tokens`
4. Falls back to no truncation if category not found

## Implementation Details

### Core Files

- `src/token-budget.ts` - Token estimation and truncation logic
- `src/memory-service.ts` - Integration with search
- `src/tools/consolidated-tools.ts` - MCP tool schema
- `src/token-budget.test.ts` - Comprehensive tests

### Algorithm

1. Execute normal search (semantic + text + graph enhancement)
2. Rank results by relevance score
3. Take top N results (limit parameter)
4. If `max_tokens` or `token_budget_category` set:
   - Fetch budget limit if needed
   - Iterate results in ranked order
   - Estimate tokens per result
   - Include result if cumulative tokens < budget
   - Stop when budget exceeded
5. Return truncated results with metadata

## Backward Compatibility

Fully backward compatible:
- Existing searches work unchanged
- New parameters are optional
- No truncation applied unless requested

## Testing

Run tests:
```bash
npm test -- token-budget
```

Test coverage:
- ✅ Token estimation (empty, short, long strings)
- ✅ Memory token counting (content + tags + metadata)
- ✅ Budget truncation (all fit, partial, none fit)
- ✅ Budget category lookup (active, inactive, missing)
- ✅ Warning messages

## Performance

- **Overhead:** Minimal - only character counting
- **Memory:** O(N) for annotated results
- **Database:** One extra query if using budget category lookup

## Future Enhancements

1. **Precise tokenization** - Integrate `tiktoken` for exact counts
2. **Budget analytics** - Track which categories exceed budgets most often
3. **Smart truncation** - Allow partial content truncation instead of dropping entire results
4. **Budget suggestions** - Recommend optimal budget allocations based on usage patterns

## Related Work

- REM-102: ContextPilot Database Schema (foundation)
- REM-104: Context Compression Engine (builds on this)
- REM-105: Budget Analytics Dashboard (visualizes usage)

## Author

Lethe - Backend Developer  
Delivered: 2026-02-26
