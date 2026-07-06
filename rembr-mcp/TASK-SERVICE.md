

 # Task Service (REM-70)

## Overview

The Task Service provides **core CRUD operations** for task management with validation, pagination, soft delete, and assignment tracking. It serves as the foundational layer for all task-related operations in the system.

## Features

1. **CRUD Operations**: Create, Read, Update, Delete tasks
2. **Validation**: Title required, length limits, field constraints
3. **Soft Delete**: Preserve data with deleted_at timestamp
4. **Pagination**: List tasks with limit/offset
5. **Filtering**: Filter by board, status, priority, agent, user
6. **Assignment Tracking**: Assign/unassign tasks to agents
7. **Status Transitions**: Auto-set in_progress_at timestamp
8. **Custom Fields**: Support arbitrary metadata via JSONB

## API

### `createTask(input)`

Creates a new task with validation.

```typescript
const task = await service.createTask({
  board_id: 'board-123',
  title: 'Implement feature X',
  description: 'Detailed description',
  status: 'inbox',           // Optional, defaults to 'inbox'
  priority: 'high',           // Optional, defaults to 'medium'
  assigned_agent_id: 'agent-123',
  created_by_user_id: 'user-456',
  due_at: new Date('2026-12-31'),
  custom_field_values: { estimate: '2h' },
  depends_on_task_ids: ['task-1'],
  blocked_by_task_ids: [],
  tag_ids: ['tag-1', 'tag-2'],
});
```

**Parameters:**
- `board_id` (required): Board containing the task
- `title` (required): Task title (max 500 chars, trimmed)
- `description` (optional): Detailed description (trimmed)
- `status` (optional): Task status (default: 'inbox')
- `priority` (optional): Task priority (default: 'medium')
- `assigned_agent_id` (optional): Agent assigned to task
- `created_by_user_id` (optional): User who created task
- `due_at` (optional): Due date
- `custom_field_values` (optional): Arbitrary metadata (JSONB)
- `depends_on_task_ids` (optional): Task dependencies
- `blocked_by_task_ids` (optional): Blocking tasks
- `tag_ids` (optional): Tags

**Returns:** Created `Task` object

**Throws:**
- `'Task title is required'` if title is empty
- `'Task title must be 500 characters or less'` if too long
- `'Board ID is required'` if board_id missing

**Validation:**
- Title trimmed and validated
- Description trimmed
- Defaults applied for optional fields

### `getTask(id, include_deleted?)`

Fetches a task by ID.

```typescript
// Get active task
const task = await service.getTask('task-123');

// Get task including deleted
const deletedTask = await service.getTask('task-123', true);
```

**Parameters:**
- `id` (required): Task ID
- `include_deleted` (optional): Include soft-deleted tasks (default: false)

**Returns:** `Task` object or `null` if not found

**Behavior:**
- By default, excludes soft-deleted tasks
- Pass `include_deleted: true` to include deleted tasks

### `listTasks(filters?)`

Lists tasks with filtering and pagination.

```typescript
const result = await service.listTasks({
  board_id: 'board-123',
  status: 'inbox',
  priority: 'high',
  assigned_agent_id: 'agent-123',  // Or null for unassigned
  created_by_user_id: 'user-456',
  limit: 20,
  offset: 0,
  include_deleted: false,
});

// Returns:
{
  tasks: [...],       // Array of Task objects
  total: 45,          // Total count (all pages)
  limit: 20,          // Page size
  offset: 0,          // Current offset
}
```

**Filters:**
- `board_id`: Filter by board
- `status`: Filter by status
- `priority`: Filter by priority
- `assigned_agent_id`: Filter by agent (or null for unassigned)
- `created_by_user_id`: Filter by creator
- `limit`: Page size (default: 50)
- `offset`: Page offset (default: 0)
- `include_deleted`: Include soft-deleted tasks (default: false)

**Returns:** `ListTasksResult` with tasks, total, limit, offset

**Ordering:** Tasks ordered by `created_at DESC` (newest first)

**Use Cases:**
- Paginated task lists
- Inbox filtering
- Agent workload queries
- Board views

### `updateTask(id, updates)`

Updates a task with partial changes.

```typescript
const updated = await service.updateTask('task-123', {
  title: 'Updated title',
  status: 'in_progress',
  priority: 'urgent',
  assigned_agent_id: 'agent-456',
  custom_field_values: { estimate: '4h' },
});
```

**Parameters:**
- `id` (required): Task ID
- `updates` (required): Partial updates (only changed fields)

**Updatable Fields:**
- `title`: Task title (validated)
- `description`: Description
- `status`: Status (auto-sets in_progress_at if transitioning)
- `priority`: Priority
- `assigned_agent_id`: Assigned agent
- `due_at`: Due date
- `custom_field_values`: Custom metadata
- `depends_on_task_ids`: Dependencies
- `blocked_by_task_ids`: Blockers
- `tag_ids`: Tags

**Returns:** Updated `Task` object

**Throws:**
- `'Task not found or has been deleted'` if task missing/deleted
- `'Task title cannot be empty'` if title is empty
- `'Task title must be 500 characters or less'` if too long

**Special Behavior:**
- `updated_at` always set to NOW()
- `in_progress_at` set to NOW() when transitioning to 'in_progress' status
- Can't update deleted tasks (throws error)

### `deleteTask(id)`

Soft-deletes a task (sets deleted_at).

```typescript
await service.deleteTask('task-123');
```

**Parameters:**
- `id` (required): Task ID

**Returns:** void

**Throws:**
- `'Task not found or already deleted'` if task missing or already deleted

**Behavior:**
- Sets `deleted_at` to NOW()
- Sets `updated_at` to NOW()
- Task remains in database (soft delete)
- Excluded from queries by default

### `assignTask(id, agentId)`

Assigns a task to an agent.

```typescript
// Assign to agent
await service.assignTask('task-123', 'agent-456');

// Unassign (set to null)
await service.assignTask('task-123', null);
```

**Parameters:**
- `id` (required): Task ID
- `agentId` (required): Agent ID or null to unassign

**Returns:** Updated `Task` object

**Note:** This is a convenience wrapper around `updateTask({ assigned_agent_id })`

### `restoreTask(id)`

Restores a soft-deleted task.

```typescript
const restored = await service.restoreTask('task-123');
```

**Parameters:**
- `id` (required): Task ID

**Returns:** Restored `Task` object

**Throws:**
- `'Task not found or not deleted'` if task not deleted

**Behavior:**
- Sets `deleted_at` to NULL
- Sets `updated_at` to NOW()
- Task becomes visible in queries again

## Data Model

### Task Object

```typescript
interface Task {
  id: string;                          // UUID
  board_id: string;                    // Board UUID
  title: string;                       // Title (max 500 chars)
  description?: string;                // Description (optional)
  status: string;                      // Status (inbox, in_progress, review, done, etc.)
  priority: string;                    // Priority (low, medium, high, urgent)
  assigned_agent_id?: string;          // Assigned agent (optional)
  created_by_user_id?: string;         // Creator user UUID (optional)
  created_at: Date;                    // Creation timestamp
  updated_at: Date;                    // Last update timestamp
  in_progress_at?: Date;               // When moved to in_progress (optional)
  due_at?: Date;                       // Due date (optional)
  deleted_at?: Date;                   // Soft delete timestamp (optional)
  custom_field_values?: Record<string, unknown>; // Custom metadata
  depends_on_task_ids?: string[];      // Task dependencies
  blocked_by_task_ids?: string[];      // Blocking tasks
  tag_ids?: string[];                  // Tags
}
```

## Validation Rules

### Title
- **Required:** Cannot be empty or whitespace-only
- **Max Length:** 500 characters
- **Auto-Trim:** Leading/trailing whitespace removed

### Description
- **Optional:** Can be null/undefined
- **Auto-Trim:** Leading/trailing whitespace removed

### Board ID
- **Required:** Must be provided

### Status
- **Default:** 'inbox' if not provided
- **Auto-Track:** `in_progress_at` set when transitioning to 'in_progress'

### Priority
- **Default:** 'medium' if not provided

## Workflow Examples

### Create and Assign Task

```typescript
// 1. Create task
const task = await service.createTask({
  board_id: 'board-123',
  title: 'Fix critical bug',
  description: 'Users unable to login',
  priority: 'urgent',
  status: 'inbox',
});

// 2. Assign to agent
await service.assignTask(task.id, 'agent-alice');

// 3. Move to in_progress
await service.updateTask(task.id, {
  status: 'in_progress',
});

// 4. Later: mark as done
await service.updateTask(task.id, {
  status: 'done',
});
```

### Paginated Task List

```typescript
const PAGE_SIZE = 20;
let offset = 0;
let hasMore = true;

while (hasMore) {
  const result = await service.listTasks({
    board_id: 'board-123',
    status: 'inbox',
    limit: PAGE_SIZE,
    offset,
  });

  console.log(`Page ${offset / PAGE_SIZE + 1}: ${result.tasks.length} tasks`);

  for (const task of result.tasks) {
    console.log(`- ${task.title} (${task.priority})`);
  }

  offset += PAGE_SIZE;
  hasMore = offset < result.total;
}
```

### Filter Unassigned High-Priority Tasks

```typescript
const result = await service.listTasks({
  priority: 'high',
  assigned_agent_id: null,  // Unassigned
  status: 'inbox',
});

console.log(`Found ${result.total} unassigned high-priority tasks`);

for (const task of result.tasks) {
  console.log(`- ${task.title}`);
}
```

### Soft Delete and Restore

```typescript
// Soft delete
await service.deleteTask('task-123');

// Task not visible in normal queries
const task = await service.getTask('task-123');
console.log(task); // null

// But visible with include_deleted
const deletedTask = await service.getTask('task-123', true);
console.log(deletedTask?.deleted_at); // Date

// Restore
const restored = await service.restoreTask('task-123');
console.log(restored.deleted_at); // null

// Now visible again
const restoredTask = await service.getTask('task-123');
console.log(restoredTask); // Task object
```

## Testing

Run tests with:

```bash
npm test -- task-service.test.ts
```

**Test Coverage (30+ test cases):**

**createTask:**
- Create with required fields
- Create with all fields
- Validation (title required, max length, board_id required)
- Whitespace trimming

**getTask:**
- Get by ID
- Not found returns null
- Exclude deleted by default
- Include deleted with flag

**listTasks:**
- List all tasks
- Filter by board, status, priority, agent, user
- Pagination (limit/offset)
- Exclude/include deleted tasks
- Unassigned filter (assigned_agent_id: null)

**updateTask:**
- Update fields
- in_progress_at tracking
- Custom field updates
- Validation (title required, max length)
- Can't update deleted tasks

**deleteTask:**
- Soft delete task
- Can't delete twice
- Not found error

**assignTask:**
- Assign to agent
- Unassign (null)

**restoreTask:**
- Restore deleted task
- Error if not deleted

## Error Handling

### Common Errors

```typescript
try {
  await service.createTask({ board_id: '', title: '' });
} catch (error) {
  // 'Task title is required'
  // 'Board ID is required'
}

try {
  await service.updateTask('missing-id', { title: 'New' });
} catch (error) {
  // 'Task not found or has been deleted'
}

try {
  await service.deleteTask('already-deleted-id');
} catch (error) {
  // 'Task not found or already deleted'
}
```

## Performance Considerations

### Database Queries

- `createTask`: Single INSERT
- `getTask`: Single SELECT by primary key (indexed)
- `listTasks`: SELECT with WHERE + COUNT (add indexes on filter columns)
- `updateTask`: Single UPDATE by primary key
- `deleteTask`: Single UPDATE by primary key

### Recommended Indexes

```sql
-- For listTasks filtering
CREATE INDEX idx_tasks_board_status ON tasks(board_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_priority ON tasks(priority) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_assigned_agent ON tasks(assigned_agent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_created_by ON tasks(created_by_user_id) WHERE deleted_at IS NULL;

-- For soft delete queries
CREATE INDEX idx_tasks_deleted_at ON tasks(deleted_at);

-- For ordering
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);
```

### Optimization Tips

1. **Pagination:** Always use limit/offset for large result sets
2. **Selective Filtering:** Combine filters to reduce result set size
3. **Index Usage:** Ensure WHERE clauses match index columns
4. **Avoid N+1:** Batch related queries if fetching related data

## Best Practices

1. **Always Validate Input:** Service validates, but consider UI-level validation too
2. **Use Soft Delete:** Preserve data with deleted_at for audit/recovery
3. **Track Status Transitions:** in_progress_at provides timing data
4. **Filter Unassigned:** Use `assigned_agent_id: null` not `''`
5. **Pagination:** Always paginate large lists (default limit: 50)
6. **Custom Fields:** Use for extensibility without schema changes
7. **Idempotent Updates:** updateTask with no changes is safe (returns existing task)

## Integration Examples

### With Work Queue Service

```typescript
import { TaskService } from './task-service';
import { WorkQueueService } from './work-queue';

// 1. Get ready tasks from queue
const readyTasks = await workQueue.getReadyTasks('agent-123', 10);

// 2. Claim task
const claimed = await workQueue.claimTask(readyTasks[0].id, 'agent-123');

if (claimed) {
  // 3. Update task status
  await taskService.updateTask(readyTasks[0].id, {
    status: 'in_progress',
    assigned_agent_id: 'agent-123',
  });

  // 4. Process task...

  // 5. Mark complete
  await taskService.updateTask(readyTasks[0].id, {
    status: 'done',
  });

  // 6. Release lock
  await workQueue.releaseTask(readyTasks[0].id, 'agent-123');
}
```

### With Task Handoff Service

```typescript
import { TaskService } from './task-service';
import { TaskHandoffService } from './task-handoff';

// 1. Create handoff
await handoffService.createHandoff({
  task_id: 'task-123',
  from_agent_id: 'agent-alice',
  to_agent_id: 'agent-bob',
  reason: 'Skills mismatch - requires backend expertise',
});

// 2. Accept handoff (as agent-bob)
await handoffService.acceptHandoff(handoffId, 'agent-bob');

// 3. Update task assignment
await taskService.assignTask('task-123', 'agent-bob');
```

## Future Enhancements

- **Bulk Operations:** Batch create/update/delete
- **Field Validation:** Custom validators per field
- **Audit Log:** Track all changes (who, when, what)
- **Webhooks:** Trigger events on status changes
- **Task Templates:** Create from templates
- **Recurrence:** Recurring task creation
- **Archiving:** Separate from soft delete (completed tasks)

---

**Related:**
- [Work Queue Service](./WORK-QUEUE.md)
- [Task Handoff Service](./TASK-HANDOFF.md)
- [Plan Regeneration Service](./PLAN-REGENERATION.md)
