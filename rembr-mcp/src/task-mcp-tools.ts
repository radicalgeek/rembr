/**
 * Task MCP Tools (REM-71)
 *
 * 4 MCP tools for task management:
 *   manage_task       — CRUD + assign
 *   task_state        — state machine transitions
 *   task_dependencies — DAG management with cycle detection
 *   task_search       — full-text search + filter + aggregate
 */

import type { Pool } from 'pg';
import { TaskService } from './task-service.js';

// ─── State machine ─────────────────────────────────────────────────────────────

export const TASK_STATUSES = ['pending', 'in_progress', 'blocked', 'completed', 'failed'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending:     ['in_progress', 'blocked'],
  in_progress: ['blocked', 'completed', 'failed'],
  blocked:     ['in_progress', 'failed'],
  completed:   [],
  failed:      ['pending'],
};

// ─── Dependency helpers ────────────────────────────────────────────────────────

/**
 * Detect cycles in a directed graph using DFS.
 * Returns true if adding edge from→to would create a cycle.
 */
async function wouldCreateCycle(
  pool: Pool,
  fromId: string,
  toId: string
): Promise<boolean> {
  // BFS/DFS: can we reach fromId starting from toId?
  const visited = new Set<string>();
  const queue = [toId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === fromId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const result = await pool.query(
      `SELECT depends_on_task_ids FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
      [current]
    );
    const deps: string[] = result.rows[0]?.depends_on_task_ids || [];
    queue.push(...deps);
  }
  return false;
}

/**
 * Get the critical path: longest chain from task to a leaf (BFS-based).
 * Returns ordered list of task IDs on the critical path.
 */
async function getCriticalPath(pool: Pool, taskId: string): Promise<string[]> {
  // Forward BFS to find all dependents
  const depResult = await pool.query(
    `SELECT id FROM tasks WHERE $1 = ANY(depends_on_task_ids) AND deleted_at IS NULL`,
    [taskId]
  );

  if (depResult.rows.length === 0) return [taskId];

  // Simple: return direct chain
  const path = [taskId];
  for (const row of depResult.rows) {
    const sub = await getCriticalPath(pool, row.id);
    if (sub.length + 1 > path.length) {
      path.splice(1, path.length - 1, ...sub);
    }
  }
  return path;
}

// ─── manage_task handler ───────────────────────────────────────────────────────

export async function handleManageTask(
  pool: Pool,
  args: Record<string, unknown>,
  tenantId: string
): Promise<unknown> {
  const svc = new TaskService(pool);
  const op = args.operation as string;

  switch (op) {
    case 'create': {
      if (!args.board_id) throw new Error('board_id required');
      if (!args.title) throw new Error('title required');
      const task = await svc.createTask({
        board_id:         args.board_id as string,
        title:            args.title as string,
        description:      args.description as string | undefined,
        status:           (args.status as string | undefined) || 'pending',
        priority:         (args.priority as string | undefined) || 'medium',
        assigned_agent_id: args.assigned_agent_id as string | undefined,
        created_by_user_id: tenantId,
        due_at:           args.due_at ? new Date(args.due_at as string) : undefined,
        depends_on_task_ids: args.depends_on_task_ids as string[] | undefined,
        tag_ids:          args.tag_ids as string[] | undefined,
      });
      return { success: true, task };
    }

    case 'get': {
      if (!args.task_id) throw new Error('task_id required');
      const task = await svc.getTask(args.task_id as string);
      if (!task) throw new Error('Task not found');
      return { success: true, task };
    }

    case 'update': {
      if (!args.task_id) throw new Error('task_id required');
      const task = await svc.updateTask(args.task_id as string, {
        title:            args.title as string | undefined,
        description:      args.description as string | undefined,
        status:           args.status as string | undefined,
        priority:         args.priority as string | undefined,
        assigned_agent_id: args.assigned_agent_id as string | undefined,
        due_at:           args.due_at ? new Date(args.due_at as string) : undefined,
        depends_on_task_ids: args.depends_on_task_ids as string[] | undefined,
        tag_ids:          args.tag_ids as string[] | undefined,
      });
      return { success: true, task };
    }

    case 'delete': {
      if (!args.task_id) throw new Error('task_id required');
      await svc.deleteTask(args.task_id as string);
      return { success: true, deleted: true };
    }

    case 'list': {
      const result = await svc.listTasks({
        board_id:          args.board_id as string | undefined,
        status:            args.status as string | undefined,
        priority:          args.priority as string | undefined,
        assigned_agent_id: args.assigned_agent_id as string | undefined,
        limit:             args.limit as number | undefined,
        offset:            args.offset as number | undefined,
        include_deleted:   args.include_deleted as boolean | undefined,
      });
      return { success: true, ...result };
    }

    case 'assign': {
      if (!args.task_id) throw new Error('task_id required');
      const task = await svc.updateTask(args.task_id as string, {
        assigned_agent_id: (args.agent_id as string | null) ?? undefined,
      });
      return { success: true, task };
    }

    default:
      throw new Error(`Unknown manage_task operation: ${op}`);
  }
}

// ─── task_state handler ────────────────────────────────────────────────────────

export async function handleTaskState(
  pool: Pool,
  args: Record<string, unknown>
): Promise<unknown> {
  const svc = new TaskService(pool);
  const op = args.operation as string;

  switch (op) {
    case 'transition': {
      if (!args.task_id) throw new Error('task_id required');
      if (!args.to_status) throw new Error('to_status required');

      const task = await svc.getTask(args.task_id as string);
      if (!task) throw new Error('Task not found');

      const from = task.status as TaskStatus;
      const to   = args.to_status as TaskStatus;

      if (!TASK_STATUSES.includes(to)) {
        throw new Error(`Invalid status: ${to}. Valid: ${TASK_STATUSES.join(', ')}`);
      }

      const allowed = VALID_TRANSITIONS[from];
      if (!allowed.includes(to)) {
        throw new Error(
          `Invalid transition: ${from} → ${to}. Allowed from ${from}: ${allowed.join(', ') || 'none (terminal)'}`
        );
      }

      const updated = await svc.updateTask(args.task_id as string, {
        status: to,
        ...(args.comment ? { description: task.description } : {}),
      });

      return { success: true, task: updated, transition: { from, to } };
    }

    case 'valid_next': {
      if (!args.task_id) throw new Error('task_id required');
      const task = await svc.getTask(args.task_id as string);
      if (!task) throw new Error('Task not found');
      const valid = VALID_TRANSITIONS[task.status as TaskStatus] || [];
      return { success: true, current_status: task.status, valid_next: valid };
    }

    case 'history': {
      // Tasks table doesn't store transition history yet — return current state
      // as a single-entry history. Full audit trail would require a task_transitions table.
      if (!args.task_id) throw new Error('task_id required');
      const task = await svc.getTask(args.task_id as string);
      if (!task) throw new Error('Task not found');
      return {
        success: true,
        task_id: task.id,
        history: [
          {
            status:     task.status,
            entered_at: task.in_progress_at || task.created_at,
            note:       'current state (full transition history requires task_transitions table)',
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown task_state operation: ${op}`);
  }
}

// ─── task_dependencies handler ─────────────────────────────────────────────────

export async function handleTaskDependencies(
  pool: Pool,
  args: Record<string, unknown>
): Promise<unknown> {
  const svc = new TaskService(pool);
  const op = args.operation as string;

  switch (op) {
    case 'add': {
      if (!args.task_id) throw new Error('task_id required');
      if (!args.depends_on_id) throw new Error('depends_on_id required');

      const taskId     = args.task_id as string;
      const dependsOn  = args.depends_on_id as string;

      if (taskId === dependsOn) throw new Error('A task cannot depend on itself');

      if (await wouldCreateCycle(pool, taskId, dependsOn)) {
        throw new Error(`Adding dependency ${taskId} → ${dependsOn} would create a cycle`);
      }

      const task = await svc.getTask(taskId);
      if (!task) throw new Error('Task not found');

      const existing = task.depends_on_task_ids || [];
      if (existing.includes(dependsOn)) {
        return { success: true, note: 'Dependency already exists', task };
      }

      const updated = await svc.updateTask(taskId, {
        depends_on_task_ids: [...existing, dependsOn],
      });
      return { success: true, task: updated };
    }

    case 'remove': {
      if (!args.task_id) throw new Error('task_id required');
      if (!args.depends_on_id) throw new Error('depends_on_id required');

      const task = await svc.getTask(args.task_id as string);
      if (!task) throw new Error('Task not found');

      const updated = await svc.updateTask(args.task_id as string, {
        depends_on_task_ids: (task.depends_on_task_ids || []).filter(
          id => id !== args.depends_on_id
        ),
      });
      return { success: true, task: updated };
    }

    case 'blocked_by': {
      if (!args.task_id) throw new Error('task_id required');
      const task = await svc.getTask(args.task_id as string);
      if (!task) throw new Error('Task not found');
      const deps = task.depends_on_task_ids || [];

      if (deps.length === 0) return { success: true, task_id: task.id, blocked_by: [] };

      const result = await pool.query(
        `SELECT id, title, status FROM tasks WHERE id = ANY($1) AND deleted_at IS NULL`,
        [deps]
      );
      return { success: true, task_id: task.id, blocked_by: result.rows };
    }

    case 'blocking': {
      if (!args.task_id) throw new Error('task_id required');
      const result = await pool.query(
        `SELECT id, title, status FROM tasks WHERE $1 = ANY(depends_on_task_ids) AND deleted_at IS NULL`,
        [args.task_id]
      );
      return { success: true, task_id: args.task_id, blocking: result.rows };
    }

    case 'cycles': {
      if (!args.board_id) throw new Error('board_id required');
      // Detect all cycles on the board
      const result = await pool.query(
        `SELECT id, depends_on_task_ids FROM tasks WHERE board_id = $1 AND deleted_at IS NULL`,
        [args.board_id]
      );

      const cycles: string[][] = [];
      for (const row of result.rows) {
        for (const dep of (row.depends_on_task_ids || [])) {
          if (await wouldCreateCycle(pool, dep, row.id)) {
            cycles.push([row.id, dep]);
          }
        }
      }

      return { success: true, cycles_found: cycles.length, cycles };
    }

    case 'critical_path': {
      if (!args.task_id) throw new Error('task_id required');
      const path = await getCriticalPath(pool, args.task_id as string);
      return { success: true, task_id: args.task_id, critical_path: path };
    }

    default:
      throw new Error(`Unknown task_dependencies operation: ${op}`);
  }
}

// ─── task_search handler ───────────────────────────────────────────────────────

export async function handleTaskSearch(
  pool: Pool,
  args: Record<string, unknown>
): Promise<unknown> {
  const svc = new TaskService(pool);
  const op = args.operation as string;

  switch (op) {
    case 'search': {
      const query    = args.query as string | undefined;
      const boardId  = args.board_id as string | undefined;
      const limit    = (args.limit as number) || 50;
      const offset   = (args.offset as number) || 0;

      const conditions: string[] = ['deleted_at IS NULL'];
      const values: unknown[]    = [];
      let p = 1;

      if (boardId) {
        conditions.push(`board_id = $${p++}`);
        values.push(boardId);
      }
      if (query) {
        // Full-text search on title + description
        conditions.push(
          `(title ILIKE $${p} OR description ILIKE $${p})`
        );
        values.push(`%${query}%`);
        p++;
      }

      const where = `WHERE ${conditions.join(' AND ')}`;

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM tasks ${where}`,
        values
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const rows = await pool.query(
        `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT $${p++} OFFSET $${p++}`,
        [...values, limit, offset]
      );

      return {
        success: true,
        query,
        tasks: rows.rows,
        total,
        limit,
        offset,
      };
    }

    case 'filter': {
      const result = await svc.listTasks({
        board_id:          args.board_id as string | undefined,
        status:            args.status as string | undefined,
        priority:          args.priority as string | undefined,
        assigned_agent_id: args.assigned_agent_id as string | undefined,
        limit:             (args.limit as number) || 50,
        offset:            (args.offset as number) || 0,
        include_deleted:   args.include_deleted as boolean | undefined,
      });
      return { success: true, ...result };
    }

    case 'aggregate': {
      if (!args.board_id) throw new Error('board_id required');

      const rows = await pool.query(
        `SELECT
           status,
           priority,
           COUNT(*) as count,
           COUNT(assigned_agent_id) as assigned_count,
           COUNT(*) FILTER (WHERE due_at < NOW()) as overdue_count
         FROM tasks
         WHERE board_id = $1 AND deleted_at IS NULL
         GROUP BY status, priority
         ORDER BY status, priority`,
        [args.board_id]
      );

      // Rollup totals
      const totals = await pool.query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'completed') as completed,
           COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
           COUNT(*) FILTER (WHERE status = 'blocked') as blocked,
           COUNT(*) FILTER (WHERE status = 'pending') as pending,
           COUNT(*) FILTER (WHERE status = 'failed') as failed,
           COUNT(*) FILTER (WHERE due_at < NOW() AND status NOT IN ('completed','failed')) as overdue
         FROM tasks
         WHERE board_id = $1 AND deleted_at IS NULL`,
        [args.board_id]
      );

      return {
        success: true,
        board_id:  args.board_id,
        summary:   totals.rows[0],
        breakdown: rows.rows,
      };
    }

    default:
      throw new Error(`Unknown task_search operation: ${op}`);
  }
}

// ─── Acceptance Criteria Tools (RAD-58) ───────────────────────────────────────

import { AcceptanceCriteriaService } from './acceptance-criteria-service.js';

/**
 * manage_acceptance_criteria
 *
 * Unified handler for AC operations:
 *   operation: 'add' | 'validate' | 'status' | 'link_evidence' | 'list' | 'delete'
 */
export async function handleManageAcceptanceCriteria(
  pool: Pool,
  args: Record<string, unknown>,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const svc = new AcceptanceCriteriaService(pool);
  const op  = (args.operation as string) ?? 'status';

  switch (op) {
    case 'add': {
      const taskId           = args.task_id as string;
      const criterion        = args.criterion as string;
      const validationMethod = (args.validation_method as any) ?? 'manual';
      if (!taskId || !criterion) throw new Error('task_id and criterion are required');
      const result = await svc.addCriterion(taskId, criterion, validationMethod, tenantId);
      return { success: true, criterion: result };
    }

    case 'validate': {
      const criterionId  = args.criterion_id as string;
      const evidence     = (args.evidence as Record<string, unknown>) ?? {};
      const status       = (args.status as any) ?? 'passed';
      const validatedBy  = (args.validated_by as string) ?? 'agent';
      if (!criterionId) throw new Error('criterion_id is required');
      const result = await svc.validateCriterion(criterionId, evidence, tenantId, validatedBy, status);
      return { success: true, criterion: result };
    }

    case 'status': {
      const taskId = args.task_id as string;
      if (!taskId) throw new Error('task_id is required');
      const status = await svc.getAcceptanceStatus(taskId, tenantId);
      return { success: true, ...status };
    }

    case 'link_evidence': {
      const criterionId = args.criterion_id as string;
      const memoryIds   = (args.memory_ids as string[]) ?? [];
      if (!criterionId) throw new Error('criterion_id is required');
      const result = await svc.linkEvidence(criterionId, memoryIds, tenantId);
      return { success: true, ...result };
    }

    case 'list': {
      const taskId = args.task_id as string;
      if (!taskId) throw new Error('task_id is required');
      const criteria = await svc.listCriteria(taskId, tenantId);
      return { success: true, criteria, count: criteria.length };
    }

    case 'delete': {
      const criterionId = args.criterion_id as string;
      if (!criterionId) throw new Error('criterion_id is required');
      await svc.deleteCriterion(criterionId, tenantId);
      return { success: true };
    }

    default:
      throw new Error(`Unknown acceptance criteria operation: ${op}`);
  }
}

/** MCP tool definition for manage_acceptance_criteria */
export const acceptanceCriteriaToolDefinition = {
  name: 'manage_acceptance_criteria',
  description: 'Define, validate, and track acceptance criteria for tasks. Link criteria to supporting memory evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['add', 'validate', 'status', 'link_evidence', 'list', 'delete'],
        description: 'Operation: add=create criterion, validate=record evidence, status=overall pass/fail, link_evidence=attach memories, list=all criteria for task, delete=remove criterion',
      },
      task_id: {
        type: 'string',
        description: 'Task UUID (required for: add, status, list)',
      },
      criterion_id: {
        type: 'string',
        description: 'Criterion UUID (required for: validate, link_evidence, delete)',
      },
      criterion: {
        type: 'string',
        description: 'Human-readable acceptance criterion text (required for: add)',
      },
      validation_method: {
        type: 'string',
        enum: ['manual', 'automated', 'review'],
        description: 'How this criterion is validated (default: manual)',
      },
      status: {
        type: 'string',
        enum: ['passed', 'failed', 'skipped'],
        description: 'Validation outcome (required for: validate, default: passed)',
      },
      evidence: {
        type: 'object',
        description: 'Evidence JSON blob — test results, URLs, notes, etc. (for: validate)',
      },
      validated_by: {
        type: 'string',
        description: 'Agent or user ID performing validation (for: validate)',
      },
      memory_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Memory UUIDs to link as supporting evidence (for: link_evidence)',
      },
    },
    required: ['operation'],
  },
} as const;
