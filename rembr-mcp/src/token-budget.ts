/**
 * Token Budget Utilities (REM-103)
 * 
 * Provides token estimation and budget-aware result truncation for ContextPilot.
 */

import type { Pool } from 'pg';

/**
 * Estimate token count for text using character count / 4.
 * This is a rough approximation; could be improved with tiktoken if needed.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a memory object.
 * Counts tokens in content, tags, and metadata.
 */
export function estimateMemoryTokens(memory: {
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): number {
  let total = estimateTokens(memory.content);
  
  if (memory.tags && memory.tags.length > 0) {
    total += estimateTokens(memory.tags.join(', '));
  }
  
  if (memory.metadata) {
    total += estimateTokens(JSON.stringify(memory.metadata));
  }
  
  return total;
}

/**
 * Get budget limit from context_budgets table for a specific category.
 * Returns null if budget category not found or not active.
 */
export async function getBudgetLimit(
  pool: Pool,
  tenantId: string,
  categoryName: string
): Promise<number | null> {
  const query = `
    SELECT allocations
    FROM context_budgets
    WHERE tenant_id = $1
      AND is_active = TRUE
      AND allocations ? $2
    LIMIT 1
  `;
  
  const result = await pool.query(query, [tenantId, categoryName]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const allocations = result.rows[0].allocations as Record<string, number>;
  return allocations[categoryName] || null;
}

/**
 * Truncate search results to fit within token budget.
 * Returns truncated results with token counts and warnings.
 */
export function truncateToTokenBudget<T extends { content: string; tags?: string[]; metadata?: Record<string, unknown> }>(
  results: T[],
  maxTokens: number
): {
  results: (T & { _token_count: number })[];
  total_tokens: number;
  truncated: boolean;
  original_count: number;
  warning?: string;
} {
  const annotated: (T & { _token_count: number })[] = [];
  let totalTokens = 0;
  let truncated = false;
  
  for (const result of results) {
    const tokens = estimateMemoryTokens(result);
    
    if (totalTokens + tokens <= maxTokens) {
      annotated.push({ ...result, _token_count: tokens });
      totalTokens += tokens;
    } else {
      truncated = true;
      break;
    }
  }
  
  const response: {
    results: (T & { _token_count: number })[];
    total_tokens: number;
    truncated: boolean;
    original_count: number;
    warning?: string;
  } = {
    results: annotated,
    total_tokens: totalTokens,
    truncated,
    original_count: results.length
  };
  
  // Add warning if no results fit
  if (annotated.length === 0 && results.length > 0) {
    response.warning = `No results fit within ${maxTokens} token budget. Smallest result requires ~${estimateMemoryTokens(results[0])} tokens.`;
  }
  
  return response;
}
