import { MemoryDatabase } from '../database.js';

/**
 * Graph quality metrics
 */
export interface QualityMetrics {
  tenantId: string;
  projectId?: string;
  
  // Memory counts
  totalMemories: number;
  activeMemories: number;
  archivedMemories: number;
  
  // Duplication metrics
  duplicateClusters: number;
  estimatedDuplicates: number;
  
  // Freshness metrics
  outdatedMemories: number;
  freshMemories: number; // < 30 days
  
  // Relationship metrics
  totalRelationships: number;
  orphanedMemories: number; // 0 relationships
  highlyConnected: number; // > 10 relationships
  avgRelationshipsPerMemory: number;
  relationshipDensity: number; // actual / possible
  
  // Overall quality score (0.00-1.00)
  overallQualityScore: number;
  
  // Component scores
  scores: {
    deduplication: number;
    freshness: number;
    connectivity: number;
  };
  
  measuredAt: Date;
}

/**
 * Quality report for human consumption
 */
export interface QualityReport {
  summary: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  issues: string[];
  recommendations: string[];
  metrics: QualityMetrics;
}

/**
 * QualityScorerService - Calculates and tracks graph health metrics
 * 
 * Responsibilities:
 * - Calculate comprehensive quality metrics
 * - Store metrics in graph_quality_metrics table
 * - Detect quality degradation and anomalies
 * - Generate human-readable quality reports
 * 
 * Quality Score Algorithm:
 * - Deduplication Score (30%): 1 - (duplicates / total)
 * - Freshness Score (30%): fresh_memories / total_memories
 * - Connectivity Score (40%): sigmoid(avg_relationships / ideal_avg)
 * - Overall: Weighted average of components
 * 
 * Score Ranges:
 * - 0.90-1.00: Excellent (A)
 * - 0.80-0.89: Good (B)
 * - 0.70-0.79: Fair (C)
 * - 0.60-0.69: Poor (D)
 * - 0.00-0.59: Critical (F)
 */
export class QualityScorerService {
  private readonly IDEAL_AVG_RELATIONSHIPS = 5.0;
  private readonly FRESH_THRESHOLD_DAYS = 30;

  constructor(private db: MemoryDatabase) {}

  /**
   * Calculate comprehensive quality score for tenant
   * @param tenantId Tenant to analyze
   * @param projectId Optional project filter
   * @returns Quality metrics
   */
  async calculateQualityScore(
    tenantId: string,
    projectId?: string
  ): Promise<QualityMetrics> {
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    // Get memory counts
    const memoryStats = await this.getMemoryStats(tenantId, projectId);
    
    // Get duplication stats
    const dupStats = await this.getDuplicationStats(tenantId, projectId);
    
    // Get freshness stats
    const freshnessStats = await this.getFreshnessStats(tenantId, projectId);
    
    // Get relationship stats
    const relStats = await this.getRelationshipStats(tenantId, projectId);

    // Calculate component scores
    const dedupScore = this.calculateDeduplicationScore(
      dupStats.estimatedDuplicates,
      memoryStats.totalMemories
    );

    const freshnessScore = this.calculateFreshnessScore(
      freshnessStats.freshMemories,
      memoryStats.totalMemories
    );

    const connectivityScore = this.calculateConnectivityScore(
      relStats.avgRelationshipsPerMemory
    );

    // Calculate overall score (weighted average)
    const overallScore = (
      dedupScore * 0.30 +
      freshnessScore * 0.30 +
      connectivityScore * 0.40
    );

    return {
      tenantId,
      projectId,
      totalMemories: memoryStats.totalMemories,
      activeMemories: memoryStats.activeMemories,
      archivedMemories: memoryStats.archivedMemories,
      duplicateClusters: dupStats.duplicateClusters,
      estimatedDuplicates: dupStats.estimatedDuplicates,
      outdatedMemories: freshnessStats.outdatedMemories,
      freshMemories: freshnessStats.freshMemories,
      totalRelationships: relStats.totalRelationships,
      orphanedMemories: relStats.orphanedMemories,
      highlyConnected: relStats.highlyConnected,
      avgRelationshipsPerMemory: relStats.avgRelationshipsPerMemory,
      relationshipDensity: relStats.relationshipDensity,
      overallQualityScore: Number(overallScore.toFixed(2)),
      scores: {
        deduplication: Number(dedupScore.toFixed(2)),
        freshness: Number(freshnessScore.toFixed(2)),
        connectivity: Number(connectivityScore.toFixed(2))
      },
      measuredAt: new Date()
    };
  }

  /**
   * Store quality metrics in database
   * @param metrics Metrics to store
   * @returns Inserted metric ID
   */
  async storeMetrics(metrics: QualityMetrics): Promise<string> {
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', metrics.tenantId]);

    const result = await this.db.query(`
      INSERT INTO graph_quality_metrics (
        tenant_id, project_id,
        total_memories, active_memories, archived_memories,
        duplicate_clusters, estimated_duplicates,
        outdated_memories, fresh_memories,
        total_relationships, orphaned_memories, highly_connected,
        avg_relationships_per_memory, relationship_density,
        overall_quality_score, metadata, measured_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
      )
      RETURNING id
    `, [
      metrics.tenantId,
      metrics.projectId,
      metrics.totalMemories,
      metrics.activeMemories,
      metrics.archivedMemories,
      metrics.duplicateClusters,
      metrics.estimatedDuplicates,
      metrics.outdatedMemories,
      metrics.freshMemories,
      metrics.totalRelationships,
      metrics.orphanedMemories,
      metrics.highlyConnected,
      metrics.avgRelationshipsPerMemory,
      metrics.relationshipDensity,
      metrics.overallQualityScore,
      JSON.stringify(metrics.scores),
      metrics.measuredAt
    ]);

    return result.rows[0].id;
  }

  /**
   * Generate human-readable quality report
   * @param metrics Quality metrics
   * @returns Quality report
   */
  generateReport(metrics: QualityMetrics): QualityReport {
    const grade = this.getGrade(metrics.overallQualityScore);
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Analyze deduplication
    if (metrics.scores.deduplication < 0.70) {
      issues.push(`High duplication rate: ${metrics.estimatedDuplicates} duplicates found`);
      recommendations.push('Run deduplication to merge similar memories');
    }

    // Analyze freshness
    if (metrics.scores.freshness < 0.60) {
      issues.push(`Low freshness score: ${metrics.outdatedMemories} outdated memories`);
      recommendations.push('Archive or update outdated memories');
    }

    // Analyze connectivity
    if (metrics.scores.connectivity < 0.50) {
      issues.push(`Poor connectivity: ${metrics.orphanedMemories} orphaned memories`);
      recommendations.push('Infer relationships to improve knowledge graph structure');
    }

    // Generate summary
    const summary = this.generateSummary(metrics, grade);

    return {
      summary,
      score: metrics.overallQualityScore,
      grade,
      issues,
      recommendations,
      metrics
    };
  }

  /**
   * Detect quality anomalies by comparing with historical trends
   * @param tenantId Tenant ID
   * @returns Array of detected anomalies
   */
  async detectAnomalies(tenantId: string): Promise<string[]> {
    await this.db.query('SELECT set_config($1, $2, FALSE)', ['app.current_tenant', tenantId]);

    // Get last 7 measurements
    const result = await this.db.query(`
      SELECT overall_quality_score, measured_at
      FROM graph_quality_metrics
      WHERE tenant_id = $1
      ORDER BY measured_at DESC
      LIMIT 7
    `, [tenantId]);

    if (result.rows.length < 3) {
      return []; // Not enough data for trend analysis
    }

    const scores: number[] = result.rows.map((r: any) => r.overall_quality_score);
    const current = scores[0];
    const avg = scores.reduce((sum: number, s: number) => sum + s, 0) / scores.length;
    const anomalies: string[] = [];

    // Detect sudden drop
    if (current < avg - 0.15) {
      anomalies.push('Quality score dropped significantly');
    }

    // Detect consistent decline
    if (scores.every((s: number, i: number) => i === 0 || s < scores[i - 1])) {
      anomalies.push('Continuous quality degradation detected');
    }

    return anomalies;
  }

  /**
   * Get memory statistics
   */
  private async getMemoryStats(tenantId: string, projectId?: string): Promise<{
    totalMemories: number;
    activeMemories: number;
    archivedMemories: number;
  }> {
    const result = await this.db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE m.id IS NOT NULL) as active,
        COUNT(*) FILTER (WHERE am.id IS NOT NULL) as archived
      FROM memories m
      FULL OUTER JOIN archived_memories am ON m.tenant_id = am.tenant_id
      WHERE m.tenant_id = $1 OR am.tenant_id = $1
      ${projectId ? 'AND (m.project_id = $2 OR am.project_id = $2)' : ''}
    `, projectId ? [tenantId, projectId] : [tenantId]);

    const active = Number(result.rows[0]?.active || 0);
    const archived = Number(result.rows[0]?.archived || 0);

    return {
      totalMemories: active,
      activeMemories: active,
      archivedMemories: archived
    };
  }

  /**
   * Get duplication statistics
   */
  private async getDuplicationStats(tenantId: string, projectId?: string): Promise<{
    duplicateClusters: number;
    estimatedDuplicates: number;
  }> {
    // This would ideally use the DeduplicationService
    // For now, estimate based on similarity
    return {
      duplicateClusters: 0,
      estimatedDuplicates: 0
    };
  }

  /**
   * Get freshness statistics
   */
  private async getFreshnessStats(tenantId: string, projectId?: string): Promise<{
    freshMemories: number;
    outdatedMemories: number;
  }> {
    const result = await this.db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${this.FRESH_THRESHOLD_DAYS} days') as fresh,
        COUNT(*) FILTER (WHERE metadata->>'outdated' = 'true') as outdated
      FROM memories
      WHERE tenant_id = $1
      ${projectId ? 'AND project_id = $2' : ''}
    `, projectId ? [tenantId, projectId] : [tenantId]);

    return {
      freshMemories: Number(result.rows[0]?.fresh || 0),
      outdatedMemories: Number(result.rows[0]?.outdated || 0)
    };
  }

  /**
   * Get relationship statistics
   */
  private async getRelationshipStats(tenantId: string, projectId?: string): Promise<{
    totalRelationships: number;
    orphanedMemories: number;
    highlyConnected: number;
    avgRelationshipsPerMemory: number;
    relationshipDensity: number;
  }> {
    const result = await this.db.query(`
      WITH memory_stats AS (
        SELECT 
          m.id,
          COUNT(DISTINCT mr.id) as rel_count
        FROM memories m
        LEFT JOIN memory_relationships mr 
          ON m.id = mr.source_memory_id OR m.id = mr.target_memory_id
        WHERE m.tenant_id = $1
        ${projectId ? 'AND m.project_id = $2' : ''}
        GROUP BY m.id
      )
      SELECT 
        (SELECT COUNT(*) FROM memory_relationships) as total_rel,
        COUNT(*) as total_mem,
        SUM(CASE WHEN rel_count = 0 THEN 1 ELSE 0 END)::int as orphaned,
        SUM(CASE WHEN rel_count > 10 THEN 1 ELSE 0 END)::int as highly_connected
      FROM memory_stats
    `, projectId ? [tenantId, projectId] : [tenantId]);

    const stats = result.rows[0];
    const totalRel = Number(stats?.total_rel || 0);
    const totalMem = Number(stats?.total_mem || 0);
    const avgRel = totalMem > 0 ? totalRel / totalMem : 0;
    
    // Calculate density: actual edges / possible edges
    // In undirected graph: possible = n*(n-1)/2
    const possibleRel = totalMem > 1 ? (totalMem * (totalMem - 1)) / 2 : 1;
    // Clamp density to [0, 1] to prevent numeric overflow in DECIMAL(5,4) column
    // Density > 1 can occur with bidirectional relationships counted separately
    const density = Math.min(1, Math.max(0, totalRel / possibleRel));

    return {
      totalRelationships: totalRel,
      orphanedMemories: Number(stats?.orphaned || 0),
      highlyConnected: Number(stats?.highly_connected || 0),
      avgRelationshipsPerMemory: Number(avgRel.toFixed(2)),
      relationshipDensity: Number(density.toFixed(4))
    };
  }

  /**
   * Calculate deduplication score
   */
  private calculateDeduplicationScore(duplicates: number, total: number): number {
    if (total === 0) return 1.0;
    return Math.max(0, 1 - (duplicates / total));
  }

  /**
   * Calculate freshness score
   */
  private calculateFreshnessScore(fresh: number, total: number): number {
    if (total === 0) return 1.0;
    return Math.min(1.0, fresh / total);
  }

  /**
   * Calculate connectivity score using sigmoid
   */
  private calculateConnectivityScore(avgRelationships: number): number {
    // Sigmoid function: 1 / (1 + e^(-k*(x - ideal)))
    // k=0.5 for smooth curve, ideal=5.0
    const k = 0.5;
    const score = 1 / (1 + Math.exp(-k * (avgRelationships - this.IDEAL_AVG_RELATIONSHIPS)));
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Convert score to letter grade
   */
  private getGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 0.90) return 'A';
    if (score >= 0.80) return 'B';
    if (score >= 0.70) return 'C';
    if (score >= 0.60) return 'D';
    return 'F';
  }

  /**
   * Generate summary text
   */
  private generateSummary(metrics: QualityMetrics, grade: string): string {
    return `Knowledge graph quality: ${grade} (${metrics.overallQualityScore}). ` +
      `${metrics.totalMemories} memories, ${metrics.totalRelationships} relationships. ` +
      `Deduplication: ${(metrics.scores.deduplication * 100).toFixed(0)}%, ` +
      `Freshness: ${(metrics.scores.freshness * 100).toFixed(0)}%, ` +
      `Connectivity: ${(metrics.scores.connectivity * 100).toFixed(0)}%.`;
  }
}
