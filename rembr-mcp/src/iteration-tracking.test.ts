/**
 * Iteration Tracking & Stuck Detection Tests (RAD-59)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { IterationTrackingService } from './iteration-tracking.js';

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TASK_A = 'task-alpha';
const TASK_B = 'task-beta';

let pool: Pool;
let svc: IterationTrackingService;

beforeEach(async () => {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test',
  });
  svc = new IterationTrackingService(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_iterations (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id        UUID NOT NULL,
      task_id          TEXT NOT NULL,
      attempt_number   INTEGER NOT NULL,
      approach         TEXT NOT NULL,
      outcome          TEXT NOT NULL,
      error            TEXT,
      started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ,
      duration_seconds INTEGER,
      metadata         JSONB DEFAULT '{}'::jsonb,
      CONSTRAINT task_iterations_unique UNIQUE (tenant_id, task_id, attempt_number)
    )
  `);
});

afterEach(async () => {
  await pool.query(
    'DELETE FROM task_iterations WHERE tenant_id = $1',
    [TEST_TENANT_ID],
  );
  await pool.end();
});

// ---------------------------------------------------------------------------
// recordIteration
// ---------------------------------------------------------------------------

describe('IterationTrackingService', () => {
  describe('recordIteration', () => {
    it('assigns attempt_number starting at 1', async () => {
      const r = await svc.recordIteration(TEST_TENANT_ID, {
        task_id: TASK_A, approach: 'Try approach A', outcome: 'failed',
      });
      expect(r.attempt_number).toBe(1);
      expect(r.task_id).toBe(TASK_A);
      expect(r.approach).toBe('Try approach A');
      expect(r.outcome).toBe('failed');
    });

    it('increments attempt_number on each call', async () => {
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: 'A1', outcome: 'failed' });
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: 'A2', outcome: 'failed' });
      const r3 = await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: 'A3', outcome: 'failed' });
      expect(r3.attempt_number).toBe(3);
    });

    it('stores error and duration_seconds', async () => {
      const r = await svc.recordIteration(TEST_TENANT_ID, {
        task_id: TASK_A, approach: 'Try X', outcome: 'failed',
        error: 'TypeError: cannot read property', duration_seconds: 42,
      });
      expect(r.error).toBe('TypeError: cannot read property');
      expect(r.duration_seconds).toBe(42);
    });

    it('stores metadata JSONB', async () => {
      const r = await svc.recordIteration(TEST_TENANT_ID, {
        task_id: TASK_A, approach: 'Y', outcome: 'partial',
        metadata: { pr: 123, tags: ['rlm'] },
      });
      expect(r.metadata).toEqual({ pr: 123, tags: ['rlm'] });
    });

    it('attempt_number is independent per task', async () => {
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: 'A', outcome: 'failed' });
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: 'B', outcome: 'failed' });
      const rb = await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_B, approach: 'X', outcome: 'success' });
      expect(rb.attempt_number).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getIterationHistory
  // ---------------------------------------------------------------------------

  describe('getIterationHistory', () => {
    it('returns iterations in chronological order', async () => {
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: '1', outcome: 'failed' });
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: '2', outcome: 'partial' });
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: '3', outcome: 'success' });

      const history = await svc.getIterationHistory(TEST_TENANT_ID, TASK_A);
      expect(history).toHaveLength(3);
      expect(history[0].attempt_number).toBe(1);
      expect(history[2].attempt_number).toBe(3);
      expect(history[2].outcome).toBe('success');
    });

    it('returns empty array for unknown task', async () => {
      const history = await svc.getIterationHistory(TEST_TENANT_ID, 'nonexistent');
      expect(history).toEqual([]);
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: `A${i}`, outcome: 'failed' });
      }
      const history = await svc.getIterationHistory(TEST_TENANT_ID, TASK_A, 3);
      expect(history).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // calculateStuckScore
  // ---------------------------------------------------------------------------

  describe('calculateStuckScore', () => {
    it('returns score=0 for task with no iterations', async () => {
      const result = await svc.calculateStuckScore(TEST_TENANT_ID, 'empty-task');
      expect(result.score).toBe(0);
      expect(result.is_stuck).toBe(false);
      expect(result.iteration_count).toBe(0);
    });

    it('detects plateau (same outcome 3 times)', async () => {
      for (let i = 0; i < 3; i++) {
        await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: `try-${i}`, outcome: 'failed' });
      }
      const result = await svc.calculateStuckScore(TEST_TENANT_ID, TASK_A);
      expect(result.reasons.some(r => r.includes('Same outcome'))).toBe(true);
      expect(result.score).toBeGreaterThan(0);
    });

    it('detects repeating errors', async () => {
      for (let i = 0; i < 3; i++) {
        await svc.recordIteration(TEST_TENANT_ID, {
          task_id: TASK_A, approach: `try-${i}`, outcome: 'failed',
          error: 'Connection refused',
        });
      }
      const result = await svc.calculateStuckScore(TEST_TENANT_ID, TASK_A);
      expect(result.reasons.some(r => r.toLowerCase().includes('error repeated'))).toBe(true);
    });

    it('marks task as stuck when score >= threshold', async () => {
      // 5 iterations all failed with same error = plateau + error_repeat + high count
      for (let i = 0; i < 5; i++) {
        await svc.recordIteration(TEST_TENANT_ID, {
          task_id: TASK_A, approach: `try-${i}`, outcome: 'failed',
          error: 'Timeout',
        });
      }
      const result = await svc.calculateStuckScore(TEST_TENANT_ID, TASK_A);
      expect(result.is_stuck).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(70);
    });

    it('task that succeeds is not stuck', async () => {
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: 'A', outcome: 'failed' });
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: 'B', outcome: 'success' });
      const result = await svc.calculateStuckScore(TEST_TENANT_ID, TASK_A, { score_threshold: 70 });
      // Recent outcome is success — no plateau on success
      expect(result.reasons.some(r => r.includes('Same outcome "success"'))).toBe(false);
    });

    it('respects custom criteria', async () => {
      for (let i = 0; i < 2; i++) {
        await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: `A${i}`, outcome: 'failed' });
      }
      // With plateau_threshold=2, 2 same outcomes should trigger
      const result = await svc.calculateStuckScore(TEST_TENANT_ID, TASK_A, { plateau_threshold: 2 });
      expect(result.reasons.some(r => r.includes('Same outcome'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // detectStuckTasks
  // ---------------------------------------------------------------------------

  describe('detectStuckTasks', () => {
    it('returns empty array when no stuck tasks', async () => {
      const result = await svc.detectStuckTasks(TEST_TENANT_ID);
      expect(result).toEqual([]);
    });

    it('returns stuck tasks ordered by score descending', async () => {
      // TASK_A: 5 iterations all failed with repeating error (high score)
      for (let i = 0; i < 5; i++) {
        await svc.recordIteration(TEST_TENANT_ID, {
          task_id: TASK_A, approach: `A${i}`, outcome: 'failed', error: 'Timeout',
        });
      }
      // TASK_B: 4 iterations mixed (lower score)
      for (let i = 0; i < 4; i++) {
        await svc.recordIteration(TEST_TENANT_ID, {
          task_id: TASK_B, approach: `B${i}`,
          outcome: i % 2 === 0 ? 'failed' : 'partial',
        });
      }

      const result = await svc.detectStuckTasks(TEST_TENANT_ID, { min_iterations: 3 });
      // At least TASK_A should appear
      const stuckIds = result.map(r => r.task_id);
      expect(stuckIds).toContain(TASK_A);
      // Ordering: higher score first
      if (result.length > 1) {
        expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
      }
    });

    it('skips tasks below min_iterations', async () => {
      // Only 2 iterations — below default min of 3
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: 'A1', outcome: 'failed', error: 'e' });
      await svc.recordIteration(TEST_TENANT_ID, { task_id: TASK_A, approach: 'A2', outcome: 'failed', error: 'e' });

      const result = await svc.detectStuckTasks(TEST_TENANT_ID, { min_iterations: 3 });
      expect(result.map(r => r.task_id)).not.toContain(TASK_A);
    });
  });
});
