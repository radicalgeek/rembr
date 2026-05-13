/**
 * Task Export/Import Service (RAD-41)
 *
 * Enables data portability for RLM workflows with structured export/import.
 * Exports tasks with their dependencies and acceptance criteria (both from the
 * dedicated `acceptance_criteria` table and from custom_field_values for
 * backward-compatibility with simpler storage patterns).
 */

import type { Pool } from 'pg';
import { TaskService, type Task } from './task-service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcceptanceCriterionExport {
  criterion: string;
  validation_method: string;
  status: string;
  evidence?: Record<string, unknown> | null;
  validated_by?: string | null;
  validated_at?: string | null;
}

export interface TaskExportData {
  id: string;
  board_id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  assigned_agent_id?: string;
  created_by_user_id?: string;
  due_at?: string;
  custom_field_values?: Record<string, unknown>;
  depends_on_task_ids?: string[];
  blocked_by_task_ids?: string[];
  tag_ids?: string[];
  /**
   * Acceptance criteria from the dedicated `acceptance_criteria` table.
   * These are restored on import (as pending criteria, preserving text and method).
   */
  acceptance_criteria?: AcceptanceCriterionExport[];
}

export interface TaskExport {
  version: string;
  exported_at: string;
  tasks: TaskExportData[];
}

export interface TaskImportResult {
  imported: number;
  failed: number;
  task_ids: string[];
  criteria_imported: number;
  errors: Array<{ task_title: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Task Export/Import Service
 */
export class TaskExportService {
  private pool: Pool;
  private taskService: TaskService;

  constructor(pool: Pool) {
    this.pool = pool;
    this.taskService = new TaskService(pool);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch acceptance criteria for a task from the dedicated table.
   * Falls back to empty array if the table doesn't exist yet.
   */
  private async fetchAcceptanceCriteria(task_id: string): Promise<AcceptanceCriterionExport[]> {
    try {
      const result = await this.pool.query(
        `SELECT criterion, validation_method, status, evidence, validated_by, validated_at
         FROM acceptance_criteria
         WHERE task_id = $1
         ORDER BY created_at ASC`,
        [task_id],
      );
      return result.rows.map(row => ({
        criterion:         row.criterion,
        validation_method: row.validation_method,
        status:            row.status,
        evidence:          row.evidence ?? null,
        validated_by:      row.validated_by ?? null,
        validated_at:      row.validated_at ? new Date(row.validated_at).toISOString() : null,
      }));
    } catch {
      // Table doesn't exist in this environment — return empty
      return [];
    }
  }

  /**
   * Restore acceptance criteria for an imported task.
   * Criteria are imported as-is (preserving status and evidence) so that
   * exported "done" work is faithfully represented in the target board.
   * Silently skips if the table doesn't exist.
   */
  private async importAcceptanceCriteria(
    task_id: string,
    criteria: AcceptanceCriterionExport[],
    tenant_id: string,
  ): Promise<number> {
    if (criteria.length === 0) return 0;
    let imported = 0;
    try {
      for (const ac of criteria) {
        await this.pool.query(
          `INSERT INTO acceptance_criteria
             (task_id, criterion, validation_method, status, evidence, validated_by, validated_at, tenant_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            task_id,
            ac.criterion,
            ac.validation_method ?? 'manual',
            ac.status ?? 'pending',
            ac.evidence ? JSON.stringify(ac.evidence) : null,
            ac.validated_by ?? null,
            ac.validated_at ? new Date(ac.validated_at) : null,
            tenant_id,
          ],
        );
        imported++;
      }
    } catch {
      // Table doesn't exist — skip silently
    }
    return imported;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Export tasks with all related data:
   *   - task fields + dependencies
   *   - acceptance criteria from the dedicated table
   */
  async exportTasks(task_ids: string[]): Promise<TaskExport> {
    const tasks: TaskExportData[] = [];

    for (const task_id of task_ids) {
      const task = await this.taskService.getTask(task_id);
      if (!task) {
        throw new Error(`Task not found: ${task_id}`);
      }

      const acceptanceCriteria = await this.fetchAcceptanceCriteria(task_id);

      tasks.push({
        id:                  task.id,
        board_id:            task.board_id,
        title:               task.title,
        description:         task.description,
        status:              task.status,
        priority:            task.priority,
        assigned_agent_id:   task.assigned_agent_id,
        created_by_user_id:  task.created_by_user_id,
        due_at:              task.due_at?.toISOString(),
        custom_field_values: task.custom_field_values,
        depends_on_task_ids: task.depends_on_task_ids,
        blocked_by_task_ids: task.blocked_by_task_ids,
        tag_ids:             task.tag_ids,
        acceptance_criteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : undefined,
      });
    }

    return {
      version:     '1.1.0',
      exported_at: new Date().toISOString(),
      tasks,
    };
  }

  /**
   * Import tasks from export data.
   * Acceptance criteria are restored into the dedicated table when present.
   *
   * @param exportData  Structured export from exportTasks()
   * @param board_id    Target board (overrides original board_id when provided)
   * @param tenant_id   Tenant context for AC import (required for AC restore)
   */
  async importTasks(
    exportData: TaskExport,
    board_id?: string,
    tenant_id?: string,
  ): Promise<TaskImportResult> {
    const result: TaskImportResult = {
      imported:          0,
      failed:            0,
      task_ids:          [],
      criteria_imported: 0,
      errors:            [],
    };

    // Validate export data
    if (!exportData.tasks || !Array.isArray(exportData.tasks)) {
      throw new Error('Invalid export data: tasks array missing');
    }

    for (const taskData of exportData.tasks) {
      try {
        const target_board_id = board_id || taskData.board_id;

        const created = await this.taskService.createTask({
          board_id:            target_board_id,
          title:               taskData.title,
          description:         taskData.description,
          status:              taskData.status,
          priority:            taskData.priority,
          assigned_agent_id:   taskData.assigned_agent_id,
          created_by_user_id:  taskData.created_by_user_id,
          due_at:              taskData.due_at ? new Date(taskData.due_at) : undefined,
          custom_field_values: taskData.custom_field_values,
          depends_on_task_ids: taskData.depends_on_task_ids,
          blocked_by_task_ids: taskData.blocked_by_task_ids,
          tag_ids:             taskData.tag_ids,
        });

        result.imported++;
        result.task_ids.push(created.id);

        // Restore acceptance criteria if present
        if (taskData.acceptance_criteria?.length && tenant_id) {
          const acImported = await this.importAcceptanceCriteria(
            created.id,
            taskData.acceptance_criteria,
            tenant_id,
          );
          result.criteria_imported += acImported;
        }
      } catch (error) {
        result.failed++;
        result.errors.push({
          task_title: taskData.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  /**
   * Export a single task with all related data.
   */
  async exportSingleTask(task_id: string): Promise<TaskExportData> {
    const exportData = await this.exportTasks([task_id]);
    if (exportData.tasks.length === 0) {
      throw new Error(`Task not found: ${task_id}`);
    }
    return exportData.tasks[0];
  }

  /**
   * Validate export data structure.
   */
  validateExportData(exportData: unknown): exportData is TaskExport {
    if (typeof exportData !== 'object' || exportData === null) {
      return false;
    }

    const data = exportData as Record<string, unknown>;

    if (typeof data.version !== 'string') {
      return false;
    }

    if (typeof data.exported_at !== 'string') {
      return false;
    }

    if (!Array.isArray(data.tasks)) {
      return false;
    }

    // Validate each task
    for (const task of data.tasks) {
      if (typeof task !== 'object' || task === null) {
        return false;
      }

      const taskData = task as Record<string, unknown>;

      if (typeof taskData.title !== 'string' || !taskData.title) {
        return false;
      }

      if (typeof taskData.board_id !== 'string') {
        return false;
      }
    }

    return true;
  }
}
