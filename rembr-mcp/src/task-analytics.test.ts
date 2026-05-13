/**
 * Unit tests for Task Analytics Service (REM-56)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { TaskAnalyticsService } from './task-analytics.js';

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440001';
const TEST_AGENT_ID_1 = '550e8400-e29b-41d4-a716-446655440002';
const TEST_AGENT_ID_2 = '550e8400-e29b-41d4-a716-446655440003';

describe('TaskAnalyticsService', () => {
  let pool: Pool;
  let service: TaskAnalyticsService;

  beforeEach(async () => {
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test'
    });

    service = new TaskAnalyticsService(pool);

    // Set tenant context
    await pool.query(`SET app.current_tenant_id = '${TEST_TENANT_ID}'`);

    // Clean up test data
    await pool.query('DELETE FROM task_state_transitions WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await pool.query('DELETE FROM task_assignments WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await pool.query('DELETE FROM task_dependencies WHERE tenant_id = $1', [TEST_TENANT_ID]);
    await pool.query('DELETE FROM tasks WHERE tenant_id = $1', [TEST_TENANT_ID]);
  });

  afterEach(async () => {
    await pool.end();
  });

  describe('calculateVelocity', () => {
    it('should calculate velocity with completed tasks', async () => {
      // Create completed tasks over the last 2 weeks
      const now = new Date();
      const tasks = [];
      
      for (let i = 0; i < 14; i++) {
        const createdAt = new Date(now.getTime() - (14 - i) * 24 * 60 * 60 * 1000);
        const completedAt = new Date(createdAt.getTime() + 2 * 24 * 60 * 60 * 1000); // Completed 2 days after creation
        
        const result = await pool.query(
          `INSERT INTO tasks (tenant_id, project_id, title, state, created_at, completed_at, created_by)
           VALUES ($1, $2, $3, 'done', $4, $5, $6)
           RETURNING id`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Task ${i + 1}`, createdAt, completedAt, TEST_AGENT_ID_1]
        );
        tasks.push(result.rows[0].id);
      }

      const velocity = await service.calculateVelocity(TEST_TENANT_ID, 'week', TEST_PROJECT_ID, 2);

      expect(velocity.period).toBe('week');
      expect(velocity.data_points).toHaveLength(2);
      expect(velocity.avg_velocity).toBeGreaterThan(0);
      expect(['increasing', 'decreasing', 'stable']).toContain(velocity.trend);
    });

    it('should handle no completed tasks', async () => {
      const velocity = await service.calculateVelocity(TEST_TENANT_ID, 'week', TEST_PROJECT_ID, 2);

      expect(velocity.period).toBe('week');
      expect(velocity.data_points).toHaveLength(2);
      expect(velocity.avg_velocity).toBe(0);
      expect(velocity.trend).toBe('stable');
    });

    it('should calculate daily velocity', async () => {
      const now = new Date();
      
      // Create tasks completed over last 3 days
      for (let i = 0; i < 3; i++) {
        const completedAt = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        await pool.query(
          `INSERT INTO tasks (tenant_id, project_id, title, state, completed_at, created_by)
           VALUES ($1, $2, $3, 'done', $4, $5)`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Task ${i + 1}`, completedAt, TEST_AGENT_ID_1]
        );
      }

      const velocity = await service.calculateVelocity(TEST_TENANT_ID, 'day', TEST_PROJECT_ID, 3);

      expect(velocity.period).toBe('day');
      expect(velocity.data_points.length).toBeGreaterThan(0);
    });

    it('should detect increasing trend', async () => {
      const now = new Date();
      
      // Week 1: 1 task
      await pool.query(
        `INSERT INTO tasks (tenant_id, project_id, title, state, completed_at, created_by)
         VALUES ($1, $2, 'Task 1', 'done', $3, $4)`,
        [TEST_TENANT_ID, TEST_PROJECT_ID, new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), TEST_AGENT_ID_1]
      );

      // Week 2: 5 tasks
      for (let i = 0; i < 5; i++) {
        await pool.query(
          `INSERT INTO tasks (tenant_id, project_id, title, state, completed_at, created_by)
           VALUES ($1, $2, $3, 'done', $4, $5)`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Task ${i + 2}`, new Date(now.getTime() - i * 24 * 60 * 60 * 1000), TEST_AGENT_ID_1]
        );
      }

      const velocity = await service.calculateVelocity(TEST_TENANT_ID, 'week', TEST_PROJECT_ID, 2);

      expect(velocity.trend).toBe('increasing');
      expect(velocity.trend_percentage).toBeGreaterThan(0);
    });
  });

  describe('calculateBurndown', () => {
    it('should calculate burndown chart', async () => {
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
      const targetDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

      // Create 10 tasks at start
      for (let i = 0; i < 10; i++) {
        await pool.query(
          `INSERT INTO tasks (tenant_id, project_id, title, state, created_at, created_by)
           VALUES ($1, $2, $3, 'in_progress', $4, $5)`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Task ${i + 1}`, startDate, TEST_AGENT_ID_1]
        );
      }

      // Complete 5 tasks over the past week
      for (let i = 0; i < 5; i++) {
        const completedAt = new Date(startDate.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
        await pool.query(
          `UPDATE tasks 
           SET state = 'done', completed_at = $1 
           WHERE tenant_id = $2 AND project_id = $3 AND title = $4`,
          [completedAt, TEST_TENANT_ID, TEST_PROJECT_ID, `Task ${i + 1}`]
        );
      }

      const burndown = await service.calculateBurndown(TEST_TENANT_ID, TEST_PROJECT_ID, startDate, targetDate);

      expect(burndown.project_id).toBe(TEST_PROJECT_ID);
      expect(burndown.start_date).toEqual(startDate);
      expect(burndown.target_date).toEqual(targetDate);
      expect(burndown.data_points.length).toBeGreaterThan(0);
      expect(burndown.completion_percentage).toBeGreaterThan(0);
      expect(burndown.completion_percentage).toBeLessThanOrEqual(100);
    });

    it('should handle 100% completion', async () => {
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Create and complete all tasks
      for (let i = 0; i < 5; i++) {
        await pool.query(
          `INSERT INTO tasks (tenant_id, project_id, title, state, created_at, completed_at, created_by)
           VALUES ($1, $2, $3, 'done', $4, $5, $6)`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Task ${i + 1}`, startDate, new Date(), TEST_AGENT_ID_1]
        );
      }

      const burndown = await service.calculateBurndown(TEST_TENANT_ID, TEST_PROJECT_ID, startDate);

      expect(burndown.completion_percentage).toBe(100);
    });

    it('should project completion date', async () => {
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Create 10 tasks
      for (let i = 0; i < 10; i++) {
        await pool.query(
          `INSERT INTO tasks (tenant_id, project_id, title, state, created_at, created_by)
           VALUES ($1, $2, $3, 'in_progress', $4, $5)`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Task ${i + 1}`, startDate, TEST_AGENT_ID_1]
        );
      }

      // Complete tasks at steady rate (1 per day for last 5 days)
      for (let i = 0; i < 5; i++) {
        const completedAt = new Date(Date.now() - (4 - i) * 24 * 60 * 60 * 1000);
        await pool.query(
          `UPDATE tasks 
           SET state = 'done', completed_at = $1 
           WHERE tenant_id = $2 AND project_id = $3 AND title = $4`,
          [completedAt, TEST_TENANT_ID, TEST_PROJECT_ID, `Task ${i + 1}`]
        );
      }

      const burndown = await service.calculateBurndown(TEST_TENANT_ID, TEST_PROJECT_ID, startDate);

      expect(burndown.projected_completion_date).toBeDefined();
      if (burndown.projected_completion_date) {
        expect(burndown.projected_completion_date.getTime()).toBeGreaterThan(Date.now());
      }
    });
  });

  describe('identifyBottlenecks', () => {
    it('should identify blocked tasks', async () => {
      // Create blocked task
      const blockedAt = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago
      await pool.query(
        `INSERT INTO tasks (tenant_id, project_id, title, state, created_at, updated_at, created_by)
         VALUES ($1, $2, 'Blocked Task', 'blocked', $3, $3, $4)`,
        [TEST_TENANT_ID, TEST_PROJECT_ID, blockedAt, TEST_AGENT_ID_1]
      );

      const analysis = await service.identifyBottlenecks(TEST_TENANT_ID, TEST_PROJECT_ID);

      expect(analysis.total_blocked_tasks).toBe(1);
      expect(analysis.bottlenecks.some(b => b.type === 'blocked_task')).toBe(true);
      const blockedBottleneck = analysis.bottlenecks.find(b => b.type === 'blocked_task');
      expect(blockedBottleneck).toBeDefined();
      expect(blockedBottleneck?.severity).toBe('medium'); // > 24 hours
    });

    it('should identify slow transitions', async () => {
      // Create task stuck in in_progress for 3 days
      const taskResult = await pool.query(
        `INSERT INTO tasks (tenant_id, project_id, title, state, created_at, created_by)
         VALUES ($1, $2, 'Slow Task', 'in_progress', NOW(), $3)
         RETURNING id`,
        [TEST_TENANT_ID, TEST_PROJECT_ID, TEST_AGENT_ID_1]
      );
      const taskId = taskResult.rows[0].id;

      // Record state transition 3 days ago
      const transitionedAt = new Date(Date.now() - 72 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO task_state_transitions (tenant_id, task_id, from_state, to_state, transitioned_at, transitioned_by)
         VALUES ($1, $2, 'ready', 'in_progress', $3, $4)`,
        [TEST_TENANT_ID, taskId, transitionedAt, TEST_AGENT_ID_1]
      );

      const analysis = await service.identifyBottlenecks(TEST_TENANT_ID, TEST_PROJECT_ID);

      expect(analysis.bottlenecks.some(b => b.type === 'slow_transition')).toBe(true);
      const slowBottleneck = analysis.bottlenecks.find(b => b.type === 'slow_transition');
      expect(slowBottleneck?.duration_hours).toBeGreaterThan(48);
    });

    it('should identify overloaded agents', async () => {
      // Create 7 active tasks for one agent (exceeds default limit of 5)
      for (let i = 0; i < 7; i++) {
        await pool.query(
          `INSERT INTO tasks (tenant_id, project_id, title, state, assigned_to, created_by)
           VALUES ($1, $2, $3, 'in_progress', $4, $5)`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Task ${i + 1}`, TEST_AGENT_ID_1, TEST_AGENT_ID_1]
        );
      }

      const analysis = await service.identifyBottlenecks(TEST_TENANT_ID, TEST_PROJECT_ID);

      expect(analysis.total_overloaded_agents).toBe(1);
      expect(analysis.bottlenecks.some(b => b.type === 'overloaded_agent')).toBe(true);
      const overloadedBottleneck = analysis.bottlenecks.find(b => b.type === 'overloaded_agent');
      expect(overloadedBottleneck?.task_count).toBe(7);
      expect(overloadedBottleneck?.agent_id).toBe(TEST_AGENT_ID_1);
    });

    it('should identify long cycle time tasks', async () => {
      // Create task open for 10 days (240 hours)
      const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO tasks (tenant_id, project_id, title, state, created_at, created_by)
         VALUES ($1, $2, 'Old Task', 'in_progress', $3, $4)`,
        [TEST_TENANT_ID, TEST_PROJECT_ID, createdAt, TEST_AGENT_ID_1]
      );

      const analysis = await service.identifyBottlenecks(TEST_TENANT_ID, TEST_PROJECT_ID, {
        cycleTimeHours: 168 // 1 week threshold
      });

      expect(analysis.bottlenecks.some(b => b.type === 'long_cycle_time')).toBe(true);
      const longCycleBottleneck = analysis.bottlenecks.find(b => b.type === 'long_cycle_time');
      expect(longCycleBottleneck?.duration_hours).toBeGreaterThan(168);
    });

    it('should provide recommendations', async () => {
      // Create multiple blocked tasks
      for (let i = 0; i < 6; i++) {
        await pool.query(
          `INSERT INTO tasks (tenant_id, project_id, title, state, created_by)
           VALUES ($1, $2, $3, 'blocked', $4)`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Blocked ${i + 1}`, TEST_AGENT_ID_1]
        );
      }

      // Create overloaded agent
      for (let i = 0; i < 8; i++) {
        await pool.query(
          `INSERT INTO tasks (tenant_id, project_id, title, state, assigned_to, created_by)
           VALUES ($1, $2, $3, 'in_progress', $4, $5)`,
          [TEST_TENANT_ID, TEST_PROJECT_ID, `Active ${i + 1}`, TEST_AGENT_ID_2, TEST_AGENT_ID_1]
        );
      }

      const analysis = await service.identifyBottlenecks(TEST_TENANT_ID, TEST_PROJECT_ID);

      expect(analysis.recommendations.length).toBeGreaterThan(0);
      expect(analysis.recommendations.some(r => r.includes('blocked tasks'))).toBe(true);
      expect(analysis.recommendations.some(r => r.includes('overloaded'))).toBe(true);
    });

    it('should handle custom thresholds', async () => {
      // Create task blocked for 12 hours
      const blockedAt = new Date(Date.now() - 12 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO tasks (tenant_id, project_id, title, state, updated_at, created_by)
         VALUES ($1, $2, 'Recently Blocked', 'blocked', $3, $4)`,
        [TEST_TENANT_ID, TEST_PROJECT_ID, blockedAt, TEST_AGENT_ID_1]
      );

      // Default threshold (24h) should not flag this
      const analysis1 = await service.identifyBottlenecks(TEST_TENANT_ID, TEST_PROJECT_ID);
      expect(analysis1.total_blocked_tasks).toBe(1); // Still counts as blocked, but severity might be low

      // Custom threshold (6h) should flag this
      const analysis2 = await service.identifyBottlenecks(TEST_TENANT_ID, TEST_PROJECT_ID, {
        blockedHours: 6
      });
      expect(analysis2.total_blocked_tasks).toBe(1);
    });

    it('should filter by project', async () => {
      const otherProjectId = '550e8400-e29b-41d4-a716-446655440099';

      // Create blocked task in target project
      await pool.query(
        `INSERT INTO tasks (tenant_id, project_id, title, state, created_by)
         VALUES ($1, $2, 'Blocked in Project', 'blocked', $3)`,
        [TEST_TENANT_ID, TEST_PROJECT_ID, TEST_AGENT_ID_1]
      );

      // Create blocked task in other project
      await pool.query(
        `INSERT INTO tasks (tenant_id, project_id, title, state, created_by)
         VALUES ($1, $2, 'Blocked in Other', 'blocked', $3)`,
        [TEST_TENANT_ID, otherProjectId, TEST_AGENT_ID_1]
      );

      const analysis = await service.identifyBottlenecks(TEST_TENANT_ID, TEST_PROJECT_ID);

      expect(analysis.total_blocked_tasks).toBe(1);
      expect(analysis.project_id).toBe(TEST_PROJECT_ID);
    });
  });

  describe('edge cases', () => {
    it('should handle empty database', async () => {
      const velocity = await service.calculateVelocity(TEST_TENANT_ID, 'week', TEST_PROJECT_ID);
      const burndown = await service.calculateBurndown(TEST_TENANT_ID, TEST_PROJECT_ID);
      const bottlenecks = await service.identifyBottlenecks(TEST_TENANT_ID, TEST_PROJECT_ID);

      expect(velocity.avg_velocity).toBe(0);
      expect(burndown.completion_percentage).toBe(0);
      expect(bottlenecks.bottlenecks).toHaveLength(0);
    });

    it('should handle null project_id (all projects)', async () => {
      // Create tasks across different projects
      await pool.query(
        `INSERT INTO tasks (tenant_id, project_id, title, state, completed_at, created_by)
         VALUES ($1, $2, 'Task 1', 'done', NOW(), $3)`,
        [TEST_TENANT_ID, TEST_PROJECT_ID, TEST_AGENT_ID_1]
      );
      await pool.query(
        `INSERT INTO tasks (tenant_id, project_id, title, state, completed_at, created_by)
         VALUES ($1, $2, 'Task 2', 'done', NOW(), $3)`,
        [TEST_TENANT_ID, '550e8400-e29b-41d4-a716-446655440099', TEST_AGENT_ID_1]
      );

      const velocity = await service.calculateVelocity(TEST_TENANT_ID, 'week');

      expect(velocity.data_points.length).toBeGreaterThan(0);
    });
  });
});
