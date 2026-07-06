# Work Queue Service (REM-72)

## Overview

The Work Queue Service provides **Redis-backed task distribution** with race-condition-safe locking. It enables concurrent agents to claim tasks from a priority queue without conflicts, ensuring each task is processed by exactly one agent at a time.

## Core Capabilities

1. **Priority Queue**: Tasks ordered by priority (urgent > high > medium > low) then creation time
2. **Race-Condition Safety**: Redis-based atomic locking prevents concurrent claims
3. **Agent Workload Tracking**: Track claimed tasks per agent
4. **Queue Statistics**: Real-time queue health metrics
5. **Auto-Expiring Locks**: Locks expire after 30 minutes (configurable TTL)

## Architecture

### Redis Keys

```
task:lock:{taskId}         → Agent ID (lock owner)
agent:workload:{agentId}   → Set of task IDs
```

### Locking Strategy

- **SET NX**: Atomic "set if not exists" ensures only one agent can claim
- **TTL**: 30-minute expiration prevents stuck locks from crashed agents
- **Ownership Verification**: Release operations verify agent owns the lock

### Priority Ordering

```
Priority Weights:
- urgent: 4
- high: 3
- medium: 2
- low: 1

Order: priority DESC, created_at ASC
```

## API

### `getReadyTasks(agentId, limit)`

Returns tasks available for claiming, ordered by priority.

```typescript
const tasks = await service.getReadyTasks('agent-123', 10);

// Returns:
[
  {
    id: 'task-1',
    title: 'Critical bug fix',
    priority: 'urgent',
    status: 'inbox',
    created_at: Date,
    metadata: { ... }
  },
  ...
]
```

**Parameters:**
- `agentId`: Agent requesting tasks (used for logging/audit)
- `limit`: Maximum tasks to return (default: 10)

**Returns:** Array of `Task` ordered by priority, filtered to exclude locked tasks

**Filtering:**
- Status must be `'inbox'`
- Task must not be locked in Redis
- Ordered by priority weight DESC, then `created_at` ASC

### `claimTask(taskId, agentId)`

Atomically claims a task for an agent.

```typescript
const claimed = await service.claimTask('task-123', 'agent-alice');

if (claimed) {
  console.log('Task claimed successfully');
} else {
  console.log('Task already claimed by another agent');
}
```

**Parameters:**
- `taskId`: Task to claim
- `agentId`: Agent claiming the task

**Returns:** `true` if claim succeeded, `false` if task already locked

**Side Effects:**
- Creates Redis lock: `task:lock:{taskId}` → `agentId` (TTL: 30 min)
- Adds task to agent workload set: `agent:workload:{agentId}`

**Race Condition Safety:**
- Uses Redis `SET NX` (set if not exists) for atomic lock acquisition
- Only one agent can acquire lock even with concurrent claims

### `releaseTask(taskId, agentId?)`

Releases a claimed task.

```typescript
// Release with ownership verification
await service.releaseTask('task-123', 'agent-alice');

// Force release (admin/cleanup)
await service.releaseTask('task-123');
```

**Parameters:**
- `taskId`: Task to release
- `agentId`: (Optional) Agent releasing the task. If provided, verifies ownership.

**Throws:** Error if `agentId` provided and doesn't match lock owner

**Side Effects:**
- Removes Redis lock: `task:lock:{taskId}`
- Removes task from agent workload set

**Use Cases:**
- Agent completes task
- Agent aborts/requeues task
- Admin force-releases stuck task

### `getAgentWorkload(agentId)`

Returns current workload for an agent.

```typescript
const workload = await service.getAgentWorkload('agent-alice');

// Returns:
{
  agent_id: 'agent-alice',
  claimed_tasks: 3,
  task_ids: ['task-1', 'task-2', 'task-3']
}
```

**Returns:** `AgentWorkload` with count and list of claimed task IDs

**Use Cases:**
- Capacity planning (don't claim if at max capacity)
- Agent dashboard
- Load balancing

### `getQueueStats()`

Returns overall queue health statistics.

```typescript
const stats = await service.getQueueStats();

// Returns:
{
  ready_tasks: 25,        // Total inbox tasks
  claimed_tasks: 10,      // Currently locked tasks
  total_agents: 5,        // Agents with workload
  active_agents: 5,       // Same as total_agents
  avg_workload: 2.0       // Average tasks per agent
}
```

**Returns:** `QueueStats` with queue health metrics

**Metrics:**
- `ready_tasks`: Total tasks in inbox status (DB count)
- `claimed_tasks`: Tasks currently locked (Redis count)
- `active_agents`: Agents with non-zero workload
- `avg_workload`: Average tasks per active agent

**Use Cases:**
- Queue health monitoring
- Scaling decisions (add agents if avg_workload > threshold)
- Dashboards and alerts

## Workflow Example

### Agent Claims and Processes Task

```typescript
const service = new WorkQueueService(pool, redis);

// 1. Check agent capacity
const workload = await service.getAgentWorkload('agent-alice');
if (workload.claimed_tasks >= MAX_CAPACITY) {
  console.log('Agent at capacity');
  return;
}

// 2. Get ready tasks
const tasks = await service.getReadyTasks('agent-alice', 10);
if (tasks.length === 0) {
  console.log('No tasks available');
  return;
}

// 3. Try to claim highest priority task
const task = tasks[0];
const claimed = await service.claimTask(task.id, 'agent-alice');

if (!claimed) {
  console.log('Task already claimed by another agent');
  return;
}

// 4. Process task
try {
  await processTask(task);
  
  // 5. Update task status in DB
  await pool.query(`
    UPDATE tasks SET status = 'completed', updated_at = NOW()
    WHERE id = $1
  `, [task.id]);
  
} catch (error) {
  console.error('Task processing failed:', error);
  
  // Update task status to failed
  await pool.query(`
    UPDATE tasks SET status = 'failed', updated_at = NOW()
    WHERE id = $1
  `, [task.id]);
  
} finally {
  // 6. Always release lock
  await service.releaseTask(task.id, 'agent-alice');
}
```

### Concurrent Agent Claims (Race Condition Safe)

```typescript
// Two agents try to claim same task concurrently
const [result1, result2] = await Promise.all([
  service.claimTask('task-123', 'agent-alice'),
  service.claimTask('task-123', 'agent-bob'),
]);

// Exactly one will succeed
console.log(result1); // true
console.log(result2); // false

// Only Alice has the lock
const lockOwner = await redis.get('task:lock:task-123');
console.log(lockOwner); // 'agent-alice'
```

## Lock Expiration

Locks automatically expire after **30 minutes** (configurable via `LOCK_TTL_SECONDS`).

**Why TTL?**
- Prevents stuck locks if agent crashes
- No manual cleanup needed for failed agents
- Tasks automatically become available again

**Tuning TTL:**

```typescript
// In work-queue.ts
const LOCK_TTL_SECONDS = 60 * 60; // 1 hour for long-running tasks
```

**Trade-offs:**
- **Short TTL (5-10 min)**: Fast recovery, but may expire during long tasks
- **Long TTL (1+ hour)**: Supports long tasks, but slow recovery on crashes
- **Recommended: 30 min**: Good balance for most use cases

## Priority Handling

Tasks are ordered by:
1. **Priority** (urgent > high > medium > low)
2. **Created time** (oldest first within same priority)

**Example:**

```
Tasks in inbox:
- task-1: urgent,  created 10 min ago
- task-2: high,    created 5 min ago
- task-3: urgent,  created 2 min ago
- task-4: medium,  created 1 min ago

getReadyTasks() returns:
1. task-1 (urgent, oldest)
2. task-3 (urgent, newest)
3. task-2 (high)
4. task-4 (medium)
```

## Error Handling

### Claim Failure

```typescript
const claimed = await service.claimTask(taskId, agentId);

if (!claimed) {
  // Task already claimed - try next task
  console.log('Task already claimed, moving to next');
}
```

### Release Ownership Violation

```typescript
try {
  await service.releaseTask(taskId, agentId);
} catch (error) {
  console.error('Cannot release task: not owned by this agent');
  // Only owner can release, or use force release without agentId
}
```

### Redis Connection Issues

```typescript
try {
  const tasks = await service.getReadyTasks(agentId);
} catch (error) {
  if (error.message.includes('Redis connection')) {
    console.error('Redis unavailable - queue service degraded');
    // Fallback: query DB directly without locking (less safe)
  }
}
```

## Testing

Run tests with:

```bash
# Requires Redis running on localhost:6379
npm test -- work-queue.test.ts
```

**Test Coverage:**
- Priority ordering
- Race condition safety (concurrent claims)
- Lock acquisition and release
- Workload tracking
- Queue statistics
- TTL expiration
- Ownership verification
- Error handling

**23 test cases covering:**
- getReadyTasks() ordering and filtering
- claimTask() atomicity
- releaseTask() ownership
- getAgentWorkload() accuracy
- getQueueStats() calculations
- Concurrent claim scenarios

## Performance Considerations

### Redis Operations

- `getReadyTasks()`: O(n log n) DB query + O(n) Redis checks
- `claimTask()`: O(1) Redis SET NX + SADD
- `releaseTask()`: O(1) Redis DEL + SREM
- `getAgentWorkload()`: O(n) Redis SMEMBERS
- `getQueueStats()`: O(n) Redis KEYS + SCARD (expensive at scale)

### Optimization Tips

1. **Limit getQueueStats() frequency**: Use caching or polling interval
2. **Avoid KEYS in production**: Consider sorted sets for lock tracking
3. **Batch claims**: Claim multiple tasks in one workflow iteration
4. **Use Redis pipelining**: Batch Redis commands for workload updates

### Scaling

- **Redis**: Single Redis instance handles 10k+ ops/sec
- **Horizontal Scaling**: Agents scale independently (stateless)
- **Queue Depth**: DB query performance degrades with 100k+ inbox tasks

## Monitoring

### Queue Health

```sql
-- Tasks waiting (inbox)
SELECT COUNT(*) FROM tasks WHERE status = 'inbox';

-- Tasks in progress
SELECT COUNT(*) FROM tasks WHERE status = 'in_progress';

-- Oldest waiting task
SELECT MIN(created_at) FROM tasks WHERE status = 'inbox';
```

### Redis Health

```bash
# Locked tasks
redis-cli KEYS "task:lock:*" | wc -l

# Agent workloads
redis-cli KEYS "agent:workload:*" | wc -l

# Specific agent workload
redis-cli SMEMBERS agent:workload:agent-alice
```

### Alerting

```typescript
const stats = await service.getQueueStats();

if (stats.avg_workload > 10) {
  alert('High agent workload - consider scaling');
}

if (stats.ready_tasks > 100 && stats.active_agents < 3) {
  alert('Queue backlog building - add agents');
}
```

## Best Practices

1. **Always Release Locks**: Use try/finally to ensure release
2. **Check Capacity**: Don't claim if agent at max capacity
3. **Handle Claim Failures**: Task may be claimed between getReadyTasks() and claimTask()
4. **Update DB Status**: After claiming, update task status to `in_progress`
5. **Monitor Queue Stats**: Alert on high workload or backlog
6. **Tune TTL**: Match TTL to typical task duration
7. **Graceful Shutdown**: Release all locks before agent shutdown

## Future Enhancements

- **Dead Letter Queue**: Move expired tasks to DLQ for investigation
- **Priority Boost**: Auto-increase priority for old tasks
- **Agent Affinity**: Prefer tasks matching agent skills
- **Batch Claiming**: Claim multiple tasks atomically
- **Metrics Export**: Prometheus metrics for monitoring
- **Distributed Locking**: Redlock algorithm for HA Redis

---

**Related:**
- [Task Handoff Service](./TASK-HANDOFF.md)
- [Plan Regeneration Service](./PLAN-REGENERATION.md)
- Redis: https://redis.io/
- Work Queue Pattern: https://www.enterpriseintegrationpatterns.com/patterns/messaging/CompetingConsumers.html
