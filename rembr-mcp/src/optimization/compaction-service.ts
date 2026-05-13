/**
 * Memory Compaction Service (REM-88)
 * 
 * Automatically compacts memories when a user downgrades their plan
 * and exceeds the new memory limit by merging similar memories.
 */

import { Pool } from 'pg';
import { logger } from '../logger.js';
import { OllamaClient } from '../ollama-client.js';

export interface CompactionCandidate {
  id: string;
  content: string;
  category: string;
  tags: string[];
  relevance_score?: number;
  created_at: Date;
  embedding?: number[];
}

export interface CompactionResult {
  success: boolean;
  initial_count: number;
  final_count: number;
  target_limit: number;
  merged_groups: MergedGroup[];
  audit_log_id?: string;
  error?: string;
}

export interface MergedGroup {
  merged_memory_id: string;
  original_memory_ids: string[];
  category: string;
  merged_content: string;
  compression_ratio: number;
}

export interface CompactionOptions {
  /**
   * Minimum similarity threshold for merging (0.0 - 1.0)
   * Default: 0.7 (70% similar)
   */
  similarity_threshold?: number;

  /**
   * Maximum number of memories to merge in one group
   * Default: 5
   */
  max_group_size?: number;

  /**
   * Dry run mode (don't actually delete/merge)
   * Default: false
   */
  dry_run?: boolean;

  /**
   * Priority strategy: 'oldest' | 'lowest_relevance' | 'largest'
   * Default: 'lowest_relevance'
   */
  priority_strategy?: 'oldest' | 'lowest_relevance' | 'largest';
}

/**
 * Compact memories for a tenant to fit within a new limit
 */
export async function compactMemories(
  pool: Pool,
  tenantId: string,
  targetLimit: number,
  options: CompactionOptions = {}
): Promise<CompactionResult> {
  const {
    similarity_threshold = 0.7,
    max_group_size = 5,
    dry_run = false,
    priority_strategy = 'lowest_relevance',
  } = options;

  logger.info(`[Compaction] Starting for tenant ${tenantId}, target limit: ${targetLimit}`);

  try {
    // 1. Get current memory count
    const countResult = await pool.query(
      'SELECT COUNT(*) as count FROM memories WHERE tenant_id = $1',
      [tenantId]
    );
    const initialCount = parseInt(countResult.rows[0].count, 10);

    if (initialCount <= targetLimit) {
      logger.info(`[Compaction] No compaction needed: ${initialCount} <= ${targetLimit}`);
      return {
        success: true,
        initial_count: initialCount,
        final_count: initialCount,
        target_limit: targetLimit,
        merged_groups: [],
      };
    }

    const memoriesToRemove = initialCount - targetLimit;
    logger.info(`[Compaction] Need to remove ${memoriesToRemove} memories`);

    // 2. Fetch all memories with embeddings
    const memoriesResult = await pool.query<CompactionCandidate>(
      `SELECT 
        id, 
        content, 
        category, 
        tags, 
        relevance_score, 
        created_at,
        embedding
      FROM memories 
      WHERE tenant_id = $1
      ORDER BY ${getPriorityOrderClause(priority_strategy)}`,
      [tenantId]
    );

    // Parse embeddings from pgvector string format to number arrays
    const memories = memoriesResult.rows.map((row: any) => ({
      ...row,
      embedding: row.embedding ? JSON.parse(row.embedding) : undefined
    }));
    
    if (memories.length === 0) {
      return {
        success: true,
        initial_count: 0,
        final_count: 0,
        target_limit: targetLimit,
        merged_groups: [],
      };
    }

    // 3. Group memories by category
    const memoriesByCategory = groupByCategory(memories);

    // 4. Identify merge candidates
    const mergeGroups: CompactionCandidate[][] = [];
    let removedCount = 0;

    for (const [category, categoryMemories] of Object.entries(memoriesByCategory)) {
      if (removedCount >= memoriesToRemove) break;

      // Find similar memories within this category
      const categoryGroups = await findSimilarGroups(
        categoryMemories,
        similarity_threshold,
        max_group_size
      );

      for (const group of categoryGroups) {
        if (removedCount >= memoriesToRemove) break;

        // We'll merge N memories into 1, removing N-1
        const willRemove = group.length - 1;
        if (removedCount + willRemove <= memoriesToRemove) {
          mergeGroups.push(group);
          removedCount += willRemove;
        }
      }
    }

    if (mergeGroups.length === 0) {
      logger.warn(`[Compaction] No similar memories found to merge`);
      return {
        success: false,
        initial_count: initialCount,
        final_count: initialCount,
        target_limit: targetLimit,
        merged_groups: [],
        error: 'No similar memories found to merge. Cannot reduce memory count without data loss.',
      };
    }

    // 5. Perform merges
    const mergedGroups: MergedGroup[] = [];

    for (const group of mergeGroups) {
      const merged = await mergeMemoryGroup(pool, tenantId, group, dry_run);
      mergedGroups.push(merged);
    }

    // 6. Get final count
    const finalCountResult = await pool.query(
      'SELECT COUNT(*) as count FROM memories WHERE tenant_id = $1',
      [tenantId]
    );
    const finalCount = parseInt(finalCountResult.rows[0].count, 10);

    // 7. Log audit trail
    let auditLogId: string | undefined;
    if (!dry_run) {
      auditLogId = await logCompactionAudit(pool, tenantId, {
        initial_count: initialCount,
        final_count: finalCount,
        target_limit: targetLimit,
        merged_groups: mergedGroups,
      });
    }

    logger.info(`[Compaction] Complete: ${initialCount} → ${finalCount} (target: ${targetLimit})`);

    return {
      success: true,
      initial_count: initialCount,
      final_count: finalCount,
      target_limit: targetLimit,
      merged_groups: mergedGroups,
      audit_log_id: auditLogId,
    };
  } catch (error) {
    logger.error(`[Compaction] Error:`, error as Error);
    throw error;
  }
}

/**
 * Get ORDER BY clause based on priority strategy
 */
function getPriorityOrderClause(strategy: string): string {
  switch (strategy) {
    case 'oldest':
      return 'created_at ASC';
    case 'lowest_relevance':
      return 'COALESCE(relevance_score, 0.0) ASC, created_at ASC';
    case 'largest':
      return 'LENGTH(content) DESC';
    default:
      return 'COALESCE(relevance_score, 0.0) ASC, created_at ASC';
  }
}

/**
 * Group memories by category
 */
function groupByCategory(memories: CompactionCandidate[]): Record<string, CompactionCandidate[]> {
  const groups: Record<string, CompactionCandidate[]> = {};

  for (const memory of memories) {
    const category = memory.category || 'uncategorized';
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(memory);
  }

  return groups;
}

/**
 * Find similar memory groups within a category using vector similarity
 */
async function findSimilarGroups(
  memories: CompactionCandidate[],
  similarityThreshold: number,
  maxGroupSize: number
): Promise<CompactionCandidate[][]> {
  const groups: CompactionCandidate[][] = [];
  const used = new Set<string>();

  for (let i = 0; i < memories.length; i++) {
    if (used.has(memories[i].id)) continue;

    const group: CompactionCandidate[] = [memories[i]];
    used.add(memories[i].id);

    // Find similar memories
    for (let j = i + 1; j < memories.length && group.length < maxGroupSize; j++) {
      if (used.has(memories[j].id)) continue;

      const similarity = await calculateSimilarity(memories[i], memories[j]);

      if (similarity >= similarityThreshold) {
        group.push(memories[j]);
        used.add(memories[j].id);
      }
    }

    // Only create groups with 2+ memories (need at least 2 to merge)
    if (group.length >= 2) {
      groups.push(group);
    }
  }

  return groups;
}

/**
 * Calculate cosine similarity between two memories using embeddings
 */
async function calculateSimilarity(
  memory1: CompactionCandidate,
  memory2: CompactionCandidate
): Promise<number> {
  // If embeddings are missing, fall back to simple text similarity
  if (!memory1.embedding || !memory2.embedding) {
    return calculateTextSimilarity(memory1.content, memory2.content);
  }

  // Cosine similarity
  let dotProduct = 0;
  let mag1 = 0;
  let mag2 = 0;

  for (let i = 0; i < memory1.embedding.length; i++) {
    dotProduct += memory1.embedding[i] * memory2.embedding[i];
    mag1 += memory1.embedding[i] * memory1.embedding[i];
    mag2 += memory2.embedding[i] * memory2.embedding[i];
  }

  const magnitude = Math.sqrt(mag1) * Math.sqrt(mag2);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Simple text-based similarity (Jaccard index of word sets)
 */
function calculateTextSimilarity(text1: string, text2: string): Promise<number> {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return Promise.resolve(intersection.size / union.size);
}

/**
 * Merge a group of memories into one consolidated memory using LLM
 */
async function mergeMemoryGroup(
  pool: Pool,
  tenantId: string,
  group: CompactionCandidate[],
  dryRun: boolean
): Promise<MergedGroup> {
  const originalIds = group.map(m => m.id);
  const category = group[0].category;

  logger.info(`[Compaction] Merging ${group.length} memories in category: ${category}`);

  // Generate merged content using LLM
  const mergedContent = await generateMergedContent(group);

  if (dryRun) {
    return {
      merged_memory_id: 'dry-run-' + originalIds[0],
      original_memory_ids: originalIds,
      category,
      merged_content: mergedContent,
      compression_ratio: group.length,
    };
  }

  // Create merged memory
  const insertResult = await pool.query(
    `INSERT INTO memories (tenant_id, content, category, tags, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      tenantId,
      mergedContent,
      category,
      Array.from(new Set(group.flatMap(m => m.tags || []))), // Union of all tags
      {
        compacted: true,
        original_count: group.length,
        original_ids: originalIds,
        compaction_date: new Date().toISOString(),
      },
    ]
  );

  const mergedId = insertResult.rows[0].id;

  // Delete original memories
  await pool.query(
    'DELETE FROM memories WHERE id = ANY($1) AND tenant_id = $2',
    [originalIds, tenantId]
  );

  logger.info(`[Compaction] Merged ${group.length} memories → ${mergedId}`);

  return {
    merged_memory_id: mergedId,
    original_memory_ids: originalIds,
    category,
    merged_content: mergedContent,
    compression_ratio: group.length,
  };
}

/**
 * Generate merged content using LLM
 */
async function generateMergedContent(group: CompactionCandidate[]): Promise<string> {
  const ollamaClient = OllamaClient.getInstance();

  const prompt = `You are a memory compression assistant. Merge the following ${group.length} related memories into a single concise summary that preserves all important information.

Memories to merge:
${group.map((m, i) => `${i + 1}. ${m.content}`).join('\n\n')}

Create a consolidated memory that:
- Preserves all key facts and details
- Removes redundancy
- Uses clear, concise language
- Maintains the same category/context
- Is shorter than the sum of originals

Consolidated memory:`;

  try {
    const response = await ollamaClient.generateText(prompt, undefined, {
      maxTokens: 500,
      temperature: 0.3, // Low temperature for factual consolidation
    });

    return response.trim();
  } catch (error) {
    logger.error(`[Compaction] LLM merge failed:`, error as Error);

    // Fallback: simple concatenation with deduplication
    const uniqueLines = new Set<string>();
    for (const memory of group) {
      for (const line of memory.content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          uniqueLines.add(trimmed);
        }
      }
    }

    return Array.from(uniqueLines).join('\n');
  }
}

/**
 * Log compaction event to audit trail
 */
async function logCompactionAudit(
  pool: Pool,
  tenantId: string,
  result: Omit<CompactionResult, 'success' | 'audit_log_id'>
): Promise<string> {
  const auditResult = await pool.query(
    `INSERT INTO audit_log (
      tenant_id,
      action,
      resource_type,
      resource_id,
      details,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())
    RETURNING id`,
    [
      tenantId,
      'memory_compaction',
      'memories',
      null,
      {
        initial_count: result.initial_count,
        final_count: result.final_count,
        target_limit: result.target_limit,
        merged_groups_count: result.merged_groups.length,
        merged_groups: result.merged_groups.map(g => ({
          merged_id: g.merged_memory_id,
          original_ids: g.original_memory_ids,
          category: g.category,
          compression_ratio: g.compression_ratio,
        })),
      },
    ]
  );

  return auditResult.rows[0].id;
}

/**
 * Get plan memory limit for a tenant
 */
export async function getPlanMemoryLimit(
  pool: Pool,
  tenantId: string
): Promise<number | null> {
  const result = await pool.query(
    'SELECT memory_limit FROM tenant_plans WHERE tenant_id = $1',
    [tenantId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].memory_limit;
}

/**
 * Check if compaction is needed for a tenant
 */
export async function isCompactionNeeded(
  pool: Pool,
  tenantId: string
): Promise<{ needed: boolean; currentCount: number; limit: number | null }> {
  const limit = await getPlanMemoryLimit(pool, tenantId);

  if (limit === null) {
    return { needed: false, currentCount: 0, limit: null };
  }

  const countResult = await pool.query(
    'SELECT COUNT(*) as count FROM memories WHERE tenant_id = $1',
    [tenantId]
  );

  const currentCount = parseInt(countResult.rows[0].count, 10);

  return {
    needed: currentCount > limit,
    currentCount,
    limit,
  };
}

// ─── RAD-73: Grace period scheduling + project-scoped compaction ──────────────

export interface CompactionSchedule {
  id: string;
  tenant_id: string;
  old_plan: string;
  new_plan: string;
  old_memory_limit: number;
  new_memory_limit: number;
  current_memory_count: number;
  scheduled_at: Date;
  execute_after: Date;
  grace_period_days: number;
  user_consented: boolean;
  consented_at?: Date;
  status: 'pending' | 'consented' | 'executing' | 'completed' | 'cancelled' | 'failed' | 'overage_allowed';
  executed_at?: Date;
  result?: CompactionResult;
  notified_email: boolean;
  notified_inapp: boolean;
  notified_support: boolean;
  created_at: Date;
}

/**
 * Schedule a compaction with grace period (RAD-73).
 * Called immediately after a plan downgrade is confirmed.
 * Returns the schedule record — caller should trigger notifications.
 */
/**
 * Get the subscription end date for a tenant from Stripe billing context.
 * Returns null if no subscription or column not present.
 */
export async function getSubscriptionEndDate(
  pool: Pool,
  tenantId: string
): Promise<Date | null> {
  const result = await pool.query(
    'SELECT current_period_end FROM tenants WHERE id = $1',
    [tenantId]
  );
  if (result.rows.length === 0 || !result.rows[0].current_period_end) return null;
  return new Date(result.rows[0].current_period_end);
}

/**
 * Compute the execute_after date for a compaction schedule (RAD-73 refinement):
 *
 * Priority:
 *   1. subscription_end_date (user paid through this date)
 *   2. Fallback: NOW() + fallback_grace_days (default 7)
 *
 * Floor: at least 24h from now (even if subscription ends today mid-day).
 * If subscription_end_date is in the past (expired sub), use fallback.
 */
export function computeExecuteAfter(opts: {
  subscription_end_date?: Date | null;
  fallback_grace_days?: number;
}): Date {
  const now = new Date();
  const minFloor = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h from now
  const fallback = new Date(now.getTime() + (opts.fallback_grace_days ?? 7) * 24 * 60 * 60 * 1000);

  if (opts.subscription_end_date && opts.subscription_end_date > minFloor) {
    // Use subscription end date (already after 24h floor)
    return opts.subscription_end_date;
  }

  // Expired sub or no sub data → use fallback, but at least the 24h floor
  return fallback > minFloor ? fallback : minFloor;
}

export async function scheduleCompaction(
  pool: Pool,
  tenantId: string,
  opts: {
    old_plan: string;
    new_plan: string;
    old_memory_limit: number;
    new_memory_limit: number;
    current_memory_count: number;
    /** Explicit execute_after date (e.g. subscription_end_date from Stripe webhook). */
    execute_after?: Date;
    /** Fallback grace period if execute_after is not provided or is in the past. Default: 7 days. */
    grace_period_days?: number;
  }
): Promise<CompactionSchedule> {
  const graceDays = opts.grace_period_days ?? 7;

  // RAD-73: use subscription end date if provided; enforce 24h floor; fall back to grace days
  const executeAfter = opts.execute_after
    ? computeExecuteAfter({ subscription_end_date: opts.execute_after, fallback_grace_days: graceDays })
    : computeExecuteAfter({ fallback_grace_days: graceDays });

  const result = await pool.query<CompactionSchedule>(
    `INSERT INTO compaction_schedules (
      tenant_id, old_plan, new_plan, old_memory_limit, new_memory_limit,
      current_memory_count, execute_after, grace_period_days
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT DO NOTHING
    RETURNING *`,
    [
      tenantId,
      opts.old_plan, opts.new_plan,
      opts.old_memory_limit, opts.new_memory_limit,
      opts.current_memory_count,
      executeAfter,
      graceDays,
    ]
  );

  return result.rows[0];
}

/**
 * Record user consent for compaction.
 * Moves the schedule from 'pending' → 'consented', triggering execution at execute_after.
 */
export async function consentToCompaction(
  pool: Pool,
  tenantId: string,
  scheduleId: string
): Promise<CompactionSchedule | null> {
  const result = await pool.query<CompactionSchedule>(
    `UPDATE compaction_schedules
     SET status = 'consented', user_consented = TRUE, consented_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
     RETURNING *`,
    [scheduleId, tenantId]
  );
  return result.rows[0] ?? null;
}

/**
 * Get all compaction schedules for a tenant.
 */
export async function getCompactionHistory(
  pool: Pool,
  tenantId: string,
  limit = 10
): Promise<CompactionSchedule[]> {
  const result = await pool.query<CompactionSchedule>(
    `SELECT * FROM compaction_schedules
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit]
  );
  return result.rows;
}

/**
 * Cancel a pending compaction schedule (allow temporary overage).
 */
export async function cancelCompaction(
  pool: Pool,
  tenantId: string,
  scheduleId: string
): Promise<CompactionSchedule | null> {
  const result = await pool.query<CompactionSchedule>(
    `UPDATE compaction_schedules
     SET status = 'overage_allowed'
     WHERE id = $1 AND tenant_id = $2 AND status IN ('pending','consented')
     RETURNING *`,
    [scheduleId, tenantId]
  );
  return result.rows[0] ?? null;
}

/**
 * Execute a consented compaction, optionally scoped to a project.
 * RAD-73: respects project boundaries when project_id is provided.
 */
export async function executeScheduledCompaction(
  pool: Pool,
  tenantId: string,
  scheduleId: string,
  opts: {
    project_id?: string;  // scope compaction to a single project
    dry_run?: boolean;
    similarity_threshold?: number;
    max_group_size?: number;
  } = {}
): Promise<CompactionResult> {
  // Load schedule
  const schedResult = await pool.query<CompactionSchedule>(
    `SELECT * FROM compaction_schedules WHERE id = $1 AND tenant_id = $2`,
    [scheduleId, tenantId]
  );

  if (schedResult.rows.length === 0) {
    throw new Error(`Compaction schedule ${scheduleId} not found`);
  }

  const schedule = schedResult.rows[0];

  if (!['consented', 'pending'].includes(schedule.status)) {
    throw new Error(`Compaction schedule is in status '${schedule.status}' — cannot execute`);
  }

  if (!opts.dry_run) {
    // Mark executing
    await pool.query(
      `UPDATE compaction_schedules SET status = 'executing', executed_at = NOW() WHERE id = $1`,
      [scheduleId]
    );
  }

  try {
    // If project-scoped, we need to know the target limit per project
    // For cross-project: use new_memory_limit from the schedule
    const targetLimit = schedule.new_memory_limit;

    // Run compaction (project-scoped if project_id provided)
    let result: CompactionResult;
    if (opts.project_id) {
      result = await compactProjectMemories(pool, tenantId, opts.project_id, targetLimit, {
        dry_run: opts.dry_run,
        similarity_threshold: opts.similarity_threshold,
        max_group_size: opts.max_group_size,
      });
    } else {
      result = await compactMemories(pool, tenantId, targetLimit, {
        dry_run: opts.dry_run,
        similarity_threshold: opts.similarity_threshold,
        max_group_size: opts.max_group_size,
      });
    }

    if (!opts.dry_run) {
      const newStatus = result.success ? 'completed' : 'failed';
      await pool.query(
        `UPDATE compaction_schedules SET status = $1, result = $2 WHERE id = $3`,
        [newStatus, JSON.stringify(result), scheduleId]
      );
    }

    return result;
  } catch (err) {
    if (!opts.dry_run) {
      await pool.query(
        `UPDATE compaction_schedules SET status = 'failed', result = $1 WHERE id = $2`,
        [JSON.stringify({ error: (err as Error).message }), scheduleId]
      );
    }
    throw err;
  }
}

/**
 * Compact memories within a specific project only (RAD-73: project boundary respect).
 */
export async function compactProjectMemories(
  pool: Pool,
  tenantId: string,
  projectId: string,
  targetLimit: number,
  options: CompactionOptions = {}
): Promise<CompactionResult> {
  const {
    similarity_threshold = 0.7,
    max_group_size = 5,
    dry_run = false,
  } = options;

  // Get project memory count
  const countResult = await pool.query(
    `SELECT COUNT(*) as count FROM memories
     WHERE tenant_id = $1 AND (metadata->>'project_id' = $2 OR project_id = $2)`,
    [tenantId, projectId]
  );
  const projectCount = parseInt(countResult.rows[0].count, 10);

  if (projectCount <= targetLimit) {
    return {
      success: true,
      initial_count: projectCount,
      final_count: projectCount,
      target_limit: targetLimit,
      merged_groups: [],
    };
  }

  // Fetch only project memories
  const memoriesResult = await pool.query(
    `SELECT id, content, category, tags, relevance_score, created_at, embedding
     FROM memories
     WHERE tenant_id = $1 AND (metadata->>'project_id' = $2 OR project_id = $2)
     ORDER BY COALESCE(relevance_score, 0.0) ASC, created_at ASC`,
    [tenantId, projectId]
  );

  const memories = memoriesResult.rows.map((row: any) => ({
    ...row,
    embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
  }));

  const memoriesToRemove = projectCount - targetLimit;
  const memoriesByCategory = groupByCategory(memories);
  const mergeGroups: CompactionCandidate[][] = [];
  let removedCount = 0;

  for (const categoryMemories of Object.values(memoriesByCategory)) {
    if (removedCount >= memoriesToRemove) break;
    const groups = await findSimilarGroups(categoryMemories, similarity_threshold, max_group_size);
    for (const group of groups) {
      if (removedCount >= memoriesToRemove) break;
      const willRemove = group.length - 1;
      if (removedCount + willRemove <= memoriesToRemove) {
        mergeGroups.push(group);
        removedCount += willRemove;
      }
    }
  }

  if (mergeGroups.length === 0) {
    return {
      success: false,
      initial_count: projectCount,
      final_count: projectCount,
      target_limit: targetLimit,
      merged_groups: [],
      error: 'No similar memories found within project to merge.',
    };
  }

  const mergedGroups: MergedGroup[] = [];
  for (const group of mergeGroups) {
    const merged = await mergeMemoryGroup(pool, tenantId, group, dry_run);
    mergedGroups.push(merged);
  }

  const finalCount = dry_run
    ? projectCount - mergedGroups.reduce((acc, g) => acc + g.original_memory_ids.length - 1, 0)
    : parseInt((await pool.query(
        `SELECT COUNT(*) as count FROM memories
         WHERE tenant_id = $1 AND (metadata->>'project_id' = $2 OR project_id = $2)`,
        [tenantId, projectId]
      )).rows[0].count, 10);

  return {
    success: true,
    initial_count: projectCount,
    final_count: finalCount,
    target_limit: targetLimit,
    merged_groups: mergedGroups,
  };
}
