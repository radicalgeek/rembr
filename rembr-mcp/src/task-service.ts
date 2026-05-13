/**
 * Task Service (REM-70)
 * 
 * Core CRUD operations for task management with validation, pagination, and soft delete.
 */

import type { Pool } from 'pg';

export interface Task {
  id: string;
  board_id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  assigned_agent_id?: string;
  created_by_user_id?: string;
  created_at: Date;
  updated_at: Date;
  in_progress_at?: Date;
  due_at?: Date;
  deleted_at?: Date;
  custom_field_values?: Record<string, unknown>;
  depends_on_task_ids?: string[];
  blocked_by_task_ids?: string[];
  tag_ids?: string[];
}

export interface CreateTaskInput {
  board_id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assigned_agent_id?: string;
  created_by_user_id?: string;
  due_at?: Date;
  custom_field_values?: Record<string, unknown>;
  depends_on_task_ids?: string[];
  blocked_by_task_ids?: string[];
  tag_ids?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assigned_agent_id?: string | null;
  due_at?: Date;
  custom_field_values?: Record<string, unknown>;
  depends_on_task_ids?: string[];
  blocked_by_task_ids?: string[];
  tag_ids?: string[];
}

export interface ListTasksFilters {
  board_id?: string;
  status?: string;
  priority?: string;
  assigned_agent_id?: string;
  created_by_user_id?: string;
  limit?: number;
  offset?: number;
  include_deleted?: boolean;
}

export interface ListTasksResult {
  tasks: Task[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Task Service
 */
export class TaskService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Create a new task
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    // Validation
    if (!input.title || input.title.trim().length === 0) {
      throw new Error('Task title is required');
    }

    if (input.title.length > 500) {
      throw new Error('Task title must be 500 characters or less');
    }

    if (!input.board_id) {
      throw new Error('Board ID is required');
    }

    // Defaults
    const status = input.status || 'inbox';
    const priority = input.priority || 'medium';
    const customFieldValues = input.custom_field_values || {};
    const dependsOnTaskIds = input.depends_on_task_ids || [];
    const blockedByTaskIds = input.blocked_by_task_ids || [];
    const tagIds = input.tag_ids || [];

    const query = `
      INSERT INTO tasks (
        board_id, title, description, status, priority, assigned_agent_id,
        created_by_user_id, due_at, custom_field_values,
        depends_on_task_ids, blocked_by_task_ids, tag_ids
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    const values = [
      input.board_id,
      input.title.trim(),
      input.description?.trim() || null,
      status,
      priority,
      input.assigned_agent_id || null,
      input.created_by_user_id || null,
      input.due_at || null,
      JSON.stringify(customFieldValues),
      dependsOnTaskIds,
      blockedByTaskIds,
      tagIds,
    ];

    const result = await this.pool.query(query, values);
    return this.mapRowToTask(result.rows[0]);
  }

  /**
   * Get a task by ID
   */
  async getTask(id: string, include_deleted = false): Promise<Task | null> {
    const query = include_deleted
      ? `SELECT * FROM tasks WHERE id = $1`
      : `SELECT * FROM tasks WHERE id = $1 AND deleted_at IS NULL`;

    const result = await this.pool.query(query, [id]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToTask(result.rows[0]);
  }

  /**
   * List tasks with filters and pagination
   */
  async listTasks(filters: ListTasksFilters = {}): Promise<ListTasksResult> {
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    // Build WHERE clause
    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (!filters.include_deleted) {
      whereClauses.push('deleted_at IS NULL');
    }

    if (filters.board_id) {
      whereClauses.push(`board_id = $${paramIndex++}`);
      values.push(filters.board_id);
    }

    if (filters.status) {
      whereClauses.push(`status = $${paramIndex++}`);
      values.push(filters.status);
    }

    if (filters.priority) {
      whereClauses.push(`priority = $${paramIndex++}`);
      values.push(filters.priority);
    }

    if (filters.assigned_agent_id !== undefined) {
      if (filters.assigned_agent_id === null || filters.assigned_agent_id === '') {
        whereClauses.push('assigned_agent_id IS NULL');
      } else {
        whereClauses.push(`assigned_agent_id = $${paramIndex++}`);
        values.push(filters.assigned_agent_id);
      }
    }

    if (filters.created_by_user_id) {
      whereClauses.push(`created_by_user_id = $${paramIndex++}`);
      values.push(filters.created_by_user_id);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Count total
    const countQuery = `SELECT COUNT(*) as count FROM tasks ${whereClause}`;
    const countResult = await this.pool.query(countQuery, values);
    const total = parseInt(countResult.rows[0].count, 10);

    // Fetch tasks
    const query = `
      SELECT * FROM tasks
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const tasksResult = await this.pool.query(query, [...values, limit, offset]);
    const tasks = tasksResult.rows.map(row => this.mapRowToTask(row));

    return {
      tasks,
      total,
      limit,
      offset,
    };
  }

  /**
   * Update a task
   */
  async updateTask(id: string, updates: UpdateTaskInput): Promise<Task> {
    // Validation
    if (updates.title !== undefined) {
      if (!updates.title || updates.title.trim().length === 0) {
        throw new Error('Task title cannot be empty');
      }
      if (updates.title.length > 500) {
        throw new Error('Task title must be 500 characters or less');
      }
    }

    // Check if task exists and is not deleted
    const existing = await this.getTask(id, false);
    if (!existing) {
      throw new Error('Task not found or has been deleted');
    }

    // Build UPDATE SET clause
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.title !== undefined) {
      setClauses.push(`title = $${paramIndex++}`);
      values.push(updates.title.trim());
    }

    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(updates.description?.trim() || null);
    }

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);

      // Set in_progress_at if transitioning to in_progress
      if (updates.status === 'in_progress' && existing.status !== 'in_progress') {
        setClauses.push(`in_progress_at = NOW()`);
      }
    }

    if (updates.priority !== undefined) {
      setClauses.push(`priority = $${paramIndex++}`);
      values.push(updates.priority);
    }

    if (updates.assigned_agent_id !== undefined) {
      setClauses.push(`assigned_agent_id = $${paramIndex++}`);
      values.push(updates.assigned_agent_id || null);
    }

    if (updates.due_at !== undefined) {
      setClauses.push(`due_at = $${paramIndex++}`);
      values.push(updates.due_at || null);
    }

    if (updates.custom_field_values !== undefined) {
      setClauses.push(`custom_field_values = $${paramIndex++}`);
      values.push(JSON.stringify(updates.custom_field_values));
    }

    if (updates.depends_on_task_ids !== undefined) {
      setClauses.push(`depends_on_task_ids = $${paramIndex++}`);
      values.push(updates.depends_on_task_ids);
    }

    if (updates.blocked_by_task_ids !== undefined) {
      setClauses.push(`blocked_by_task_ids = $${paramIndex++}`);
      values.push(updates.blocked_by_task_ids);
    }

    if (updates.tag_ids !== undefined) {
      setClauses.push(`tag_ids = $${paramIndex++}`);
      values.push(updates.tag_ids);
    }

    // Always update updated_at
    setClauses.push(`updated_at = NOW()`);

    if (setClauses.length === 0) {
      // No updates provided
      return existing;
    }

    const query = `
      UPDATE tasks
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex++} AND deleted_at IS NULL
      RETURNING *
    `;

    values.push(id);

    const result = await this.pool.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Task not found or has been deleted');
    }

    return this.mapRowToTask(result.rows[0]);
  }

  /**
   * Soft delete a task
   */
  async deleteTask(id: string): Promise<void> {
    const query = `
      UPDATE tasks
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id
    `;

    const result = await this.pool.query(query, [id]);

    if (result.rows.length === 0) {
      throw new Error('Task not found or already deleted');
    }
  }

  /**
   * Assign a task to an agent
   */
  async assignTask(id: string, agentId: string | null): Promise<Task> {
    return this.updateTask(id, { assigned_agent_id: agentId });
  }

  /**
   * Restore a soft-deleted task
   */
  async restoreTask(id: string): Promise<Task> {
    const query = `
      UPDATE tasks
      SET deleted_at = NULL, updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NOT NULL
      RETURNING *
    `;

    const result = await this.pool.query(query, [id]);

    if (result.rows.length === 0) {
      throw new Error('Task not found or not deleted');
    }

    return this.mapRowToTask(result.rows[0]);
  }

  /**
   * Map database row to Task object
   */
  private mapRowToTask(row: any): Task {
    return {
      id: row.id,
      board_id: row.board_id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assigned_agent_id: row.assigned_agent_id,
      created_by_user_id: row.created_by_user_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      in_progress_at: row.in_progress_at,
      due_at: row.due_at,
      deleted_at: row.deleted_at,
      custom_field_values: row.custom_field_values || {},
      depends_on_task_ids: row.depends_on_task_ids || [],
      blocked_by_task_ids: row.blocked_by_task_ids || [],
      tag_ids: row.tag_ids || [],
    };
  }
}
