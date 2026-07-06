# Plan Regeneration Service (REM-76)

## Overview

The Plan Regeneration Service provides an **auto-unstuck mechanism** for task execution. When a task becomes stuck after repeated failures, the service analyzes the context, identifies failure patterns, and generates a structured prompt to help create a new execution plan.

## Core Capabilities

1. **Stuck Detection**: Automatically detects when tasks are stuck based on iteration patterns
2. **Context Analysis**: Gathers comprehensive context including:
   - Iteration history and attempted approaches
   - Failure patterns and error messages
   - Related memories and knowledge
   - Acceptance criteria and constraints
3. **Prompt Generation**: Creates structured prompts for agents to generate new plans
4. **History Tracking**: Maintains regeneration history for learning and auditing

## Database Schema

### `task_iterations`
Tracks task execution attempts and outcomes.

```sql
CREATE TABLE task_iterations (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    task_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    approach TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    metadata JSONB DEFAULT '{}'
);
```

**Metadata Fields:**
- `constraints`: Array of constraints that must be respected
- `acceptance_criteria`: Array of criteria that define success
- Custom fields as needed

### `plan_regenerations`
Stores regeneration events and context snapshots.

```sql
CREATE TABLE plan_regenerations (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    task_id TEXT NOT NULL,
    reason_type TEXT NOT NULL,
    reason_description TEXT NOT NULL,
    context_snapshot JSONB NOT NULL,
    generated_prompt JSONB NOT NULL,
    triggered_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    new_plan TEXT,
    metadata JSONB DEFAULT '{}'
);
```

## API

### `triggerRegeneration()`

Triggers plan regeneration for a stuck task.

```typescript
const regeneration = await triggerRegeneration(
  pool,
  tenantId,
  taskId,
  {
    type: 'stuck_detection',
    description: 'Task stuck after 5 failed iterations',
    iteration_count: 5,
    failure_count: 5,
  }
);
```

**Parameters:**
- `pool`: PostgreSQL connection pool
- `tenantId`: Tenant UUID
- `taskId`: Task identifier
- `reason`: Regeneration reason with type and metadata

**Returns:** `RegenerationRecord` with context snapshot and generated prompt

### `analyzeStuckContext()`

Analyzes stuck context for a task.

```typescript
const context = await analyzeStuckContext(pool, tenantId, taskId);
```

**Returns:** `StuckContext` containing:
- `iterations`: Array of task execution attempts
- `related_memories`: Relevant knowledge from memory store
- `constraints`: Task constraints
- `acceptance_criteria`: Success criteria
- `previous_plans`: Unique approaches tried
- `failure_patterns`: Detected failure patterns

### `getRegenerationHistory()`

Retrieves regeneration history for a task.

```typescript
const history = await getRegenerationHistory(pool, tenantId, taskId, 10);
```

**Parameters:**
- `limit`: Maximum number of records (default: 10)

**Returns:** Array of `RegenerationRecord` ordered by `triggered_at DESC`

### `resolveRegeneration()`

Marks a regeneration as resolved with the new plan.

```typescript
await resolveRegeneration(
  pool,
  tenantId,
  regenerationId,
  'New approach: Use different library and simplify interface'
);
```

## Regeneration Reasons

### `stuck_detection`
Automatically triggered when stuck patterns are detected.

**Metadata:**
- `iteration_count`: Number of iterations
- `failure_count`: Number of failed attempts
- `elapsed_minutes`: Time spent stuck

### `manual`
Manually triggered by human or system.

### `failure_threshold`
Triggered when failure count exceeds threshold.

**Metadata:**
- `failure_count`: Number of failures
- `threshold`: Configured threshold

### `timeout`
Triggered when task exceeds time limit.

**Metadata:**
- `elapsed_minutes`: Time elapsed
- `timeout_minutes`: Configured timeout

## Failure Pattern Detection

The service automatically detects common failure patterns:

### 1. Repeated Errors
Same error message appearing multiple times.

```
Example: "Repeated error (3x): Dependency not found"
```

### 2. Repeated Approach Keywords
Same approach keywords appearing in multiple iterations.

```
Example: "Repeated approach keyword: 'refactor' (4 iterations)"
```

### 3. All Recent Failures
Last N attempts all failed (indicates fundamental blocker).

```
Example: "Last 3 attempts all failed - fundamental blocker likely"
```

## Generated Prompt Structure

The service generates a structured prompt for agents:

```markdown
# Plan Regeneration Required

## Task Context
[Task ID and title]

## Why We're Stuck
[Reason description with iteration count]

## What's Been Tried (and Failed)
1. Attempt 1: [approach] → [outcome] ([error])
2. Attempt 2: [approach] → [outcome]
...

## Failure Patterns Detected
1. [Pattern 1]
2. [Pattern 2]
...

## Acceptance Criteria (Must Satisfy)
1. [Criterion 1]
2. [Criterion 2]
...

## Constraints
1. [Constraint 1]
2. [Constraint 2]
...

## Related Knowledge Available
1. [Memory 1] (relevance: 0.95)
2. [Memory 2] (relevance: 0.87)
...

## Your Task
Generate a NEW plan that:
1. Avoids the failed approaches listed above
2. Addresses the identified failure patterns
3. Satisfies all acceptance criteria
4. Respects the constraints
5. Leverages the related knowledge

Be creative. If all obvious approaches failed, consider:
- Breaking the problem down differently
- Using different tools or methods
- Challenging assumptions in the acceptance criteria
- Seeking clarification on ambiguous requirements
```

## Integration Example

### Recording Task Iterations

```typescript
// Start iteration
await pool.query(`
  INSERT INTO task_iterations (
    tenant_id, task_id, attempt_number, 
    approach, outcome, metadata
  )
  VALUES ($1, $2, $3, $4, 'In Progress', $5)
`, [
  tenantId,
  taskId,
  attemptNumber,
  'Try implementing with library X',
  JSON.stringify({
    constraints: ['Must use TypeScript', 'Must be < 100 lines'],
    acceptance_criteria: ['All tests pass', 'Type-safe'],
  }),
]);

// Update outcome
await pool.query(`
  UPDATE task_iterations
  SET outcome = $4, error = $5, completed_at = NOW()
  WHERE tenant_id = $1 AND task_id = $2 AND attempt_number = $3
`, [tenantId, taskId, attemptNumber, 'Failed', 'Library X not compatible']);
```

### Stuck Detection and Regeneration

```typescript
// Check if stuck (e.g., 3+ failures in a row)
const recentIterations = await pool.query(`
  SELECT * FROM task_iterations
  WHERE tenant_id = $1 AND task_id = $2
  ORDER BY attempt_number DESC
  LIMIT 3
`, [tenantId, taskId]);

const allFailed = recentIterations.rows.every(
  row => row.outcome === 'Failed' || row.error
);

if (allFailed && recentIterations.rows.length >= 3) {
  // Trigger regeneration
  const regeneration = await triggerRegeneration(pool, tenantId, taskId, {
    type: 'stuck_detection',
    description: 'Task stuck after 3 consecutive failures',
    iteration_count: recentIterations.rows.length,
    failure_count: recentIterations.rows.length,
  });

  // Use regeneration.generated_prompt.prompt_for_agent
  // to create new plan with agent
  console.log(regeneration.generated_prompt.prompt_for_agent);
}
```

## Best Practices

1. **Record Detailed Iterations**: Include rich metadata (constraints, acceptance criteria, evidence)
2. **Descriptive Approaches**: Use clear, descriptive approach strings
3. **Meaningful Errors**: Capture specific error messages for pattern detection
4. **Timely Regeneration**: Trigger regeneration after 3-5 failures, not earlier
5. **Resolve with Plans**: Always call `resolveRegeneration()` when a new plan is created

## Testing

Run tests with:

```bash
npm test -- plan-regeneration.test.ts
```

Tests cover:
- Regeneration record creation
- Context snapshot accuracy
- Failure pattern detection
- Prompt generation structure
- History retrieval
- Resolution workflow

## Performance Considerations

- **Iteration History**: Queries limited to task-specific iterations
- **Memory Search**: Returns top 10 relevant memories (vector search)
- **Pattern Detection**: In-memory processing of iteration arrays
- **Indexes**: Optimized for tenant + task lookups

## Security

- **Row-Level Security**: All tables enforce tenant isolation
- **Input Validation**: Task IDs and tenant IDs validated
- **Context Isolation**: Regenerations only access same-tenant data

## Monitoring

Track regeneration metrics:

```sql
-- Regeneration frequency by task
SELECT task_id, COUNT(*) as regeneration_count
FROM plan_regenerations
WHERE tenant_id = 'YOUR_TENANT_ID'
GROUP BY task_id
ORDER BY regeneration_count DESC;

-- Average resolution time
SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - triggered_at))/60) as avg_minutes
FROM plan_regenerations
WHERE resolved_at IS NOT NULL;

-- Common failure patterns
SELECT context_snapshot->'failure_patterns' as patterns, COUNT(*)
FROM plan_regenerations
GROUP BY patterns
ORDER BY count DESC
LIMIT 10;
```

## Future Enhancements

- **ML-Based Pattern Detection**: Use ML to detect complex failure patterns
- **Auto-Plan Generation**: Integrate with LLM to auto-generate new plans
- **Success Rate Tracking**: Track which regenerated plans succeed
- **Recommendation Engine**: Suggest approaches based on historical success

---

**Related:**
- [ContextPilot Schema](./docs/wiki/CONTEXTPILOT-SCHEMA.md)
- [Memory Service](./src/memory-service.ts)
- Migration: `011-plan-regeneration-schema.sql`
