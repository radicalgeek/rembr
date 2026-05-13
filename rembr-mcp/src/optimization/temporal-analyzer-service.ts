import { MemoryDatabase, Memory } from '../database.js';

/**
 * Memory freshness analysis result
 */
export interface FreshnessAnalysis {
  memoryId: string;
  ageDays: number;
  daysSinceLastAccess: number;
  accessCount: number;
  freshnessScore: number; // 0.0-1.0
  isOutdated: boolean;
  category: string;
}

/**
 * Archival result
 */
export interface ArchivalResult {
  archivedCount: number;
  memoryIds: string[];
}

/**
 * TemporalAnalyzerService - Analyzes memory freshness and archives outdated content
 * 
 * Responsibilities:
 * - Identify outdated memories based on age + access patterns
 * - Mark stale memories for review
 * - Archive outdated content
 * 
 * Freshness Algorithm:
 * - Age Factor: Newer memories score higher
 * - Access Factor: Frequently accessed memories score higher
 * - Category Factor: Different categories age differently
 *   - facts: Age faster (60 day threshold)
 *   - preferences: Age slower (365 day threshold)
 *   - projects: Medium aging (180 day threshold)
 * 
 * Outdated Criteria:
 * - Age > threshold AND last_accessed > 90 days ago
 * - OR access_count = 0 AND age > 2x threshold
 */
export class TemporalAnalyzerService {
  // Category-specific aging thresholds (in days)
  private readonly CATEGORY_THRESHOLDS: Record<string, number> = {
    facts: 60,
    conversations: 90,
    learning: 120,
    projects: 180,
    preferences: 365,
    goals: 180,
    context: 90,
    reminders: 30
  };

  private readonly DEFAULT_THRESHOLD = 180;
  private readonly LAST_ACCESS_THRESHOLD_DAYS = 90;

  constructor(private db: MemoryDatabase) {}

  /**
   * Analyze memory freshness for all memories in tenant
   * @param tenantId Tenant to analyze
   * @param outdatedThresholdDays Override default threshold
   * @returns Array of freshness analyses
   */
  async analyzeMemoryFreshness(
    tenantId: string,
    outdatedThresholdDays?: number
  ): Promise<FreshnessAnalysis[]> {
    // Set tenant context
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    // Query memories with access stats
    const result = await this.db.query(`
      SELECT 
        m.id,
        m.content,
        m.category,
        m.created_at,
        m.metadata
      FROM memories m
      WHERE m.tenant_id = $1
      ORDER BY m.created_at DESC
    `, [tenantId]);

    const now = new Date();
    const analyses: FreshnessAnalysis[] = [];

    for (const memory of result.rows) {
      const ageDays = this.daysBetween(memory.created_at, now);
      
      // Extract access info from metadata (if tracked)
      const lastAccessedAt = memory.metadata?.last_accessed_at 
        ? new Date(memory.metadata.last_accessed_at) 
        : memory.created_at;
      const accessCount = memory.metadata?.access_count || 0;
      
      const daysSinceLastAccess = this.daysBetween(lastAccessedAt, now);

      // Calculate freshness score
      const threshold = outdatedThresholdDays || this.CATEGORY_THRESHOLDS[memory.category] || this.DEFAULT_THRESHOLD;
      const freshnessScore = this.calculateFreshnessScore(
        ageDays,
        daysSinceLastAccess,
        accessCount,
        threshold
      );

      // Determine if outdated
      const isOutdated = this.isMemoryOutdated(
        ageDays,
        daysSinceLastAccess,
        accessCount,
        threshold
      );

      analyses.push({
        memoryId: memory.id,
        ageDays,
        daysSinceLastAccess,
        accessCount,
        freshnessScore,
        isOutdated,
        category: memory.category
      });
    }

    return analyses;
  }

  /**
   * Mark memories as outdated in metadata
   * @param memoryIds Memory IDs to mark
   * @param tenantId Tenant ID
   * @returns Number of memories marked
   */
  async markOutdated(memoryIds: string[], tenantId: string): Promise<number> {
    if (memoryIds.length === 0) return 0;

    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    const result = await this.db.query(`
      UPDATE memories
      SET metadata = jsonb_set(
        jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{outdated}',
          'true'::jsonb
        ),
        '{outdated_marked_at}',
        to_jsonb(NOW()::text)
      )
      WHERE id = ANY($1)
    `, [memoryIds]);

    return result.rowCount || 0;
  }

  /**
   * Archive outdated memories
   * @param memoryIds Memory IDs to archive
   * @param tenantId Tenant ID
   * @returns Archival result
   */
  async archiveOutdated(memoryIds: string[], tenantId: string): Promise<ArchivalResult> {
    if (memoryIds.length === 0) {
      return { archivedCount: 0, memoryIds: [] };
    }

    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    // Copy to archived_memories
    await this.db.query(`
      INSERT INTO archived_memories (
        id, tenant_id, project_id, content, category, embedding,
        archived_reason, original_created_at, original_updated_at, metadata
      )
      SELECT 
        m.id, m.tenant_id, m.project_id, m.content, m.category, me.embedding,
        'outdated', m.created_at, m.updated_at, m.metadata
      FROM memories m
      LEFT JOIN memory_embeddings me ON m.id = me.memory_id
      WHERE m.id = ANY($1)
    `, [memoryIds]);

    // Delete from memories
    const result = await this.db.query(`
      DELETE FROM memories WHERE id = ANY($1) AND tenant_id = $2
    `, [memoryIds, tenantId]);

    return {
      archivedCount: result.rowCount || 0,
      memoryIds
    };
  }

  /**
   * Get freshness statistics for tenant
   * @param tenantId Tenant ID
   * @returns Stats object
   */
  async getStats(tenantId: string): Promise<{
    totalMemories: number;
    freshMemories: number; // < 30 days
    outdatedMemories: number;
    avgAgeDays: number;
  }> {
    const analyses = await this.analyzeMemoryFreshness(tenantId);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const freshCount = analyses.filter(a => a.ageDays < 30).length;
    const outdatedCount = analyses.filter(a => a.isOutdated).length;
    const avgAge = analyses.reduce((sum, a) => sum + a.ageDays, 0) / (analyses.length || 1);

    return {
      totalMemories: analyses.length,
      freshMemories: freshCount,
      outdatedMemories: outdatedCount,
      avgAgeDays: Math.round(avgAge)
    };
  }

  /**
   * Calculate freshness score (0.0-1.0)
   * Higher score = fresher memory
   */
  private calculateFreshnessScore(
    ageDays: number,
    daysSinceLastAccess: number,
    accessCount: number,
    threshold: number
  ): number {
    // Age component (0.5 weight)
    const ageScore = Math.max(0, 1 - (ageDays / threshold));

    // Access recency component (0.3 weight)
    const accessScore = Math.max(0, 1 - (daysSinceLastAccess / this.LAST_ACCESS_THRESHOLD_DAYS));

    // Access frequency component (0.2 weight)
    const frequencyScore = Math.min(1, accessCount / 10); // Cap at 10 accesses

    const score = (ageScore * 0.5) + (accessScore * 0.3) + (frequencyScore * 0.2);
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Determine if memory is outdated
   */
  private isMemoryOutdated(
    ageDays: number,
    daysSinceLastAccess: number,
    accessCount: number,
    threshold: number
  ): boolean {
    // Never accessed and very old
    if (accessCount === 0 && ageDays > threshold * 2) {
      return true;
    }

    // Old and not accessed recently
    if (ageDays > threshold && daysSinceLastAccess > this.LAST_ACCESS_THRESHOLD_DAYS) {
      return true;
    }

    return false;
  }

  /**
   * Calculate days between two dates
   */
  private daysBetween(start: Date, end: Date): number {
    const msPerDay = 1000 * 60 * 60 * 24;
    return Math.floor((end.getTime() - start.getTime()) / msPerDay);
  }
}
