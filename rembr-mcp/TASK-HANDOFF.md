# Task Handoff Service (REM-73)

## Overview

The Task Handoff Service enables **inter-agent task transfers** with context preservation and workflow management. Agents can hand off tasks to other agents when needed (skills mismatch, capacity constraints, blocking issues), with full context transfer and accept/reject workflows.

## Core Capabilities

1. **Handoff Creation**: Initiate task handoffs with reason and context
2. **Workflow Management**: Accept or reject handoff requests
3. **Context Preservation**: Transfer full task context during handoff
4. **History Tracking**: Maintain handoff history for tasks and agents
5. **Pending Queue**: List pending handoffs per agent

## Database Schema

### `task_handoffs`
Tracks handoff requests between agents with workflow status.

```sql
CREATE TABLE task_handoffs (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    task_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    reason TEXT NOT NULL,
    context JSONB DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, accepted, rejected
    created_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    metadata JSONB DEFAULT '{}'
);
```

**Status Flow:**
```
pending → accepted
        → rejected
```

**Context Fields** (flexible JSONB):
- `current_state`: Current task state
- `progress`: Progress description
- `blockers`: Array of blocking issues
- `notes`: Additional context notes
- `artifacts`: Array of artifact references
- Custom fields as needed

## API

### `createHandoff()`

Creates a new handoff request.

```typescript
const handoff = await createHandoff(
  pool,
  tenantId,
  taskId,
  fromAgent,
  toAgent,
  reason,
  {
    current_state: 'Database schema designed',
    progress: '50% complete',
    blockers: ['Need senior dev review'],
    notes: 'Using JSONB for flexibility',
    artifacts: ['schema.sql', 'migration-001.sql'],
  }
);
```

**Parameters:**
- `pool`: PostgreSQL connection pool
- `tenantId`: Tenant UUID
- `taskId`: Task identifier
- `fromAgent`: Agent initiating handoff
- `toAgent`: Agent receiving handoff
- `reason`: Handoff reason (skills, capacity, blocking, etc.)
- `context`: Handoff context (optional, defaults to `{}`)

**Returns:** `TaskHandoff` with status `'pending'`

### `acceptHandoff()`

Accepts a pending handoff (toAgent only).

```typescript
const accepted = await acceptHandoff(pool, tenantId, handoffId, toAgent);
```

**Parameters:**
- `handoffId`: Handoff UUID
- `toAgent`: Agent accepting (must match handoff.to_agent)

**Returns:** `TaskHandoff` with status `'accepted'` and `accepted_at` timestamp

**Throws:** Error if:
- Handoff not found
- Handoff not for this agent
- Handoff already processed

### `rejectHandoff()`

Rejects a pending handoff with reason (toAgent only).

```typescript
const rejected = await rejectHandoff(
  pool,
  tenantId,
  handoffId,
  toAgent,
  'I am at capacity right now'
);
```

**Parameters:**
- `handoffId`: Handoff UUID
- `toAgent`: Agent rejecting (must match handoff.to_agent)
- `rejectionReason`: Reason for rejection

**Returns:** `TaskHandoff` with status `'rejected'`, `rejected_at` timestamp, and `rejection_reason`

**Throws:** Error if:
- Handoff not found
- Handoff not for this agent
- Handoff already processed

### `listPendingHandoffs()`

Lists pending handoffs for an agent.

```typescript
// List handoffs TO this agent (default)
const pendingToMe = await listPendingHandoffs(pool, tenantId, agentId);

// List handoffs FROM this agent
const pendingFromMe = await listPendingHandoffs(pool, tenantId, agentId, {
  includeFrom: true,
  includeTo: false,
});

// List handoffs TO or FROM this agent
const allPending = await listPendingHandoffs(pool, tenantId, agentId, {
  includeFrom: true,
  includeTo: true,
});
```

**Parameters:**
- `agentId`: Agent identifier
- `options`:
  - `includeTo`: Include handoffs to this agent (default: `true`)
  - `includeFrom`: Include handoffs from this agent (default: `false`)

**Returns:** Array of `TaskHandoff` with status `'pending'`, ordered by `created_at DESC`

### `getHandoff()`

Retrieves a handoff by ID.

```typescript
const handoff = await getHandoff(pool, tenantId, handoffId);
```

**Returns:** `TaskHandoff` or `null` if not found

### `getTaskHandoffHistory()`

Retrieves handoff history for a task.

```typescript
const history = await getTaskHandoffHistory(pool, tenantId, taskId, 10);
```

**Parameters:**
- `taskId`: Task identifier
- `limit`: Maximum number of records (default: 10)

**Returns:** Array of `TaskHandoff` (all statuses), ordered by `created_at DESC`

## Handoff Workflow

### Step 1: Create Handoff (From Agent)

```typescript
// Agent Alice needs database expertise for task-123
const handoff = await createHandoff(
  pool,
  tenantId,
  'task-123',
  'alice',
  'bob',  // Bob is a database expert
  'Need database design expertise',
  {
    current_state: 'Requirements gathered',
    progress: '20% complete',
    notes: 'Need schema design for user management system',
  }
);

// handoff.status === 'pending'
```

### Step 2: Check Pending Handoffs (To Agent)

```typescript
// Agent Bob checks pending handoffs
const pending = await listPendingHandoffs(pool, tenantId, 'bob');

// pending = [
//   {
//     id: '...',
//     task_id: 'task-123',
//     from_agent: 'alice',
//     to_agent: 'bob',
//     reason: 'Need database design expertise',
//     context: { ... },
//     status: 'pending',
//   }
// ]
```

### Step 3: Accept or Reject (To Agent)

```typescript
// Option A: Accept handoff
const accepted = await acceptHandoff(pool, tenantId, handoff.id, 'bob');
// accepted.status === 'accepted'
// accepted.accepted_at === Date

// Bob now owns task-123 and has full context

// Option B: Reject handoff
const rejected = await rejectHandoff(
  pool,
  tenantId,
  handoff.id,
  'bob',
  'I am at capacity this week'
);
// rejected.status === 'rejected'
// rejected.rejection_reason === 'I am at capacity this week'
```

### Step 4: Handle Rejection (From Agent)

```typescript
// Alice checks her outgoing handoffs
const outgoing = await listPendingHandoffs(pool, tenantId, 'alice', {
  includeFrom: true,
  includeTo: false,
});

// If rejected, Alice can:
// 1. Try handing off to another agent
// 2. Keep the task and seek help differently
// 3. Escalate to team lead

const history = await getTaskHandoffHistory(pool, tenantId, 'task-123');
// history shows all handoff attempts (accepted, rejected, pending)
```

## Use Cases

### 1. Skills Mismatch

```typescript
// Frontend task assigned to backend-focused agent
await createHandoff(pool, tenantId, 'task-ui', 'backend-agent', 'frontend-agent', 
  'UI task requires frontend expertise',
  {
    current_state: 'API integration complete',
    notes: 'Need React component for user profile page',
  }
);
```

### 2. Capacity Constraints

```typescript
// Overloaded agent hands off task
await createHandoff(pool, tenantId, 'task-5', 'overloaded-agent', 'available-agent',
  'At capacity (5/5 tasks), need help',
  {
    current_state: 'Not started',
    priority: 'high',
    notes: 'High priority task, need immediate attention',
  }
);
```

### 3. Blocking Issues

```typescript
// Agent blocked by external dependency
await createHandoff(pool, tenantId, 'task-blocked', 'agent-a', 'agent-b',
  'Blocked by API rate limit, need someone with premium access',
  {
    current_state: 'API integration 80% complete',
    blockers: ['Rate limit exceeded (free tier)'],
    notes: 'Need premium API key to finish',
  }
);
```

### 4. Escalation

```typescript
// Agent needs senior review/takeover
await createHandoff(pool, tenantId, 'task-complex', 'junior-agent', 'senior-agent',
  'Complex architectural decision needed',
  {
    current_state: 'Design options analyzed',
    notes: 'Need senior architect to decide between microservices vs monolith',
    artifacts: ['design-doc.md', 'architecture-options.md'],
  }
);
```

## Context Preservation

The handoff context is **fully preserved** through the workflow:

```typescript
const context = {
  current_state: 'Database schema designed',
  progress: '50% complete',
  blockers: ['Need review from senior dev'],
  notes: 'Schema uses JSONB for flexibility',
  artifacts: ['schema.sql', 'migration-001.sql'],
  custom_field: 'Custom data preserved',
};

const handoff = await createHandoff(pool, tenantId, taskId, from, to, reason, context);
const accepted = await acceptHandoff(pool, tenantId, handoff.id, to);

// accepted.context === context (exactly)
```

## Best Practices

1. **Clear Reasons**: Use descriptive reasons that explain why handoff is needed
2. **Rich Context**: Include current state, progress, blockers, and artifacts
3. **Timely Responses**: Accept or reject handoffs promptly
4. **Rejection Reasons**: Provide actionable rejection reasons
5. **History Tracking**: Review handoff history to avoid repeated rejections
6. **Ownership Clarity**: Update task ownership systems after acceptance

## Integration Example

### Task Management System

```typescript
// Agent discovers skills mismatch
async function handleSkillsMismatch(taskId: string, currentAgent: string) {
  // Find agent with required skills
  const targetAgent = await findAgentWithSkills(requiredSkills);
  
  // Create handoff
  const handoff = await createHandoff(
    pool,
    tenantId,
    taskId,
    currentAgent,
    targetAgent,
    `Skills mismatch: need ${requiredSkills.join(', ')}`,
    {
      current_state: 'Skills gap identified',
      required_skills: requiredSkills,
      notes: 'Please review and accept if you have bandwidth',
    }
  );
  
  // Notify target agent
  await notifyAgent(targetAgent, `Handoff request for ${taskId}`);
}

// Target agent reviews and accepts
async function reviewPendingHandoffs(agentId: string) {
  const pending = await listPendingHandoffs(pool, tenantId, agentId);
  
  for (const handoff of pending) {
    const canHandle = await checkCapacityAndSkills(handoff);
    
    if (canHandle) {
      await acceptHandoff(pool, tenantId, handoff.id, agentId);
      await transferTaskOwnership(handoff.task_id, agentId);
      console.log(`Accepted handoff for ${handoff.task_id}`);
    } else {
      await rejectHandoff(
        pool,
        tenantId,
        handoff.id,
        agentId,
        'At capacity or missing required skills'
      );
    }
  }
}
```

## Testing

Run tests with:

```bash
npm test -- task-handoff.test.ts
```

Tests cover:
- Handoff creation and context preservation
- Accept/reject workflow
- Error handling (wrong agent, already processed)
- Pending handoff listing (to/from/both)
- Handoff retrieval and history
- Multi-agent scenarios

## Performance Considerations

- **Indexes**: Optimized for `to_agent + status` and `from_agent + status` queries
- **JSONB Context**: Indexed with GIN for efficient context queries
- **Tenant Isolation**: Row-level security enforces tenant boundaries

## Security

- **Row-Level Security**: All queries enforce tenant isolation
- **Agent Validation**: Accept/reject operations verify agent identity
- **Status Immutability**: Accepted/rejected handoffs cannot be re-processed

## Monitoring

Track handoff metrics:

```sql
-- Handoff accept rate per agent
SELECT to_agent, 
       COUNT(*) FILTER (WHERE status = 'accepted') as accepted,
       COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
       COUNT(*) as total
FROM task_handoffs
WHERE tenant_id = 'YOUR_TENANT_ID'
GROUP BY to_agent;

-- Average time to accept/reject
SELECT AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))/60) as avg_accept_minutes
FROM task_handoffs
WHERE accepted_at IS NOT NULL;

-- Common rejection reasons
SELECT rejection_reason, COUNT(*)
FROM task_handoffs
WHERE status = 'rejected'
GROUP BY rejection_reason
ORDER BY count DESC;

-- Tasks with multiple handoffs (potential issues)
SELECT task_id, COUNT(*) as handoff_count
FROM task_handoffs
GROUP BY task_id
HAVING COUNT(*) > 2
ORDER BY handoff_count DESC;
```

## Future Enhancements

- **Auto-Routing**: Automatically route handoffs to best-fit agents
- **Skill Matching**: Match tasks to agents based on skill profiles
- **Capacity Awareness**: Check agent capacity before creating handoffs
- **Escalation Paths**: Auto-escalate to team leads if rejected N times
- **Context Enrichment**: Auto-gather context from task execution logs

---

**Related:**
- [Plan Regeneration Service](./PLAN-REGENERATION.md)
- [Task Iteration Tracking](./src/task-iteration.ts)
- Migration: `012-task-handoff-schema.sql`
