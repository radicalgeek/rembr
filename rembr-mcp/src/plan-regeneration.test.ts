/**
 * Plan Regeneration Service Tests (REM-76)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import {
  triggerRegeneration,
  getRegenerationHistory,
  resolveRegeneration,
  analyzeStuckContext,
  type RegenerationReason,
} from './plan-regeneration';

const TEST_TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_TASK_ID = 'task-123';

let testPool: Pool;

beforeEach(async () => {
  testPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test',
  });

  // Create base tables if they don't exist (test setup)
  await testPool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      plan VARCHAR(50) NOT NULL DEFAULT 'dev',
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_iterations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      task_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      approach TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      duration_seconds INTEGER,
      metadata JSONB DEFAULT '{}'::jsonb,
      CONSTRAINT task_iterations_unique UNIQUE (tenant_id, task_id, attempt_number)
    );

    CREATE TABLE IF NOT EXISTS plan_regenerations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL,
      task_id TEXT NOT NULL,
      reason_type TEXT NOT NULL,
      reason_description TEXT NOT NULL,
      context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      generated_prompt JSONB NOT NULL DEFAULT '{}'::jsonb,
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      new_plan TEXT,
      metadata JSONB DEFAULT '{}'::jsonb
    );
  `);

  // Set tenant context

  // Create test tenant
  await testPool.query(`
    INSERT INTO tenants (id, name, email)
    VALUES ($1, 'Test Tenant', 'test@example.com')
    ON CONFLICT (id) DO NOTHING
  `, [TEST_TENANT_ID]);

  // Create test task iterations
  await testPool.query(`
    INSERT INTO task_iterations (tenant_id, task_id, attempt_number, approach, outcome, error, metadata)
    VALUES 
      ($1, $2, 1, 'Try approach A', 'Failed', 'Dependency not found', '{"constraints": ["Must use TypeScript"], "acceptance_criteria": ["All tests pass"]}'),
      ($1, $2, 2, 'Try approach B', 'Failed', 'Type error in module', '{"constraints": ["Must use TypeScript"], "acceptance_criteria": ["All tests pass"]}'),
      ($1, $2, 3, 'Try approach A', 'Failed', 'Dependency not found', '{"constraints": ["Must use TypeScript"], "acceptance_criteria": ["All tests pass"]}')
    ON CONFLICT (tenant_id, task_id, attempt_number) DO NOTHING
  `, [TEST_TENANT_ID, TEST_TASK_ID]);
});

afterEach(async () => {
  // Cleanup test data
  await testPool.query('DELETE FROM plan_regenerations WHERE tenant_id = $1', [TEST_TENANT_ID]);
  await testPool.query('DELETE FROM task_iterations WHERE tenant_id = $1', [TEST_TENANT_ID]);
  await testPool.query('DELETE FROM tenants WHERE id = $1', [TEST_TENANT_ID]);
  await testPool.end();
});

describe('Plan Regeneration Service (REM-76)', () => {
  describe('triggerRegeneration', () => {
    it('should create regeneration record with context snapshot', async () => {
      const reason: RegenerationReason = {
        type: 'stuck_detection',
        description: 'Task stuck after 3 failed iterations',
        iteration_count: 3,
      };

      const regeneration = await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, reason);

      expect(regeneration.id).toBeDefined();
      expect(regeneration.tenant_id).toBe(TEST_TENANT_ID);
      expect(regeneration.task_id).toBe(TEST_TASK_ID);
      expect(regeneration.reason_type).toBe('stuck_detection');
      expect(regeneration.reason_description).toBe('Task stuck after 3 failed iterations');
      expect(regeneration.context_snapshot).toBeDefined();
      expect(regeneration.generated_prompt).toBeDefined();
    });

    it('should capture iteration history in context snapshot', async () => {
      const reason: RegenerationReason = {
        type: 'manual',
        description: 'Manual regeneration requested',
      };

      const regeneration = await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, reason);

      const context = regeneration.context_snapshot as any;
      expect(context.iterations).toHaveLength(3);
      expect(context.iterations[0].attempt_number).toBe(1);
      expect(context.iterations[0].approach).toBe('Try approach A');
    });

    it('should detect repeated error patterns', async () => {
      const reason: RegenerationReason = {
        type: 'failure_threshold',
        description: 'Too many failures',
        failure_count: 3,
      };

      const regeneration = await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, reason);

      const context = regeneration.context_snapshot as any;
      const failurePatterns = context.failure_patterns;
      
      expect(failurePatterns).toBeDefined();
      const repeatedErrorPattern = failurePatterns.find((p: string) => 
        p.includes('Repeated error') && p.includes('Dependency not found')
      );
      expect(repeatedErrorPattern).toBeDefined();
    });

    it('should generate structured prompt for agent', async () => {
      const reason: RegenerationReason = {
        type: 'stuck_detection',
        description: 'Stuck after multiple attempts',
        iteration_count: 3,
      };

      const regeneration = await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, reason);

      const prompt = regeneration.generated_prompt as any;
      expect(prompt.task_id).toBe(TEST_TASK_ID);
      expect(prompt.what_failed).toBeDefined();
      expect(prompt.why_stuck).toContain('Stuck after multiple attempts');
      expect(prompt.prompt_for_agent).toContain('Plan Regeneration Required');
      expect(prompt.prompt_for_agent).toContain('What\'s Been Tried (and Failed)');
    });

    it('should include acceptance criteria in prompt', async () => {
      const reason: RegenerationReason = {
        type: 'manual',
        description: 'Manual trigger',
      };

      const regeneration = await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, reason);

      const prompt = regeneration.generated_prompt as any;
      expect(prompt.available_information.acceptance_criteria).toBeDefined();
      expect(prompt.available_information.acceptance_criteria).toContain('All tests pass');
    });

    it('should include constraints in prompt', async () => {
      const reason: RegenerationReason = {
        type: 'manual',
        description: 'Manual trigger',
      };

      const regeneration = await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, reason);

      const context = regeneration.context_snapshot as any;
      expect(context.constraints).toBeDefined();
      expect(context.constraints).toContain('Must use TypeScript');
    });
  });

  describe('getRegenerationHistory', () => {
    it('should return regeneration history ordered by triggered_at DESC', async () => {
      // Create multiple regenerations
      const reason1: RegenerationReason = { type: 'manual', description: 'First' };
      const reason2: RegenerationReason = { type: 'manual', description: 'Second' };

      await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, reason1);
      await new Promise(resolve => setTimeout(resolve, 10)); // Ensure different timestamps
      await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, reason2);

      const history = await getRegenerationHistory(testPool, TEST_TENANT_ID, TEST_TASK_ID);

      expect(history).toHaveLength(2);
      expect(history[0].reason_description).toBe('Second');
      expect(history[1].reason_description).toBe('First');
    });

    it('should limit results based on limit parameter', async () => {
      // Create 3 regenerations
      for (let i = 0; i < 3; i++) {
        await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, {
          type: 'manual',
          description: `Regeneration ${i}`,
        });
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const history = await getRegenerationHistory(testPool, TEST_TENANT_ID, TEST_TASK_ID, 2);

      expect(history).toHaveLength(2);
    });

    it('should return empty array for task with no regenerations', async () => {
      const history = await getRegenerationHistory(testPool, TEST_TENANT_ID, 'nonexistent-task');

      expect(history).toEqual([]);
    });
  });

  describe('resolveRegeneration', () => {
    it('should mark regeneration as resolved with new plan', async () => {
      const reason: RegenerationReason = { type: 'manual', description: 'Test' };
      const regeneration = await triggerRegeneration(testPool, TEST_TENANT_ID, TEST_TASK_ID, reason);

      const newPlan = 'New approach: Use different library';
      await resolveRegeneration(testPool, TEST_TENANT_ID, regeneration.id, newPlan);

      const history = await getRegenerationHistory(testPool, TEST_TENANT_ID, TEST_TASK_ID);
      const resolved = history.find(r => r.id === regeneration.id);

      expect(resolved).toBeDefined();
      expect(resolved!.resolved_at).toBeDefined();
      expect(resolved!.new_plan).toBe(newPlan);
    });
  });

  describe('analyzeStuckContext', () => {
    it('should gather all context components', async () => {
      const context = await analyzeStuckContext(testPool, TEST_TENANT_ID, TEST_TASK_ID);

      expect(context.task_id).toBe(TEST_TASK_ID);
      expect(context.iterations).toHaveLength(3);
      expect(context.constraints).toBeDefined();
      expect(context.acceptance_criteria).toBeDefined();
      expect(context.previous_plans).toBeDefined();
      expect(context.failure_patterns).toBeDefined();
    });

    it('should extract unique previous plans', async () => {
      const context = await analyzeStuckContext(testPool, TEST_TENANT_ID, TEST_TASK_ID);

      // Should have 2 unique approaches (A and B), even though A was tried twice
      expect(context.previous_plans).toHaveLength(2);
      expect(context.previous_plans).toContain('Try approach A');
      expect(context.previous_plans).toContain('Try approach B');
    });

    it('should detect repeated approach patterns', async () => {
      const context = await analyzeStuckContext(testPool, TEST_TENANT_ID, TEST_TASK_ID);

      const patterns = context.failure_patterns;
      const repeatedKeywordPattern = patterns.find(p => 
        p.includes('Repeated approach keyword') && p.includes('approach')
      );
      expect(repeatedKeywordPattern).toBeDefined();
    });

    it('should detect all recent failures pattern', async () => {
      const context = await analyzeStuckContext(testPool, TEST_TENANT_ID, TEST_TASK_ID);

      const patterns = context.failure_patterns;
      const allFailedPattern = patterns.find(p => 
        p.includes('Last') && p.includes('attempts all failed')
      );
      expect(allFailedPattern).toBeDefined();
    });
  });
});
