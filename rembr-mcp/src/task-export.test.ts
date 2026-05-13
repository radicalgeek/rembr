/**
 * Task Export/Import Service Tests (RAD-41)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { TaskExportService } from './task-export.js';
import { TaskService } from './task-service.js';

// Use a unique board ID to avoid cross-file contamination with task-service.test.ts
// which uses 550e8400-e29b-41d4-a716-446655440000 (Vitest runs files in parallel)
const TEST_BOARD_ID = '550e8400-e29b-41d4-a716-446655440100';
const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440099';

// Share a single pool across all tests to avoid connection churn on slow CI runners.
let testPool: Pool;
let exportService: TaskExportService;
let taskService: TaskService;

beforeAll(async () => {
  testPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test',
  });

  // Create tasks table
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      board_id UUID NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'inbox',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      assigned_agent_id TEXT,
      created_by_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      in_progress_at TIMESTAMPTZ,
      due_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      custom_field_values JSONB DEFAULT '{}'::jsonb,
      depends_on_task_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
      blocked_by_task_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
      tag_ids TEXT[] DEFAULT ARRAY[]::TEXT[]
    )
  `);

  // Create acceptance_criteria table (mirrors RAD-58 migration)
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS acceptance_criteria (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL,
      criterion TEXT NOT NULL,
      validation_method VARCHAR(20) NOT NULL DEFAULT 'manual',
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      evidence JSONB,
      validated_at TIMESTAMPTZ,
      validated_by TEXT,
      tenant_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
});

afterAll(async () => {
  await testPool.end();
});

beforeEach(() => {
  exportService = new TaskExportService(testPool);
  taskService = new TaskService(testPool);
});

afterEach(async () => {
  await testPool.query('DELETE FROM acceptance_criteria WHERE tenant_id = $1', [TEST_TENANT_ID]);
  await testPool.query('DELETE FROM tasks WHERE board_id = $1', [TEST_BOARD_ID]);
});

// ---------------------------------------------------------------------------
// exportTasks
// ---------------------------------------------------------------------------

describe('Task Export/Import Service (RAD-41)', () => {
  describe('exportTasks', () => {
    it('should export a single task with core fields', async () => {
      const task = await taskService.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Test Task',
        description: 'Test description',
        status: 'in_progress',
        priority: 'high',
      });

      const exportData = await exportService.exportTasks([task.id]);

      expect(exportData.version).toBe('1.1.0');
      expect(exportData.exported_at).toBeDefined();
      expect(exportData.tasks).toHaveLength(1);

      const exported = exportData.tasks[0];
      expect(exported.id).toBe(task.id);
      expect(exported.title).toBe('Test Task');
      expect(exported.description).toBe('Test description');
      expect(exported.status).toBe('in_progress');
      expect(exported.priority).toBe('high');
    });

    it('should export multiple tasks', async () => {
      const task1 = await taskService.createTask({ board_id: TEST_BOARD_ID, title: 'Task 1' });
      const task2 = await taskService.createTask({ board_id: TEST_BOARD_ID, title: 'Task 2' });

      const exportData = await exportService.exportTasks([task1.id, task2.id]);

      expect(exportData.tasks).toHaveLength(2);
      expect(exportData.tasks[0].title).toBe('Task 1');
      expect(exportData.tasks[1].title).toBe('Task 2');
    });

    it('should export task with dependencies', async () => {
      const task1 = await taskService.createTask({ board_id: TEST_BOARD_ID, title: 'Task 1' });
      const task2 = await taskService.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task 2',
        depends_on_task_ids: [task1.id],
        blocked_by_task_ids: [task1.id],
      });

      const exportData = await exportService.exportTasks([task2.id]);

      expect(exportData.tasks[0].depends_on_task_ids).toEqual([task1.id]);
      expect(exportData.tasks[0].blocked_by_task_ids).toEqual([task1.id]);
    });

    it('should export acceptance criteria from the dedicated table', async () => {
      const task = await taskService.createTask({ board_id: TEST_BOARD_ID, title: 'Task with AC' });

      // Insert AC directly into the table (simulating what AcceptanceCriteriaService would do)
      await testPool.query(
        `INSERT INTO acceptance_criteria (task_id, criterion, validation_method, status, tenant_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [task.id, 'All unit tests pass', 'automated', 'passed', TEST_TENANT_ID],
      );
      await testPool.query(
        `INSERT INTO acceptance_criteria (task_id, criterion, validation_method, status, tenant_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [task.id, 'Code reviewed', 'review', 'pending', TEST_TENANT_ID],
      );

      const exportData = await exportService.exportTasks([task.id]);
      const exported = exportData.tasks[0];

      expect(exported.acceptance_criteria).toHaveLength(2);
      expect(exported.acceptance_criteria![0].criterion).toBe('All unit tests pass');
      expect(exported.acceptance_criteria![0].validation_method).toBe('automated');
      expect(exported.acceptance_criteria![0].status).toBe('passed');
      expect(exported.acceptance_criteria![1].criterion).toBe('Code reviewed');
      expect(exported.acceptance_criteria![1].status).toBe('pending');
    });

    it('should omit acceptance_criteria key when no AC exist', async () => {
      const task = await taskService.createTask({ board_id: TEST_BOARD_ID, title: 'No AC task' });

      const exportData = await exportService.exportTasks([task.id]);

      expect(exportData.tasks[0].acceptance_criteria).toBeUndefined();
    });

    it('should throw error for non-existent task', async () => {
      await expect(
        exportService.exportTasks(['550e8400-0000-0000-0000-000000000999']),
      ).rejects.toThrow('Task not found');
    });
  });

  // ---------------------------------------------------------------------------
  // importTasks
  // ---------------------------------------------------------------------------

  describe('importTasks', () => {
    it('should import a single task', async () => {
      const exportData = {
        version: '1.1.0',
        exported_at: new Date().toISOString(),
        tasks: [{
          id: '550e8400-e29b-41d4-a716-446655440001',
          board_id: TEST_BOARD_ID,
          title: 'Imported Task',
          description: 'Imported description',
          status: 'inbox',
          priority: 'medium',
        }],
      };

      const result = await exportService.importTasks(exportData);

      expect(result.imported).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.task_ids).toHaveLength(1);

      const imported = await taskService.getTask(result.task_ids[0]);
      expect(imported).toBeDefined();
      expect(imported!.title).toBe('Imported Task');
      expect(imported!.description).toBe('Imported description');
    });

    it('should import acceptance criteria when tenant_id is provided', async () => {
      const exportData = {
        version: '1.1.0',
        exported_at: new Date().toISOString(),
        tasks: [{
          id: '550e8400-e29b-41d4-a716-446655440008',
          board_id: TEST_BOARD_ID,
          title: 'Task with AC',
          status: 'inbox',
          priority: 'medium',
          acceptance_criteria: [
            {
              criterion: 'All tests pass',
              validation_method: 'automated',
              status: 'passed',
              evidence: null,
              validated_by: 'ci',
              validated_at: null,
            },
            {
              criterion: 'Reviewed by lead',
              validation_method: 'review',
              status: 'pending',
              evidence: null,
              validated_by: null,
              validated_at: null,
            },
          ],
        }],
      };

      const result = await exportService.importTasks(exportData, undefined, TEST_TENANT_ID);

      expect(result.imported).toBe(1);
      expect(result.criteria_imported).toBe(2);

      const acRows = await testPool.query(
        'SELECT criterion, status FROM acceptance_criteria WHERE task_id = $1 ORDER BY created_at',
        [result.task_ids[0]],
      );
      expect(acRows.rows).toHaveLength(2);
      expect(acRows.rows[0].criterion).toBe('All tests pass');
      expect(acRows.rows[0].status).toBe('passed');
      expect(acRows.rows[1].criterion).toBe('Reviewed by lead');
    });

    it('should not fail when no tenant_id provided (AC silently skipped)', async () => {
      const exportData = {
        version: '1.1.0',
        exported_at: new Date().toISOString(),
        tasks: [{
          id: '550e8400-e29b-41d4-a716-446655440009',
          board_id: TEST_BOARD_ID,
          title: 'Task',
          status: 'inbox',
          priority: 'medium',
          acceptance_criteria: [
            { criterion: 'Test', validation_method: 'manual', status: 'pending', evidence: null, validated_by: null, validated_at: null },
          ],
        }],
      };

      const result = await exportService.importTasks(exportData);
      expect(result.imported).toBe(1);
      expect(result.criteria_imported).toBe(0);
    });

    it('should import to a different board_id when specified', async () => {
      const targetBoardId = '550e8400-e29b-41d4-a716-446655440002';

      const exportData = {
        version: '1.1.0',
        exported_at: new Date().toISOString(),
        tasks: [{
          id: '550e8400-e29b-41d4-a716-446655440003',
          board_id: TEST_BOARD_ID,
          title: 'Task to move',
          status: 'inbox',
          priority: 'medium',
        }],
      };

      const result = await exportService.importTasks(exportData, targetBoardId);

      expect(result.imported).toBe(1);

      const imported = await testPool.query('SELECT board_id FROM tasks WHERE id = $1', [result.task_ids[0]]);
      expect(imported.rows[0].board_id).toBe(targetBoardId);

      await testPool.query('DELETE FROM tasks WHERE board_id = $1', [targetBoardId]);
    });

    it('should handle import failures gracefully', async () => {
      const exportData = {
        version: '1.1.0',
        exported_at: new Date().toISOString(),
        tasks: [
          {
            id: '550e8400-e29b-41d4-a716-446655440004',
            board_id: TEST_BOARD_ID,
            title: '', // Invalid: empty title
            status: 'inbox',
            priority: 'medium',
          },
          {
            id: '550e8400-e29b-41d4-a716-446655440005',
            board_id: TEST_BOARD_ID,
            title: 'Valid task',
            status: 'inbox',
            priority: 'medium',
          },
        ],
      };

      const result = await exportService.importTasks(exportData);

      expect(result.imported).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('title');
    });

    it('should throw error for invalid export data', async () => {
      await expect(
        exportService.importTasks({ invalid: 'data' } as any),
      ).rejects.toThrow('Invalid export data');
    });
  });

  // ---------------------------------------------------------------------------
  // exportSingleTask
  // ---------------------------------------------------------------------------

  describe('exportSingleTask', () => {
    it('should export a single task', async () => {
      const task = await taskService.createTask({ board_id: TEST_BOARD_ID, title: 'Single Task' });

      const exported = await exportService.exportSingleTask(task.id);

      expect(exported.id).toBe(task.id);
      expect(exported.title).toBe('Single Task');
    });

    it('should throw error for non-existent task', async () => {
      await expect(
        exportService.exportSingleTask('550e8400-0000-0000-0000-000000000999'),
      ).rejects.toThrow('Task not found');
    });
  });

  // ---------------------------------------------------------------------------
  // validateExportData
  // ---------------------------------------------------------------------------

  describe('validateExportData', () => {
    it('should validate correct export data', () => {
      const valid = {
        version: '1.1.0',
        exported_at: new Date().toISOString(),
        tasks: [{
          id: '550e8400-e29b-41d4-a716-446655440006',
          board_id: TEST_BOARD_ID,
          title: 'Valid task',
          status: 'inbox',
          priority: 'medium',
        }],
      };

      expect(exportService.validateExportData(valid)).toBe(true);
    });

    it('should accept v1.0.0 exports (backward compat)', () => {
      const v1 = {
        version: '1.0.0',
        exported_at: new Date().toISOString(),
        tasks: [{
          id: '550e8400-e29b-41d4-a716-446655440010',
          board_id: TEST_BOARD_ID,
          title: 'Old format task',
          status: 'inbox',
          priority: 'medium',
        }],
      };
      expect(exportService.validateExportData(v1)).toBe(true);
    });

    it('should reject invalid export data', () => {
      expect(exportService.validateExportData(null)).toBe(false);
      expect(exportService.validateExportData({})).toBe(false);
      expect(exportService.validateExportData({ version: '1.1.0' })).toBe(false);
      expect(exportService.validateExportData({
        version: '1.1.0',
        exported_at: new Date().toISOString(),
        tasks: 'not-an-array',
      })).toBe(false);
    });

    it('should reject tasks with missing required fields', () => {
      const invalid = {
        version: '1.1.0',
        exported_at: new Date().toISOString(),
        tasks: [{
          id: '550e8400-e29b-41d4-a716-446655440007',
          // Missing title
          board_id: TEST_BOARD_ID,
        }],
      };

      expect(exportService.validateExportData(invalid)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip
  // ---------------------------------------------------------------------------

  describe('round-trip', () => {
    it('should preserve all task data through export → import', async () => {
      const original = await taskService.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Round-trip Task',
        description: 'Test description',
        status: 'in_progress',
        priority: 'high',
        custom_field_values: {
          acceptance_criteria: ['Criterion 1', 'Criterion 2'],
          custom_field: 'custom_value',
        },
        tag_ids: ['550e8400-0000-0000-0000-000000000001', '550e8400-0000-0000-0000-000000000002'],
      });

      const exportData = await exportService.exportTasks([original.id]);
      await taskService.deleteTask(original.id);

      const importResult = await exportService.importTasks(exportData);

      expect(importResult.imported).toBe(1);
      expect(importResult.failed).toBe(0);

      const imported = await taskService.getTask(importResult.task_ids[0]);

      expect(imported).toBeDefined();
      expect(imported!.title).toBe(original.title);
      expect(imported!.description).toBe(original.description);
      expect(imported!.status).toBe(original.status);
      expect(imported!.priority).toBe(original.priority);
      expect(imported!.custom_field_values).toEqual(original.custom_field_values);
      expect(imported!.tag_ids).toEqual(original.tag_ids);
    });

    it('should preserve acceptance criteria through export → import', async () => {
      const original = await taskService.createTask({ board_id: TEST_BOARD_ID, title: 'AC Round-trip' });

      // Add acceptance criteria
      await testPool.query(
        `INSERT INTO acceptance_criteria (task_id, criterion, validation_method, status, tenant_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [original.id, 'Tests pass', 'automated', 'passed', TEST_TENANT_ID],
      );
      await testPool.query(
        `INSERT INTO acceptance_criteria (task_id, criterion, validation_method, status, tenant_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [original.id, 'Reviewed', 'review', 'pending', TEST_TENANT_ID],
      );

      const exportData = await exportService.exportTasks([original.id]);

      // Verify AC were exported
      expect(exportData.tasks[0].acceptance_criteria).toHaveLength(2);

      // Import to new task
      const importResult = await exportService.importTasks(exportData, undefined, TEST_TENANT_ID);

      expect(importResult.criteria_imported).toBe(2);

      // Verify AC were restored
      const acRows = await testPool.query(
        'SELECT criterion, status, validation_method FROM acceptance_criteria WHERE task_id = $1 ORDER BY created_at',
        [importResult.task_ids[0]],
      );
      expect(acRows.rows).toHaveLength(2);
      expect(acRows.rows[0].criterion).toBe('Tests pass');
      expect(acRows.rows[0].status).toBe('passed');
      expect(acRows.rows[1].criterion).toBe('Reviewed');
      expect(acRows.rows[1].status).toBe('pending');
    });
  });
});
