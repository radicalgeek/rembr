/**
 * Task Service Tests (REM-70)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { createTestPool } from './test-utils/test-db.js';
import { TaskService } from './task-service';

const TEST_BOARD_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_USER_ID = '660e8400-e29b-41d4-a716-446655440001';
const TEST_TASK_DEP_1 = '660e8400-e29b-41d4-a716-446655440011';
const TEST_TASK_DEP_2 = '660e8400-e29b-41d4-a716-446655440012';
const TEST_TAG_1 = '770e8400-e29b-41d4-a716-446655440001';

// Share a single pool across all tests to avoid connection churn on slow CI runners.
let testPool: Pool;
let service: TaskService;

beforeAll(async () => {
  testPool = createTestPool('it_task_service');

  // Create base tables
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS boards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      board_id UUID NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'inbox',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      assigned_agent_id VARCHAR(255),
      created_by_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      in_progress_at TIMESTAMPTZ,
      due_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      custom_field_values JSONB DEFAULT '{}'::jsonb,
      depends_on_task_ids UUID[] DEFAULT ARRAY[]::UUID[],
      blocked_by_task_ids UUID[] DEFAULT ARRAY[]::UUID[],
      tag_ids UUID[] DEFAULT ARRAY[]::UUID[]
    );
  `);

  // Create test board
  await testPool.query(`
    INSERT INTO boards (id, name)
    VALUES ($1, 'Test Board')
    ON CONFLICT (id) DO NOTHING
  `, [TEST_BOARD_ID]);
});

afterAll(async () => {
  await testPool.query('DELETE FROM tasks WHERE board_id = $1', [TEST_BOARD_ID]);
  await testPool.query('DELETE FROM boards WHERE id = $1', [TEST_BOARD_ID]);
  await testPool.end();
});

beforeEach(() => {
  service = new TaskService(testPool);
});

afterEach(async () => {
  // Cleanup task data between tests but keep the pool and tables
  await testPool.query('DELETE FROM tasks WHERE board_id = $1', [TEST_BOARD_ID]);
});

describe('Task Service (REM-70)', () => {
  describe('createTask', () => {
    it('should create a task with required fields', async () => {
      const task = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Test Task',
      });

      expect(task.id).toBeTruthy();
      expect(task.board_id).toBe(TEST_BOARD_ID);
      expect(task.title).toBe('Test Task');
      expect(task.status).toBe('inbox');
      expect(task.priority).toBe('medium');
      expect(task.created_at).toBeInstanceOf(Date);
      expect(task.updated_at).toBeInstanceOf(Date);
    });

    it('should create a task with all fields', async () => {
      const dueDate = new Date('2026-12-31');
      const task = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Full Task',
        description: 'Detailed description',
        status: 'in_progress',
        priority: 'high',
        assigned_agent_id: 'agent-123',
        created_by_user_id: TEST_USER_ID,
        due_at: dueDate,
        custom_field_values: { foo: 'bar' },
        depends_on_task_ids: [TEST_TASK_DEP_1],
        blocked_by_task_ids: [TEST_TASK_DEP_2],
        tag_ids: [TEST_TAG_1],
      });

      expect(task.title).toBe('Full Task');
      expect(task.description).toBe('Detailed description');
      expect(task.status).toBe('in_progress');
      expect(task.priority).toBe('high');
      expect(task.assigned_agent_id).toBe('agent-123');
      expect(task.created_by_user_id).toBe(TEST_USER_ID);
      expect(task.due_at).toEqual(dueDate);
      expect(task.custom_field_values).toEqual({ foo: 'bar' });
      expect(task.depends_on_task_ids).toEqual([TEST_TASK_DEP_1]);
      expect(task.blocked_by_task_ids).toEqual([TEST_TASK_DEP_2]);
      expect(task.tag_ids).toEqual([TEST_TAG_1]);
    });

    it('should throw error if title is missing', async () => {
      await expect(
        service.createTask({
          board_id: TEST_BOARD_ID,
          title: '',
        })
      ).rejects.toThrow('Task title is required');
    });

    it('should throw error if title is too long', async () => {
      const longTitle = 'x'.repeat(501);
      await expect(
        service.createTask({
          board_id: TEST_BOARD_ID,
          title: longTitle,
        })
      ).rejects.toThrow('Task title must be 500 characters or less');
    });

    it('should throw error if board_id is missing', async () => {
      await expect(
        service.createTask({
          board_id: '',
          title: 'Task',
        })
      ).rejects.toThrow('Board ID is required');
    });

    it('should trim whitespace from title and description', async () => {
      const task = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: '  Trimmed Title  ',
        description: '  Trimmed Description  ',
      });

      expect(task.title).toBe('Trimmed Title');
      expect(task.description).toBe('Trimmed Description');
    });
  });

  describe('getTask', () => {
    it('should get a task by ID', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Get Test',
      });

      const task = await service.getTask(created.id);

      expect(task).toBeTruthy();
      expect(task?.id).toBe(created.id);
      expect(task?.title).toBe('Get Test');
    });

    it('should return null if task not found', async () => {
      const task = await service.getTask('00000000-0000-0000-0000-000000000000');

      expect(task).toBeNull();
    });

    it('should not return deleted tasks by default', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Deleted Task',
      });

      await service.deleteTask(created.id);

      const task = await service.getTask(created.id);

      expect(task).toBeNull();
    });

    it('should return deleted tasks if include_deleted is true', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Deleted Task',
      });

      await service.deleteTask(created.id);

      const task = await service.getTask(created.id, true);

      expect(task).toBeTruthy();
      expect(task?.deleted_at).toBeInstanceOf(Date);
    });
  });

  describe('listTasks', () => {
    beforeEach(async () => {
      // Create test tasks
      await service.createTask({ board_id: TEST_BOARD_ID, title: 'Task 1', status: 'inbox', priority: 'high' });
      await service.createTask({ board_id: TEST_BOARD_ID, title: 'Task 2', status: 'in_progress', priority: 'medium' });
      await service.createTask({ board_id: TEST_BOARD_ID, title: 'Task 3', status: 'inbox', priority: 'low' });
      await service.createTask({ board_id: TEST_BOARD_ID, title: 'Task 4', status: 'done', priority: 'high', assigned_agent_id: 'agent-123' });
    });

    it('should list all tasks', async () => {
      const result = await service.listTasks({ board_id: TEST_BOARD_ID });

      expect(result.tasks.length).toBe(4);
      expect(result.total).toBe(4);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('should filter by board_id', async () => {
      const result = await service.listTasks({ board_id: TEST_BOARD_ID });

      expect(result.tasks.length).toBe(4);
      expect(result.tasks.every(t => t.board_id === TEST_BOARD_ID)).toBe(true);
    });

    it('should filter by status', async () => {
      const result = await service.listTasks({ status: 'inbox', board_id: TEST_BOARD_ID });

      expect(result.tasks.length).toBe(2);
      expect(result.tasks.every(t => t.status === 'inbox')).toBe(true);
    });

    it('should filter by priority', async () => {
      const result = await service.listTasks({ priority: 'high', board_id: TEST_BOARD_ID });

      expect(result.tasks.length).toBe(2);
      expect(result.tasks.every(t => t.priority === 'high')).toBe(true);
    });

    it('should filter by assigned_agent_id', async () => {
      const result = await service.listTasks({ assigned_agent_id: 'agent-123', board_id: TEST_BOARD_ID });

      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].assigned_agent_id).toBe('agent-123');
    });

    it('should filter unassigned tasks', async () => {
      const result = await service.listTasks({ assigned_agent_id: null, board_id: TEST_BOARD_ID });

      expect(result.tasks.length).toBe(3);
      expect(result.tasks.every(t => t.assigned_agent_id === null)).toBe(true);
    });

    it('should support pagination', async () => {
      const page1 = await service.listTasks({ board_id: TEST_BOARD_ID, limit: 2, offset: 0 });
      const page2 = await service.listTasks({ board_id: TEST_BOARD_ID, limit: 2, offset: 2 });

      expect(page1.tasks.length).toBe(2);
      expect(page2.tasks.length).toBe(2);
      expect(page1.total).toBe(4);
      expect(page2.total).toBe(4);
      expect(page1.tasks[0].id).not.toBe(page2.tasks[0].id);
    });

    it('should not include deleted tasks by default', async () => {
      const created = await service.createTask({ board_id: TEST_BOARD_ID, title: 'To Delete' });
      await service.deleteTask(created.id);

      const result = await service.listTasks({ board_id: TEST_BOARD_ID });

      expect(result.tasks.find(t => t.id === created.id)).toBeUndefined();
      expect(result.total).toBe(4); // Doesn't include deleted
    });

    it('should include deleted tasks if include_deleted is true', async () => {
      const created = await service.createTask({ board_id: TEST_BOARD_ID, title: 'To Delete' });
      await service.deleteTask(created.id);

      const result = await service.listTasks({ board_id: TEST_BOARD_ID, include_deleted: true });

      expect(result.tasks.find(t => t.id === created.id)).toBeTruthy();
      expect(result.total).toBe(5); // Includes deleted
    });
  });

  describe('updateTask', () => {
    it('should update task fields', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Original Title',
        description: 'Original Description',
        status: 'inbox',
        priority: 'low',
      });

      const updated = await service.updateTask(created.id, {
        title: 'Updated Title',
        description: 'Updated Description',
        status: 'in_progress',
        priority: 'high',
      });

      expect(updated.title).toBe('Updated Title');
      expect(updated.description).toBe('Updated Description');
      expect(updated.status).toBe('in_progress');
      expect(updated.priority).toBe('high');
      expect(updated.updated_at.getTime()).toBeGreaterThan(created.updated_at.getTime());
    });

    it('should set in_progress_at when transitioning to in_progress', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
        status: 'inbox',
      });

      expect(created.in_progress_at).toBeNull();

      const updated = await service.updateTask(created.id, {
        status: 'in_progress',
      });

      expect(updated.in_progress_at).toBeInstanceOf(Date);
    });

    it('should not update in_progress_at if already in_progress', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
        status: 'in_progress',
      });

      const firstInProgressAt = created.in_progress_at;

      const updated = await service.updateTask(created.id, {
        title: 'Updated Title',
      });

      expect(updated.in_progress_at).toEqual(firstInProgressAt);
    });

    it('should update custom_field_values', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
        custom_field_values: { foo: 'bar' },
      });

      const updated = await service.updateTask(created.id, {
        custom_field_values: { foo: 'baz', new: 'value' },
      });

      expect(updated.custom_field_values).toEqual({ foo: 'baz', new: 'value' });
    });

    it('should throw error if task not found', async () => {
      await expect(
        service.updateTask('00000000-0000-0000-0000-000000000000', { title: 'Updated' })
      ).rejects.toThrow('Task not found or has been deleted');
    });

    it('should throw error if updating deleted task', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
      });

      await service.deleteTask(created.id);

      await expect(
        service.updateTask(created.id, { title: 'Updated' })
      ).rejects.toThrow('Task not found or has been deleted');
    });

    it('should throw error if title is empty', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
      });

      await expect(
        service.updateTask(created.id, { title: '' })
      ).rejects.toThrow('Task title cannot be empty');
    });

    it('should throw error if title is too long', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
      });

      const longTitle = 'x'.repeat(501);
      await expect(
        service.updateTask(created.id, { title: longTitle })
      ).rejects.toThrow('Task title must be 500 characters or less');
    });
  });

  describe('deleteTask', () => {
    it('should soft delete a task', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'To Delete',
      });

      await service.deleteTask(created.id);

      const task = await service.getTask(created.id, true);

      expect(task?.deleted_at).toBeInstanceOf(Date);
    });

    it('should throw error if task not found', async () => {
      await expect(
        service.deleteTask('00000000-0000-0000-0000-000000000000')
      ).rejects.toThrow('Task not found or already deleted');
    });

    it('should throw error if task already deleted', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
      });

      await service.deleteTask(created.id);

      await expect(
        service.deleteTask(created.id)
      ).rejects.toThrow('Task not found or already deleted');
    });
  });

  describe('assignTask', () => {
    it('should assign a task to an agent', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
      });

      const assigned = await service.assignTask(created.id, 'agent-456');

      expect(assigned.assigned_agent_id).toBe('agent-456');
    });

    it('should unassign a task', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
        assigned_agent_id: 'agent-123',
      });

      const unassigned = await service.assignTask(created.id, null);

      expect(unassigned.assigned_agent_id).toBeNull();
    });
  });

  describe('restoreTask', () => {
    it('should restore a soft-deleted task', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
      });

      await service.deleteTask(created.id);

      const restored = await service.restoreTask(created.id);

      expect(restored.deleted_at).toBeNull();
    });

    it('should throw error if task not deleted', async () => {
      const created = await service.createTask({
        board_id: TEST_BOARD_ID,
        title: 'Task',
      });

      await expect(
        service.restoreTask(created.id)
      ).rejects.toThrow('Task not found or not deleted');
    });
  });
});
