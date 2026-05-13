/**
 * Budget Management Service (REM-100)
 * 
 * Provides budget allocation and enforcement for ContextPilot.
 * Manages context_budgets table and provides built-in templates.
 */

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface BudgetAllocation {
  [category: string]: number;
}

export interface BudgetThresholds {
  warning_percent?: number;  // Default: 75%
  critical_percent?: number; // Default: 90%
}

export interface Budget {
  id: string;
  tenant_id: string;
  budget_name: string;
  total_tokens: number;
  allocations: BudgetAllocation;
  thresholds: BudgetThresholds;
  compression_trigger_percent: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
}

export interface BudgetUsage {
  category: string;
  allocated: number;
  used: number;
  remaining: number;
  utilization_percent: number;
  status: 'ok' | 'warning' | 'critical' | 'exceeded';
}

export interface BudgetCheckResult {
  budget_name: string;
  total_allocated: number;
  total_used: number;
  total_remaining: number;
  overall_utilization_percent: number;
  overall_status: 'ok' | 'warning' | 'critical' | 'exceeded';
  category_usage: BudgetUsage[];
  warnings: string[];
  recommendations: string[];
}

/**
 * Built-in budget templates for common use cases
 */
export const BUDGET_TEMPLATES: Record<string, {
  total_tokens: number;
  allocations: BudgetAllocation;
  description: string;
}> = {
  coding: {
    total_tokens: 100000,
    allocations: {
      system: 5000,          // System prompts, instructions
      conversation: 20000,   // User messages, chat history
      tools: 30000,          // Tool outputs, API responses
      memory: 25000,         // Retrieved memories, docs
      working_state: 15000,  // Current task, variables
      decisions: 5000,       // Key decisions, reasoning
    },
    description: 'Optimized for coding tasks with heavy tool usage and memory retrieval',
  },
  research: {
    total_tokens: 100000,
    allocations: {
      system: 5000,
      conversation: 15000,
      tools: 20000,
      memory: 45000,         // Heavy memory allocation for research
      working_state: 10000,
      decisions: 5000,
    },
    description: 'Optimized for research with large memory retrieval needs',
  },
  conversation: {
    total_tokens: 50000,
    allocations: {
      system: 3000,
      conversation: 30000,   // Heavy conversation history
      tools: 5000,
      memory: 8000,
      working_state: 2000,
      decisions: 2000,
    },
    description: 'Optimized for conversational agents with minimal tool usage',
  },
  automation: {
    total_tokens: 75000,
    allocations: {
      system: 5000,
      conversation: 10000,
      tools: 40000,          // Heavy tool usage for automation
      memory: 10000,
      working_state: 8000,
      decisions: 2000,
    },
    description: 'Optimized for automation tasks with frequent tool calls',
  },
};

/**
 * Set or update a budget
 */
export async function setBudget(
  pool: Pool,
  tenantId: string,
  budgetName: string,
  totalTokens: number,
  allocations: BudgetAllocation,
  options?: {
    thresholds?: BudgetThresholds;
    compressionTriggerPercent?: number;
    isActive?: boolean;
    metadata?: Record<string, unknown>;
  }
): Promise<Budget> {
  // Validate allocations sum
  const allocatedSum = Object.values(allocations).reduce((sum, val) => sum + val, 0);
  if (allocatedSum > totalTokens) {
    throw new Error(
      `Budget allocation exceeds total tokens: ${allocatedSum} > ${totalTokens}`
    );
  }

  const thresholds = options?.thresholds || { warning_percent: 75, critical_percent: 90 };
  const compressionTriggerPercent = options?.compressionTriggerPercent ?? 80;
  const isActive = options?.isActive ?? true;
  const metadata = options?.metadata || {};

  // Upsert budget
  const query = `
    INSERT INTO context_budgets (
      id, tenant_id, budget_name, total_tokens, allocations, thresholds,
      compression_trigger_percent, is_active, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (tenant_id, budget_name)
    DO UPDATE SET
      total_tokens = EXCLUDED.total_tokens,
      allocations = EXCLUDED.allocations,
      thresholds = EXCLUDED.thresholds,
      compression_trigger_percent = EXCLUDED.compression_trigger_percent,
      is_active = EXCLUDED.is_active,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *
  `;

  const result = await pool.query(query, [
    randomUUID(),
    tenantId,
    budgetName,
    totalTokens,
    JSON.stringify(allocations),
    JSON.stringify(thresholds),
    compressionTriggerPercent,
    isActive,
    JSON.stringify(metadata),
  ]);

  const row = result.rows[0];
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    budget_name: row.budget_name,
    total_tokens: row.total_tokens,
    allocations: row.allocations,
    thresholds: row.thresholds,
    compression_trigger_percent: row.compression_trigger_percent,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: row.metadata,
  };
}

/**
 * Get a budget by name
 */
export async function getBudget(
  pool: Pool,
  tenantId: string,
  budgetName: string
): Promise<Budget | null> {
  const query = `
    SELECT * FROM context_budgets
    WHERE tenant_id = $1 AND budget_name = $2
  `;

  const result = await pool.query(query, [tenantId, budgetName]);

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    budget_name: row.budget_name,
    total_tokens: row.total_tokens,
    allocations: row.allocations,
    thresholds: row.thresholds,
    compression_trigger_percent: row.compression_trigger_percent,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: row.metadata,
  };
}

/**
 * List all budgets for a tenant
 */
export async function listBudgets(
  pool: Pool,
  tenantId: string,
  activeOnly = true
): Promise<Budget[]> {
  const query = activeOnly
    ? `SELECT * FROM context_budgets WHERE tenant_id = $1 AND is_active = TRUE ORDER BY created_at DESC`
    : `SELECT * FROM context_budgets WHERE tenant_id = $1 ORDER BY created_at DESC`;

  const result = await pool.query(query, [tenantId]);

  return result.rows.map(row => ({
    id: row.id,
    tenant_id: row.tenant_id,
    budget_name: row.budget_name,
    total_tokens: row.total_tokens,
    allocations: row.allocations,
    thresholds: row.thresholds,
    compression_trigger_percent: row.compression_trigger_percent,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: row.metadata,
  }));
}

/**
 * Check budget usage against allocation
 * 
 * @param currentUsage - Map of category to current token usage
 */
export async function checkBudget(
  pool: Pool,
  tenantId: string,
  budgetName: string,
  currentUsage: Record<string, number>
): Promise<BudgetCheckResult> {
  const budget = await getBudget(pool, tenantId, budgetName);

  if (!budget) {
    throw new Error(`Budget '${budgetName}' not found for tenant ${tenantId}`);
  }

  if (!budget.is_active) {
    throw new Error(`Budget '${budgetName}' is not active`);
  }

  const warningThreshold = budget.thresholds.warning_percent ?? 75;
  const criticalThreshold = budget.thresholds.critical_percent ?? 90;

  // Calculate usage per category
  const categoryUsage: BudgetUsage[] = [];
  const warnings: string[] = [];
  let totalUsed = 0;

  for (const [category, allocated] of Object.entries(budget.allocations)) {
    const used = currentUsage[category] || 0;
    const remaining = Math.max(0, allocated - used);
    const utilization = allocated > 0 ? (used / allocated) * 100 : 0;

    let status: 'ok' | 'warning' | 'critical' | 'exceeded' = 'ok';
    if (utilization >= 100) {
      status = 'exceeded';
      warnings.push(`Category '${category}' exceeded budget (${Math.round(utilization)}% used)`);
    } else if (utilization >= criticalThreshold) {
      status = 'critical';
      warnings.push(`Category '${category}' in critical state (${Math.round(utilization)}% used)`);
    } else if (utilization >= warningThreshold) {
      status = 'warning';
      warnings.push(`Category '${category}' approaching limit (${Math.round(utilization)}% used)`);
    }

    categoryUsage.push({
      category,
      allocated,
      used,
      remaining,
      utilization_percent: utilization,
      status,
    });

    totalUsed += used;
  }

  // Calculate overall utilization
  const totalAllocated = Object.values(budget.allocations).reduce((sum, val) => sum + val, 0);
  const totalRemaining = Math.max(0, totalAllocated - totalUsed);
  const overallUtilization = totalAllocated > 0 ? (totalUsed / totalAllocated) * 100 : 0;

  let overallStatus: 'ok' | 'warning' | 'critical' | 'exceeded' = 'ok';
  if (overallUtilization >= 100) {
    overallStatus = 'exceeded';
  } else if (overallUtilization >= criticalThreshold) {
    overallStatus = 'critical';
  } else if (overallUtilization >= warningThreshold) {
    overallStatus = 'warning';
  }

  // Generate recommendations
  const recommendations: string[] = [];

  if (overallUtilization >= budget.compression_trigger_percent) {
    recommendations.push(
      `Consider compressing context (${Math.round(overallUtilization)}% utilization exceeds compression trigger of ${budget.compression_trigger_percent}%)`
    );
  }

  // Find categories with high utilization
  const highUtilCategories = categoryUsage.filter(u => u.utilization_percent >= 80);
  if (highUtilCategories.length > 0) {
    recommendations.push(
      `Review high-utilization categories: ${highUtilCategories.map(u => u.category).join(', ')}`
    );
  }

  // Find categories with low utilization that could be reallocated
  const lowUtilCategories = categoryUsage.filter(
    u => u.utilization_percent < 30 && u.allocated > 5000
  );
  if (lowUtilCategories.length > 0 && highUtilCategories.length > 0) {
    recommendations.push(
      `Consider reallocating budget from underutilized categories: ${lowUtilCategories.map(u => u.category).join(', ')}`
    );
  }

  return {
    budget_name: budgetName,
    total_allocated: totalAllocated,
    total_used: totalUsed,
    total_remaining: totalRemaining,
    overall_utilization_percent: overallUtilization,
    overall_status: overallStatus,
    category_usage: categoryUsage,
    warnings,
    recommendations,
  };
}

/**
 * Apply a budget template
 */
export async function applyBudgetTemplate(
  pool: Pool,
  tenantId: string,
  budgetName: string,
  templateName: keyof typeof BUDGET_TEMPLATES,
  customizations?: {
    totalTokens?: number;
    allocationAdjustments?: Partial<BudgetAllocation>;
    thresholds?: BudgetThresholds;
  }
): Promise<Budget> {
  const template = BUDGET_TEMPLATES[templateName];
  if (!template) {
    throw new Error(`Unknown budget template: ${templateName}`);
  }

  const totalTokens = customizations?.totalTokens ?? template.total_tokens;
  let allocations = { ...template.allocations };

  // Scale allocations if total tokens changed (before applying adjustments)
  if (customizations?.totalTokens && customizations.totalTokens !== template.total_tokens) {
    const scaleFactor = customizations.totalTokens / template.total_tokens;
    for (const [category, amount] of Object.entries(allocations)) {
      allocations[category] = Math.round(amount * scaleFactor);
    }
  }

  // Apply customizations (after scaling, so user overrides are not scaled)
  if (customizations?.allocationAdjustments) {
    const filtered = Object.fromEntries(Object.entries(customizations.allocationAdjustments).filter(([_, v]) => v !== undefined)) as { [k: string]: number };
    allocations = { ...allocations, ...filtered };
  }

  return setBudget(pool, tenantId, budgetName, totalTokens, allocations, {
    thresholds: customizations?.thresholds,
    metadata: {
      template: templateName,
      template_description: template.description,
    },
  });
}
