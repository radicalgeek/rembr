/**
 * Budget Management Service Tests (REM-100)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  setBudget,
  getBudget,
  listBudgets,
  checkBudget,
  applyBudgetTemplate,
  BUDGET_TEMPLATES,
  type BudgetAllocation,
} from './budget-management.js';

const testPool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/rembr_test',
});

const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('Budget Management Service', () => {
  beforeAll(async () => {
    // Create context_budgets table if not exists (from migration 010)
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS context_budgets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        budget_name TEXT NOT NULL,
        total_tokens INTEGER NOT NULL,
        allocations JSONB NOT NULL DEFAULT '{}'::jsonb,
        thresholds JSONB DEFAULT '{}'::jsonb,
        compression_trigger_percent INTEGER DEFAULT 80,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'::jsonb,
        
        CONSTRAINT context_budgets_unique UNIQUE (tenant_id, budget_name)
      )
    `);
  });

  afterAll(async () => {
    await testPool.end();
  });

  beforeEach(async () => {
    // Clean up test data
    await testPool.query('DELETE FROM context_budgets WHERE tenant_id = $1', [TEST_TENANT_ID]);
  });

  describe('setBudget', () => {
    it('should create a new budget', async () => {
      const allocations: BudgetAllocation = {
        conversation: 30000,
        tools: 20000,
        memory: 40000,
        working_state: 10000,
      };

      const budget = await setBudget(testPool, TEST_TENANT_ID, 'test-budget', 100000, allocations);

      expect(budget.budget_name).toBe('test-budget');
      expect(budget.total_tokens).toBe(100000);
      expect(budget.allocations).toEqual(allocations);
      expect(budget.is_active).toBe(true);
      expect(budget.thresholds).toEqual({ warning_percent: 75, critical_percent: 90 });
      expect(budget.compression_trigger_percent).toBe(80);
    });

    it('should update existing budget on conflict', async () => {
      const allocations1: BudgetAllocation = { conversation: 50000, tools: 50000 };
      const allocations2: BudgetAllocation = { conversation: 60000, tools: 40000 };

      await setBudget(testPool, TEST_TENANT_ID, 'test-budget', 100000, allocations1);
      const updated = await setBudget(testPool, TEST_TENANT_ID, 'test-budget', 100000, allocations2);

      expect(updated.allocations).toEqual(allocations2);
    });

    it('should reject allocations exceeding total tokens', async () => {
      const allocations: BudgetAllocation = {
        conversation: 60000,
        tools: 50000,
      };

      await expect(
        setBudget(testPool, TEST_TENANT_ID, 'bad-budget', 100000, allocations)
      ).rejects.toThrow('Budget allocation exceeds total tokens');
    });

    it('should accept custom thresholds', async () => {
      const allocations: BudgetAllocation = { conversation: 100000 };
      const thresholds = { warning_percent: 80, critical_percent: 95 };

      const budget = await setBudget(testPool, TEST_TENANT_ID, 'custom-threshold', 100000, allocations, {
        thresholds,
      });

      expect(budget.thresholds).toEqual(thresholds);
    });

    it('should accept custom compression trigger', async () => {
      const allocations: BudgetAllocation = { conversation: 100000 };

      const budget = await setBudget(testPool, TEST_TENANT_ID, 'custom-compression', 100000, allocations, {
        compressionTriggerPercent: 70,
      });

      expect(budget.compression_trigger_percent).toBe(70);
    });
  });

  describe('getBudget', () => {
    it('should retrieve existing budget', async () => {
      const allocations: BudgetAllocation = { conversation: 100000 };
      await setBudget(testPool, TEST_TENANT_ID, 'test-budget', 100000, allocations);

      const budget = await getBudget(testPool, TEST_TENANT_ID, 'test-budget');

      expect(budget).not.toBeNull();
      expect(budget?.budget_name).toBe('test-budget');
      expect(budget?.allocations).toEqual(allocations);
    });

    it('should return null for non-existent budget', async () => {
      const budget = await getBudget(testPool, TEST_TENANT_ID, 'does-not-exist');
      expect(budget).toBeNull();
    });
  });

  describe('listBudgets', () => {
    it('should list all budgets for tenant', async () => {
      await setBudget(testPool, TEST_TENANT_ID, 'budget-1', 100000, { conversation: 100000 });
      await setBudget(testPool, TEST_TENANT_ID, 'budget-2', 50000, { tools: 50000 });

      const budgets = await listBudgets(testPool, TEST_TENANT_ID, false);

      expect(budgets).toHaveLength(2);
      expect(budgets.map(b => b.budget_name)).toContain('budget-1');
      expect(budgets.map(b => b.budget_name)).toContain('budget-2');
    });

    it('should filter by active status', async () => {
      await setBudget(testPool, TEST_TENANT_ID, 'active-budget', 100000, { conversation: 100000 });
      await setBudget(testPool, TEST_TENANT_ID, 'inactive-budget', 50000, { tools: 50000 }, {
        isActive: false,
      });

      const activeBudgets = await listBudgets(testPool, TEST_TENANT_ID, true);

      expect(activeBudgets).toHaveLength(1);
      expect(activeBudgets[0].budget_name).toBe('active-budget');
    });
  });

  describe('checkBudget', () => {
    it('should calculate budget usage correctly', async () => {
      const allocations: BudgetAllocation = {
        conversation: 50000,
        tools: 30000,
        memory: 20000,
      };
      await setBudget(testPool, TEST_TENANT_ID, 'test-budget', 100000, allocations);

      const currentUsage = {
        conversation: 25000,  // 50% utilization
        tools: 27000,         // 90% utilization (warning)
        memory: 5000,         // 25% utilization
      };

      const result = await checkBudget(testPool, TEST_TENANT_ID, 'test-budget', currentUsage);

      expect(result.budget_name).toBe('test-budget');
      expect(result.total_allocated).toBe(100000);
      expect(result.total_used).toBe(57000);
      expect(result.total_remaining).toBe(43000);
      expect(result.overall_utilization_percent).toBeCloseTo(57, 0); // Allow floating point variance
      expect(result.overall_status).toBe('ok');

      // Check category details
      const conversationUsage = result.category_usage.find(u => u.category === 'conversation');
      expect(conversationUsage?.utilization_percent).toBeCloseTo(50, 0);
      expect(conversationUsage?.status).toBe('ok');

      const toolsUsage = result.category_usage.find(u => u.category === 'tools');
      expect(toolsUsage?.utilization_percent).toBeCloseTo(90, 0);
      expect(toolsUsage?.status).toBe('critical');
    });

    it('should detect exceeded budget', async () => {
      const allocations: BudgetAllocation = { conversation: 50000 };
      await setBudget(testPool, TEST_TENANT_ID, 'test-budget', 50000, allocations);

      const currentUsage = { conversation: 60000 };  // Exceeded

      const result = await checkBudget(testPool, TEST_TENANT_ID, 'test-budget', currentUsage);

      expect(result.overall_status).toBe('exceeded');
      expect(result.category_usage[0].status).toBe('exceeded');
      expect(result.warnings.some(w => w.includes('exceeded budget'))).toBe(true);
    });

    it('should generate warning for approaching limit', async () => {
      const allocations: BudgetAllocation = { conversation: 100000 };
      await setBudget(testPool, TEST_TENANT_ID, 'test-budget', 100000, allocations);

      const currentUsage = { conversation: 80000 };  // 80% = warning

      const result = await checkBudget(testPool, TEST_TENANT_ID, 'test-budget', currentUsage);

      expect(result.category_usage[0].status).toBe('warning');
      expect(result.warnings.some(w => w.includes('approaching limit'))).toBe(true);
    });

    it('should recommend compression when trigger exceeded', async () => {
      const allocations: BudgetAllocation = { conversation: 100000 };
      await setBudget(testPool, TEST_TENANT_ID, 'test-budget', 100000, allocations, {
        compressionTriggerPercent: 70,
      });

      const currentUsage = { conversation: 75000 };  // 75% > 70% trigger

      const result = await checkBudget(testPool, TEST_TENANT_ID, 'test-budget', currentUsage);

      expect(result.recommendations.some(r => r.includes('compressing context'))).toBe(true);
    });

    it('should recommend reallocation for imbalanced usage', async () => {
      const allocations: BudgetAllocation = {
        conversation: 50000,
        tools: 40000,
        memory: 10000,
      };
      await setBudget(testPool, TEST_TENANT_ID, 'test-budget', 100000, allocations);

      const currentUsage = {
        conversation: 45000,  // 90% (high)
        tools: 5000,          // 12.5% (low)
        memory: 1000,         // 10% (low)
      };

      const result = await checkBudget(testPool, TEST_TENANT_ID, 'test-budget', currentUsage);

      expect(result.recommendations.some(r => r.includes('reallocating budget'))).toBe(true);
    });

    it('should throw error for non-existent budget', async () => {
      await expect(
        checkBudget(testPool, TEST_TENANT_ID, 'does-not-exist', {})
      ).rejects.toThrow('not found');
    });

    it('should throw error for inactive budget', async () => {
      await setBudget(testPool, TEST_TENANT_ID, 'inactive-budget', 100000, { conversation: 100000 }, {
        isActive: false,
      });

      await expect(
        checkBudget(testPool, TEST_TENANT_ID, 'inactive-budget', {})
      ).rejects.toThrow('not active');
    });
  });

  describe('applyBudgetTemplate', () => {
    it('should apply coding template', async () => {
      const budget = await applyBudgetTemplate(testPool, TEST_TENANT_ID, 'my-coding-budget', 'coding');

      expect(budget.budget_name).toBe('my-coding-budget');
      expect(budget.total_tokens).toBe(BUDGET_TEMPLATES.coding.total_tokens);
      expect(budget.allocations).toEqual(BUDGET_TEMPLATES.coding.allocations);
      expect(budget.metadata).toHaveProperty('template', 'coding');
    });

    it('should apply research template', async () => {
      const budget = await applyBudgetTemplate(testPool, TEST_TENANT_ID, 'my-research-budget', 'research');

      expect(budget.total_tokens).toBe(BUDGET_TEMPLATES.research.total_tokens);
      expect(budget.allocations).toEqual(BUDGET_TEMPLATES.research.allocations);
    });

    it('should apply conversation template', async () => {
      const budget = await applyBudgetTemplate(testPool, TEST_TENANT_ID, 'my-conversation-budget', 'conversation');

      expect(budget.total_tokens).toBe(BUDGET_TEMPLATES.conversation.total_tokens);
      expect(budget.allocations).toEqual(BUDGET_TEMPLATES.conversation.allocations);
    });

    it('should apply automation template', async () => {
      const budget = await applyBudgetTemplate(testPool, TEST_TENANT_ID, 'my-automation-budget', 'automation');

      expect(budget.total_tokens).toBe(BUDGET_TEMPLATES.automation.total_tokens);
      expect(budget.allocations).toEqual(BUDGET_TEMPLATES.automation.allocations);
    });

    it('should scale allocations with custom total tokens', async () => {
      const budget = await applyBudgetTemplate(testPool, TEST_TENANT_ID, 'scaled-budget', 'coding', {
        totalTokens: 200000,  // 2x the template default
      });

      expect(budget.total_tokens).toBe(200000);
      // Allocations should be scaled 2x
      expect(budget.allocations.system).toBe(10000);  // 5000 * 2
      expect(budget.allocations.conversation).toBe(40000);  // 20000 * 2
    });

    it('should apply custom allocation adjustments', async () => {
      // Override memory downward so total allocations stay ≤ template total (100k)
      // coding template: system=5k, conversation=20k, tools=30k, memory=25k, working_state=15k, decisions=5k = 100k
      // Override memory to 20k → total = 95k ≤ 100k ✓
      const budget = await applyBudgetTemplate(testPool, TEST_TENANT_ID, 'custom-budget', 'coding', {
        allocationAdjustments: {
          memory: 20000,  // Override template default (25000 → 20000, frees 5k)
        },
      });

      expect(budget.total_tokens).toBe(100000);  // Template default unchanged
      expect(budget.allocations.memory).toBe(20000);
      expect(budget.allocations.system).toBe(5000);   // Others unchanged from template
      expect(budget.allocations.conversation).toBe(20000);
    });

    it('should apply custom thresholds', async () => {
      const budget = await applyBudgetTemplate(testPool, TEST_TENANT_ID, 'custom-threshold-budget', 'coding', {
        thresholds: { warning_percent: 60, critical_percent: 85 },
      });

      expect(budget.thresholds).toEqual({ warning_percent: 60, critical_percent: 85 });
    });

    it('should reject unknown template', async () => {
      await expect(
        applyBudgetTemplate(testPool, TEST_TENANT_ID, 'bad-template', 'unknown' as any)
      ).rejects.toThrow('Unknown budget template');
    });
  });

  describe('BUDGET_TEMPLATES', () => {
    it('should have all expected templates', () => {
      expect(BUDGET_TEMPLATES).toHaveProperty('coding');
      expect(BUDGET_TEMPLATES).toHaveProperty('research');
      expect(BUDGET_TEMPLATES).toHaveProperty('conversation');
      expect(BUDGET_TEMPLATES).toHaveProperty('automation');
    });

    it('should have valid allocations that sum <= total', () => {
      for (const [name, template] of Object.entries(BUDGET_TEMPLATES)) {
        const sum = Object.values(template.allocations).reduce((a, b) => a + b, 0);
        expect(sum).toBeLessThanOrEqual(template.total_tokens);
      }
    });

    it('should have descriptions', () => {
      for (const template of Object.values(BUDGET_TEMPLATES)) {
        expect(template.description).toBeTruthy();
        expect(template.description.length).toBeGreaterThan(10);
      }
    });
  });
});
