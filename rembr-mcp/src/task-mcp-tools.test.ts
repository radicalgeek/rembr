/**
 * Tests for Task MCP Tools (REM-71)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleManageTask,
  handleTaskState,
  handleTaskDependencies,
  handleTaskSearch,
  VALID_TRANSITIONS,
  TASK_STATUSES,
} from './task-mcp-tools.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockTask = {
  id: 'task-1',
  board_id: 'board-1',
  title: 'Test Task',
  description: 'desc',
  status: 'pending',
  priority: 'medium',
  assigned_agent_id: null,
  created_by_user_id: 'tenant-1',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
  in_progress_at: null,
  due_at: null,
  deleted_at: null,
  depends_on_task_ids: [],
  blocked_by_task_ids: [],
  tag_ids: [],
};

vi.mock('./task-service.js', () => {
  return {
    TaskService: vi.fn().mockImplementation(() => ({
      createTask: vi.fn().mockResolvedValue({ ...mockTask, id: 'task-new' }),
      getTask: vi.fn().mockResolvedValue(mockTask),
      updateTask: vi.fn().mockImplementation((_id, updates) =>
        Promise.resolve({ ...mockTask, ...updates })
      ),
      deleteTask: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue({
        tasks: [mockTask],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    })),
  };
});

const mockPool = {
  query: vi.fn(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [] });
});

// ─── manage_task ──────────────────────────────────────────────────────────────

describe('manage_task', () => {
  it('create: returns new task', async () => {
    const result: any = await handleManageTask(
      mockPool,
      { operation: 'create', board_id: 'board-1', title: 'New Task' },
      'tenant-1'
    );
    expect(result.success).toBe(true);
    expect(result.task.id).toBe('task-new');
  });

  it('create: throws if board_id missing', async () => {
    await expect(
      handleManageTask(mockPool, { operation: 'create', title: 'x' }, 'tenant-1')
    ).rejects.toThrow('board_id required');
  });

  it('create: throws if title missing', async () => {
    await expect(
      handleManageTask(mockPool, { operation: 'create', board_id: 'b' }, 'tenant-1')
    ).rejects.toThrow('title required');
  });

  it('get: returns task', async () => {
    const result: any = await handleManageTask(
      mockPool, { operation: 'get', task_id: 'task-1' }, 'tenant-1'
    );
    expect(result.success).toBe(true);
    expect(result.task.id).toBe('task-1');
  });

  it('get: throws if task_id missing', async () => {
    await expect(
      handleManageTask(mockPool, { operation: 'get' }, 'tenant-1')
    ).rejects.toThrow('task_id required');
  });

  it('update: updates task fields', async () => {
    const result: any = await handleManageTask(
      mockPool,
      { operation: 'update', task_id: 'task-1', title: 'Updated' },
      'tenant-1'
    );
    expect(result.success).toBe(true);
    expect(result.task.title).toBe('Updated');
  });

  it('delete: returns deleted true', async () => {
    const result: any = await handleManageTask(
      mockPool, { operation: 'delete', task_id: 'task-1' }, 'tenant-1'
    );
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);
  });

  it('list: returns task list', async () => {
    const result: any = await handleManageTask(
      mockPool, { operation: 'list', board_id: 'board-1' }, 'tenant-1'
    );
    expect(result.success).toBe(true);
    expect(result.tasks).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('assign: assigns agent to task', async () => {
    const result: any = await handleManageTask(
      mockPool,
      { operation: 'assign', task_id: 'task-1', agent_id: 'agent-99' },
      'tenant-1'
    );
    expect(result.success).toBe(true);
  });

  it('unknown op: throws', async () => {
    await expect(
      handleManageTask(mockPool, { operation: 'explode' }, 'tenant-1')
    ).rejects.toThrow('Unknown manage_task operation');
  });
});

// ─── task_state ───────────────────────────────────────────────────────────────

describe('task_state', () => {
  it('valid_next: returns allowed transitions for pending', async () => {
    const result: any = await handleTaskState(
      mockPool, { operation: 'valid_next', task_id: 'task-1' }
    );
    expect(result.success).toBe(true);
    expect(result.valid_next).toContain('in_progress');
    expect(result.valid_next).toContain('blocked');
  });

  it('transition: allows pending → in_progress', async () => {
    const result: any = await handleTaskState(
      mockPool,
      { operation: 'transition', task_id: 'task-1', to_status: 'in_progress' }
    );
    expect(result.success).toBe(true);
    expect(result.transition.from).toBe('pending');
    expect(result.transition.to).toBe('in_progress');
  });

  it('transition: rejects invalid transition pending → completed', async () => {
    await expect(
      handleTaskState(mockPool, { operation: 'transition', task_id: 'task-1', to_status: 'completed' })
    ).rejects.toThrow('Invalid transition: pending → completed');
  });

  it('transition: throws for unknown status', async () => {
    await expect(
      handleTaskState(mockPool, { operation: 'transition', task_id: 'task-1', to_status: 'nonexistent' as any })
    ).rejects.toThrow('Invalid status');
  });

  it('history: returns current state entry', async () => {
    const result: any = await handleTaskState(
      mockPool, { operation: 'history', task_id: 'task-1' }
    );
    expect(result.success).toBe(true);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].status).toBe('pending');
  });

  it('VALID_TRANSITIONS: terminal states have no outgoing', () => {
    expect(VALID_TRANSITIONS.completed).toHaveLength(0);
  });

  it('VALID_TRANSITIONS: failed can retry to pending', () => {
    expect(VALID_TRANSITIONS.failed).toContain('pending');
  });
});

// ─── task_dependencies ────────────────────────────────────────────────────────

describe('task_dependencies', () => {
  it('add: adds dependency', async () => {
    // No cycle — query returns empty
    mockPool.query.mockResolvedValue({ rows: [] });
    const result: any = await handleTaskDependencies(
      mockPool,
      { operation: 'add', task_id: 'task-1', depends_on_id: 'task-2' }
    );
    expect(result.success).toBe(true);
  });

  it('add: rejects self-dependency', async () => {
    await expect(
      handleTaskDependencies(mockPool, { operation: 'add', task_id: 'task-1', depends_on_id: 'task-1' })
    ).rejects.toThrow('cannot depend on itself');
  });

  it('add: rejects cycle', async () => {
    // Simulate: task-2 depends on task-1 already → adding task-1 → task-2 would cycle
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ depends_on_task_ids: ['task-1'] }] }); // BFS finds task-1 from task-2
    await expect(
      handleTaskDependencies(mockPool, { operation: 'add', task_id: 'task-1', depends_on_id: 'task-2' })
    ).rejects.toThrow('would create a cycle');
  });

  it('remove: removes dependency', async () => {
    const result: any = await handleTaskDependencies(
      mockPool,
      { operation: 'remove', task_id: 'task-1', depends_on_id: 'task-2' }
    );
    expect(result.success).toBe(true);
  });

  it('blocked_by: returns upstream tasks', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'task-upstream', title: 'Upstream', status: 'in_progress' }]
    });
    // Override getTask to return task with a dependency
    const { TaskService } = await import('./task-service.js');
    (TaskService as any).mockImplementationOnce(() => ({
      getTask: vi.fn().mockResolvedValue({ ...mockTask, depends_on_task_ids: ['task-upstream'] }),
    }));
    const result: any = await handleTaskDependencies(
      mockPool, { operation: 'blocked_by', task_id: 'task-1' }
    );
    expect(result.success).toBe(true);
  });

  it('blocking: returns downstream tasks', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'task-down', title: 'Downstream', status: 'pending' }]
    });
    const result: any = await handleTaskDependencies(
      mockPool, { operation: 'blocking', task_id: 'task-1' }
    );
    expect(result.success).toBe(true);
    expect(result.blocking).toHaveLength(1);
  });

  it('cycles: returns empty when no cycles', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // No tasks on board
    const result: any = await handleTaskDependencies(
      mockPool, { operation: 'cycles', board_id: 'board-1' }
    );
    expect(result.success).toBe(true);
    expect(result.cycles_found).toBe(0);
  });

  it('critical_path: returns path starting from task', async () => {
    mockPool.query.mockResolvedValue({ rows: [] }); // No dependents
    const result: any = await handleTaskDependencies(
      mockPool, { operation: 'critical_path', task_id: 'task-1' }
    );
    expect(result.success).toBe(true);
    expect(result.critical_path).toContain('task-1');
  });
});

// ─── task_search ──────────────────────────────────────────────────────────────

describe('task_search', () => {
  it('search: full-text query returns results', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [mockTask, mockTask] });
    const result: any = await handleTaskSearch(
      mockPool, { operation: 'search', query: 'test', board_id: 'board-1' }
    );
    expect(result.success).toBe(true);
    expect(result.tasks).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('search: works without query (browse all)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [mockTask] });
    const result: any = await handleTaskSearch(
      mockPool, { operation: 'search', board_id: 'board-1' }
    );
    expect(result.success).toBe(true);
  });

  it('filter: returns structured filter results', async () => {
    const result: any = await handleTaskSearch(
      mockPool,
      { operation: 'filter', board_id: 'board-1', status: 'pending' }
    );
    expect(result.success).toBe(true);
    expect(result.tasks).toHaveLength(1);
  });

  it('aggregate: returns board summary', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ status: 'pending', priority: 'medium', count: '3', assigned_count: '1', overdue_count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ total: '3', completed: '0', in_progress: '0', blocked: '0', pending: '3', failed: '0', overdue: '0' }] });
    const result: any = await handleTaskSearch(
      mockPool, { operation: 'aggregate', board_id: 'board-1' }
    );
    expect(result.success).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.breakdown).toHaveLength(1);
  });

  it('aggregate: throws if board_id missing', async () => {
    await expect(
      handleTaskSearch(mockPool, { operation: 'aggregate' })
    ).rejects.toThrow('board_id required');
  });

  it('unknown op: throws', async () => {
    await expect(
      handleTaskSearch(mockPool, { operation: 'explode' })
    ).rejects.toThrow('Unknown task_search operation');
  });
});

// ─── State machine completeness ───────────────────────────────────────────────

describe('VALID_TRANSITIONS completeness', () => {
  it('all statuses have an entry', () => {
    for (const s of TASK_STATUSES) {
      expect(VALID_TRANSITIONS).toHaveProperty(s);
    }
  });
});
