/**
 * Plan Regeneration Service (REM-76)
 * 
 * Auto-unstuck mechanism for task execution.
 * Gathers context and generates structured prompts for plan regeneration.
 */

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface RegenerationReason {
  type: 'stuck_detection' | 'manual' | 'failure_threshold' | 'timeout';
  description: string;
  evidence?: string[];
  iteration_count?: number;
  failure_count?: number;
  elapsed_minutes?: number;
}

export interface StuckContext {
  task_id: string;
  task_title?: string;
  acceptance_criteria?: string[];
  iterations: Array<{
    attempt_number: number;
    timestamp: Date;
    approach: string;
    outcome: string;
    error?: string;
  }>;
  related_memories: Array<{
    memory_id: string;
    content: string;
    relevance_score: number;
  }>;
  constraints: string[];
  previous_plans: string[];
  failure_patterns: string[];
}

export interface RegenerationPrompt {
  task_id: string;
  context_summary: string;
  what_failed: string[];
  why_stuck: string;
  available_information: {
    acceptance_criteria: string[];
    related_knowledge: string[];
    constraints: string[];
    attempted_approaches: string[];
  };
  prompt_for_agent: string;
  timestamp: Date;
}

export interface RegenerationRecord {
  id: string;
  tenant_id: string;
  task_id: string;
  reason_type: string;
  reason_description: string;
  context_snapshot: StuckContext;
  generated_prompt: RegenerationPrompt;
  triggered_at: Date;
  resolved_at?: Date;
  new_plan?: string;
  metadata: Record<string, unknown>;
}

/**
 * Trigger plan regeneration
 */
export async function triggerRegeneration(
  pool: Pool,
  tenantId: string,
  taskId: string,
  reason: RegenerationReason
): Promise<RegenerationRecord> {
  // Analyze stuck context
  const context = await analyzeStuckContext(pool, tenantId, taskId);
  
  // Generate structured prompt
  const prompt = generateRegenerationPrompt(context, reason);
  
  // Record regeneration
  const query = `
    INSERT INTO plan_regenerations (
      id,
      tenant_id,
      task_id,
      reason_type,
      reason_description,
      context_snapshot,
      generated_prompt,
      triggered_at,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
    RETURNING *
  `;
  
  const result = await pool.query(query, [
    randomUUID(),
    tenantId,
    taskId,
    reason.type,
    reason.description,
    JSON.stringify(context),
    JSON.stringify(prompt),
    JSON.stringify({
      evidence: reason.evidence || [],
      iteration_count: reason.iteration_count,
      failure_count: reason.failure_count,
      elapsed_minutes: reason.elapsed_minutes,
    }),
  ]);
  
  const row = result.rows[0];
  
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    reason_type: row.reason_type,
    reason_description: row.reason_description,
    context_snapshot: row.context_snapshot,
    generated_prompt: row.generated_prompt,
    triggered_at: row.triggered_at,
    resolved_at: row.resolved_at,
    new_plan: row.new_plan,
    metadata: row.metadata,
  };
}

/**
 * Analyze stuck context for a task
 */
export async function analyzeStuckContext(
  pool: Pool,
  tenantId: string,
  taskId: string
): Promise<StuckContext> {
  // Gather iteration history (from task execution logs or similar)
  const iterations = await getTaskIterations(pool, tenantId, taskId);
  
  // Gather related memories
  const relatedMemories = await getRelatedMemories(pool, tenantId, taskId);
  
  // Extract failure patterns
  const failurePatterns = extractFailurePatterns(iterations);
  
  // Gather constraints (from task metadata)
  const constraints = await getTaskConstraints(pool, tenantId, taskId);
  
  // Gather acceptance criteria
  const acceptanceCriteria = await getAcceptanceCriteria(pool, tenantId, taskId);
  
  // Extract previous plans
  const previousPlans = iterations
    .map(it => it.approach)
    .filter((approach, index, self) => self.indexOf(approach) === index); // unique
  
  return {
    task_id: taskId,
    iterations,
    related_memories: relatedMemories,
    constraints,
    acceptance_criteria: acceptanceCriteria,
    previous_plans: previousPlans,
    failure_patterns: failurePatterns,
  };
}

/**
 * Get regeneration history for a task
 */
export async function getRegenerationHistory(
  pool: Pool,
  tenantId: string,
  taskId: string,
  limit = 10
): Promise<RegenerationRecord[]> {
  const query = `
    SELECT * FROM plan_regenerations
    WHERE tenant_id = $1 AND task_id = $2
    ORDER BY triggered_at DESC
    LIMIT $3
  `;
  
  const result = await pool.query(query, [tenantId, taskId, limit]);
  
  return result.rows.map(row => ({
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    reason_type: row.reason_type,
    reason_description: row.reason_description,
    context_snapshot: row.context_snapshot,
    generated_prompt: row.generated_prompt,
    triggered_at: row.triggered_at,
    resolved_at: row.resolved_at,
    new_plan: row.new_plan,
    metadata: row.metadata,
  }));
}

/**
 * Mark regeneration as resolved with new plan
 */
export async function resolveRegeneration(
  pool: Pool,
  tenantId: string,
  regenerationId: string,
  newPlan: string
): Promise<void> {
  const query = `
    UPDATE plan_regenerations
    SET resolved_at = NOW(), new_plan = $3
    WHERE tenant_id = $1 AND id = $2
  `;
  
  await pool.query(query, [tenantId, regenerationId, newPlan]);
}

/**
 * Generate structured prompt for agent
 */
function generateRegenerationPrompt(
  context: StuckContext,
  reason: RegenerationReason
): RegenerationPrompt {
  const whatFailed = context.iterations
    .filter(it => it.error || it.outcome.toLowerCase().includes('fail'))
    .map(it => `Attempt ${it.attempt_number}: ${it.approach} → ${it.outcome}${it.error ? ' (' + it.error + ')' : ''}`);
  
  const whyStuck = reason.description + (
    reason.iteration_count 
      ? ` (${reason.iteration_count} iterations with similar failures)` 
      : ''
  );
  
  const contextSummary = `Task ${context.task_id} is stuck after ${context.iterations.length} attempts. ` +
    `${context.failure_patterns.length} failure patterns detected. ` +
    `${context.related_memories.length} related memories available.`;
  
  const promptForAgent = `# Plan Regeneration Required

## Task Context
${context.task_title || context.task_id}

## Why We're Stuck
${whyStuck}

## What's Been Tried (and Failed)
${whatFailed.map((f, i) => `${i + 1}. ${f}`).join('\n')}

## Failure Patterns Detected
${context.failure_patterns.map((p, i) => `${i + 1}. ${p}`).join('\n')}

## Acceptance Criteria (Must Satisfy)
${context.acceptance_criteria?.map((c, i) => `${i + 1}. ${c}`).join('\n') || 'None specified'}

## Constraints
${context.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Related Knowledge Available
${context.related_memories.slice(0, 5).map((m, i) => `${i + 1}. ${m.content.substring(0, 100)}... (relevance: ${m.relevance_score.toFixed(2)})`).join('\n')}

## Your Task
Generate a NEW plan that:
1. Avoids the failed approaches listed above
2. Addresses the identified failure patterns
3. Satisfies all acceptance criteria
4. Respects the constraints
5. Leverages the related knowledge

Be creative. If all obvious approaches failed, consider:
- Breaking the problem down differently
- Using different tools or methods
- Challenging assumptions in the acceptance criteria
- Seeking clarification on ambiguous requirements

Provide a concrete, step-by-step plan with clear success criteria for each step.`;
  
  return {
    task_id: context.task_id,
    context_summary: contextSummary,
    what_failed: whatFailed,
    why_stuck: whyStuck,
    available_information: {
      acceptance_criteria: context.acceptance_criteria || [],
      related_knowledge: context.related_memories.map(m => m.content),
      constraints: context.constraints,
      attempted_approaches: context.previous_plans,
    },
    prompt_for_agent: promptForAgent,
    timestamp: new Date(),
  };
}

/**
 * Extract failure patterns from iteration history
 */
function extractFailurePatterns(iterations: Array<{
  attempt_number: number;
  timestamp: Date;
  approach: string;
  outcome: string;
  error?: string;
}>): string[] {
  const patterns: string[] = [];
  
  // Pattern 1: Same error repeating
  const errors = iterations.filter(it => it.error).map(it => it.error);
  const errorCounts = errors.reduce((acc, err) => {
    acc[err!] = (acc[err!] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  Object.entries(errorCounts).forEach(([error, count]) => {
    if (count >= 2) {
      patterns.push(`Repeated error (${count}x): ${error}`);
    }
  });
  
  // Pattern 2: Similar approaches failing
  const approaches = iterations.map(it => it.approach.toLowerCase());
  const approachWords = approaches.flatMap(a => a.split(/\s+/));
  const commonWords = approachWords.reduce((acc, word) => {
    if (word.length > 4) { // Skip short words
      acc[word] = (acc[word] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);
  
  Object.entries(commonWords).forEach(([word, count]) => {
    if (count >= 3) {
      patterns.push(`Repeated approach keyword: "${word}" (${count} iterations)`);
    }
  });
  
  // Pattern 3: All recent attempts failing
  const recentAttempts = iterations.slice(-3);
  const allRecentFailed = recentAttempts.every(it => 
    it.error || it.outcome.toLowerCase().includes('fail')
  );
  
  if (allRecentFailed && recentAttempts.length >= 3) {
    patterns.push(`Last ${recentAttempts.length} attempts all failed - fundamental blocker likely`);
  }
  
  return patterns.length > 0 ? patterns : ['No clear failure pattern detected'];
}

/**
 * Get task iterations from database
 */
async function getTaskIterations(
  pool: Pool,
  tenantId: string,
  taskId: string
): Promise<Array<{
  attempt_number: number;
  timestamp: Date;
  approach: string;
  outcome: string;
  error?: string;
}>> {
  const query = `
    SELECT attempt_number, started_at, approach, outcome, error
    FROM task_iterations
    WHERE tenant_id = $1 AND task_id = $2
    ORDER BY attempt_number ASC
  `;
  
  const result = await pool.query(query, [tenantId, taskId]);
  
  return result.rows.map(row => ({
    attempt_number: row.attempt_number,
    timestamp: row.started_at,
    approach: row.approach,
    outcome: row.outcome,
    error: row.error,
  }));
}

/**
 * Get related memories for context using vector search
 */
async function getRelatedMemories(
  pool: Pool,
  tenantId: string,
  taskId: string
): Promise<Array<{
  memory_id: string;
  content: string;
  relevance_score: number;
}>> {
  // Search memories using task_id as query
  // This assumes memories might contain task-related context
  const query = `
    SELECT id, content, 
           1.0 - (embedding <=> (SELECT embedding FROM memories WHERE tenant_id = $2 AND id = $1 LIMIT 1)) as similarity
    FROM memories
    WHERE tenant_id = $2
      AND id != $1
      AND embedding IS NOT NULL
    ORDER BY embedding <=> (SELECT embedding FROM memories WHERE tenant_id = $2 AND id = $1 LIMIT 1)
    LIMIT 10
  `;
  
  try {
    // Try to find a memory with task_id reference
    const taskMemoryQuery = `
      SELECT id FROM memories 
      WHERE tenant_id = $1 
        AND content ILIKE $2 
      LIMIT 1
    `;
    const taskMemoryResult = await pool.query(taskMemoryQuery, [tenantId, `%${taskId}%`]);
    
    if (taskMemoryResult.rows.length === 0) {
      return [];
    }
    
    const taskMemoryId = taskMemoryResult.rows[0].id;
    const result = await pool.query(query, [taskMemoryId, tenantId]);
    
    return result.rows.map(row => ({
      memory_id: row.id,
      content: row.content,
      relevance_score: row.similarity || 0,
    }));
  } catch (error) {
    // If vector search fails, return empty array
    console.error('Error searching related memories:', error);
    return [];
  }
}

/**
 * Get task constraints from task metadata
 */
async function getTaskConstraints(
  pool: Pool,
  tenantId: string,
  taskId: string
): Promise<string[]> {
  const query = `
    SELECT metadata->'constraints' as constraints
    FROM task_iterations
    WHERE tenant_id = $1 AND task_id = $2
    ORDER BY attempt_number DESC
    LIMIT 1
  `;
  
  try {
    const result = await pool.query(query, [tenantId, taskId]);
    
    if (result.rows.length === 0 || !result.rows[0].constraints) {
      return [
        'Must maintain backward compatibility',
        'Must complete within resource limits',
      ];
    }
    
    const constraints = result.rows[0].constraints;
    return Array.isArray(constraints) ? constraints : [];
  } catch (error) {
    console.error('Error fetching task constraints:', error);
    return ['Must maintain backward compatibility', 'Must complete within resource limits'];
  }
}

/**
 * Get acceptance criteria from task metadata
 */
async function getAcceptanceCriteria(
  pool: Pool,
  tenantId: string,
  taskId: string
): Promise<string[]> {
  const query = `
    SELECT metadata->'acceptance_criteria' as acceptance_criteria
    FROM task_iterations
    WHERE tenant_id = $1 AND task_id = $2
    ORDER BY attempt_number DESC
    LIMIT 1
  `;
  
  try {
    const result = await pool.query(query, [tenantId, taskId]);
    
    if (result.rows.length === 0 || !result.rows[0].acceptance_criteria) {
      return [
        'All tests passing',
        'Documentation updated',
        'Code review approved',
      ];
    }
    
    const criteria = result.rows[0].acceptance_criteria;
    return Array.isArray(criteria) ? criteria : [];
  } catch (error) {
    console.error('Error fetching acceptance criteria:', error);
    return ['All tests passing', 'Documentation updated', 'Code review approved'];
  }
}
