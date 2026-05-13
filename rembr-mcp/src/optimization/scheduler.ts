import { MemoryDatabase } from '../database.js';
import { DeduplicationService } from './deduplication-service.js';
import { TemporalAnalyzerService } from './temporal-analyzer-service.js';
import { RelationshipMaintainerService } from './relationship-maintainer-service.js';
import { QualityScorerService } from './quality-scorer-service.js';
import { OllamaClient } from '../ollama-client.js';
import { trackOptimization, trackOptimizationCycle } from '../metrics.js';

/**
 * Tenant with optimization plan
 */
interface TenantPlan {
  tenantId: string;
  planName: string;
  optimizationInterval: number; // hours
  lastOptimized?: Date;
}

/**
 * OptimizationScheduler - Background job that runs auto-optimization for tenants
 * 
 * Responsibilities:
 * - Run optimization cycles on a schedule
 * - Process tenants in batches based on their plan
 * - Track last optimization time
 * - Graceful shutdown support
 * 
 * Algorithm:
 * 1. Every N minutes, check which tenants need optimization
 * 2. Select tenants where: NOW - last_optimized > plan.optimizationInterval
 * 3. Process up to MAX_TENANTS_PER_CYCLE tenants
 * 4. For each tenant:
 *    a. Run deduplication
 *    b. Run temporal analysis
 *    c. Run relationship maintenance
 *    d. Calculate quality scores
 *    e. Update last_optimized timestamp
 */
export class OptimizationScheduler {
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  private readonly CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_TENANTS_PER_CYCLE = 10;

  constructor(
    private db: MemoryDatabase,
    private deduplicationService: DeduplicationService,
    private temporalService: TemporalAnalyzerService,
    private relationshipService: RelationshipMaintainerService,
    private qualityService: QualityScorerService
  ) {}

  /**
   * Start the optimization scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[OptimizationScheduler] Already running');
      return;
    }

    console.log(`[OptimizationScheduler] Starting (check interval: ${this.CHECK_INTERVAL_MS}ms)`);
    this.isRunning = true;

    // Wait 30 seconds before first cycle to let database pool fully initialize
    console.log('[OptimizationScheduler] Waiting 30s for database pool initialization...');
    setTimeout(async () => {
      await this.runCycle();
    }, 30000);

    // Then schedule periodic runs
    this.intervalId = setInterval(async () => {
      await this.runCycle();
    }, this.CHECK_INTERVAL_MS);
  }

  /**
   * Stop the optimization scheduler
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('[OptimizationScheduler] Stopping...');
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    this.isRunning = false;
    console.log('[OptimizationScheduler] Stopped');
  }

  /**
   * Process next batch of tenants that need optimization
   */
  async processNextTenant(): Promise<{ processed: number; skipped: number }> {
    const tenantsNeedingOptimization = await this.getTenantsNeedingOptimization();

    if (tenantsNeedingOptimization.length === 0) {
      return { processed: 0, skipped: 0 };
    }

    // Take first tenant
    const tenant = tenantsNeedingOptimization[0];
    
    try {
      await this.optimizeTenant(tenant.tenantId);
      return { processed: 1, skipped: 0 };
    } catch (error) {
      console.error(`[OptimizationScheduler] Failed to optimize tenant ${tenant.tenantId}:`, error);
      return { processed: 0, skipped: 1 };
    }
  }

  /**
   * Run one optimization cycle
   */
  private async runCycle(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('[OptimizationScheduler] Running optimization cycle');
    const startTime = Date.now();

    try {
      const tenants = await this.getTenantsNeedingOptimization();
      const tenantsToProcess = tenants.slice(0, this.MAX_TENANTS_PER_CYCLE);

      console.log(`[OptimizationScheduler] Found ${tenants.length} tenants needing optimization, processing ${tenantsToProcess.length}`);

      let processed = 0;
      let failed = 0;

      for (const tenant of tenantsToProcess) {
        try {
          await this.optimizeTenant(tenant.tenantId);
          processed++;
        } catch (error) {
          console.error(`[OptimizationScheduler] Failed to optimize tenant ${tenant.tenantId}:`, error);
          failed++;
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[OptimizationScheduler] Cycle complete: ${processed} processed, ${failed} failed, ${duration}ms`);
      
      trackOptimizationCycle(failed === 0 ? 'success' : 'error');
    } catch (error) {
      console.error('[OptimizationScheduler] Cycle failed:', error);
      trackOptimizationCycle('error');
    }
  }

  /**
   * Get tenants that need optimization based on their plan schedule
   */
  private async getTenantsNeedingOptimization(): Promise<TenantPlan[]> {
    // Get all tenants with their plans and check optimization_config
    const result = await this.db.query(`
      SELECT 
        t.id as tenant_id,
        t.plan,
        oc.enabled as optimization_enabled,
        oc.schedule_frequency,
        oc.last_run_at
      FROM tenants t
      LEFT JOIN optimization_config oc ON t.id = oc.tenant_id
      WHERE t.status = 'active'
      ORDER BY COALESCE(oc.last_run_at, '1970-01-01'::timestamp) ASC
      LIMIT $1
    `, [this.MAX_TENANTS_PER_CYCLE * 2]); // Fetch more than we need in case some fail

    const now = new Date();
    const needsOptimization: TenantPlan[] = [];

    for (const row of result.rows) {
      // Check if optimization is enabled (defaults to true if no config)
      if (row.optimization_enabled === false) {
        continue;
      }

      // Determine interval based on plan
      const intervalHours = this.getIntervalForPlan(row.plan, row.schedule_frequency);
      if (intervalHours === null) {
        continue; // Optimization disabled for this plan
      }

      // Check if enough time has passed since last run
      if (row.last_run_at) {
        const hoursSinceLastRun = (now.getTime() - new Date(row.last_run_at).getTime()) / (1000 * 60 * 60);
        if (hoursSinceLastRun < intervalHours) {
          continue; // Too soon
        }
      }

      needsOptimization.push({
        tenantId: row.tenant_id,
        planName: row.plan,
        optimizationInterval: intervalHours,
        lastOptimized: row.last_run_at ? new Date(row.last_run_at) : undefined
      });
    }

    return needsOptimization;
  }

  /**
   * Get optimization interval in hours for a plan
   */
  private getIntervalForPlan(plan: string, frequency?: string): number | null {
    // If explicit frequency is set, use it
    if (frequency) {
      switch (frequency) {
        case 'hourly': return 1;
        case 'daily': return 24;
        case 'weekly': return 168;
        case 'monthly': return 720;
        default: break;
      }
    }

    // Default intervals by plan (as per architecture doc)
    switch (plan) {
      case 'free':
        return null; // Disabled
      case 'pro':
        return 24; // Daily
      case 'team':
        return 12; // Every 12 hours
      case 'business':
        return 6; // Every 6 hours
      case 'enterprise':
        return 6; // Every 6 hours
      default:
        return 24; // Default to daily
    }
  }

  /**
   * Run full optimization for a single tenant
   */
  private async optimizeTenant(tenantId: string): Promise<void> {
    console.log(`[OptimizationScheduler] Optimizing tenant ${tenantId}`);
    const startTime = Date.now();

    try {
      // 1. Deduplication
      console.log(`[OptimizationScheduler] ${tenantId}: Running deduplication...`);
      const dedupStart = Date.now();
      const dedupClusters = await this.deduplicationService.findDuplicateClusters(tenantId, 0.85);
      let mergedCount = 0;
      for (const cluster of dedupClusters) {
        await this.deduplicationService.mergeDuplicates(cluster, tenantId);
        mergedCount += cluster.memories.length - 1; // -1 because we keep one
      }
      trackOptimization('deduplication', tenantId, (Date.now() - dedupStart) / 1000, {
        duplicatesFound: mergedCount
      });

      // 2. Temporal analysis
      console.log(`[OptimizationScheduler] ${tenantId}: Running temporal analysis...`);
      const temporalStart = Date.now();
      const freshness = await this.temporalService.analyzeMemoryFreshness(tenantId);
      const outdatedIds = freshness
        .filter(f => f.isOutdated)
        .map(f => f.memoryId);
      if (outdatedIds.length > 0) {
        await this.temporalService.markOutdated(outdatedIds, tenantId);
      }
      trackOptimization('temporal', tenantId, (Date.now() - temporalStart) / 1000, {
        outdatedMemories: outdatedIds.length
      });

      // 3. Relationship maintenance
      console.log(`[OptimizationScheduler] ${tenantId}: Maintaining relationships...`);
      const relStart = Date.now();
      const newRelationships = await this.relationshipService.inferRelationships(tenantId, 0.7);
      if (newRelationships.length > 0) {
        await this.relationshipService.createRelationships(newRelationships, tenantId);
      }
      await this.relationshipService.updateWeights(tenantId);
      await this.relationshipService.pruneWeak(tenantId, 0.5);
      trackOptimization('relationships', tenantId, (Date.now() - relStart) / 1000, {
        relationshipsInferred: newRelationships.length,
        relationshipType: 'semantic_similarity'
      });

      // 4. Contradiction detection
      console.log(`[OptimizationScheduler] ${tenantId}: Detecting contradictions...`);
      const contradictionStart = Date.now();
      const recentMemories = await this.db.query(
        `SELECT id FROM memories 
         WHERE tenant_id = $1 
         AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT 500`,
        [tenantId]
      );
      
      if (recentMemories.rows.length > 1) {
        const compilationService = await import('../compilation-service.js').then(m => m.CompilationService);
        const service = new compilationService(this.db);
        const memoryIds = recentMemories.rows.map((r: any) => r.id);
        
        // Extract relationships (includes contradiction detection)
        const detected = await service.extractRelationships(
          memoryIds,
          { tenant_id: tenantId, project_id: undefined }
        );
        
        const contradictions = detected.filter(r => r.relationship_type === 'contradicts');
        trackOptimization('contradictions', tenantId, (Date.now() - contradictionStart) / 1000, {
          contradictionsDetected: contradictions.length,
          memoriesScanned: memoryIds.length
        });
      }

      // 5. Update last optimized timestamp in optimization_config
      await this.db.query(`
        INSERT INTO optimization_config (tenant_id, last_run_at, updated_at)
        VALUES ($1, NOW(), NOW())
        ON CONFLICT (tenant_id)
        DO UPDATE SET last_run_at = NOW(), updated_at = NOW()
      `, [tenantId]);

      // 6. Calculate and store quality score
      console.log(`[OptimizationScheduler] ${tenantId}: Calculating quality score...`);
      const qualityMetrics = await this.qualityService.calculateQualityScore(tenantId);
      await this.qualityService.storeMetrics(qualityMetrics);

      const duration = Date.now() - startTime;
      console.log(`[OptimizationScheduler] ${tenantId}: Optimization complete in ${duration}ms`);
    } catch (error) {
      console.error(`[OptimizationScheduler] ${tenantId}: Optimization failed:`, error);
      throw error;
    }
  }

  /**
   * Get current scheduler status
   */
  getStatus(): { running: boolean; checkIntervalMs: number; maxTenantsPerCycle: number } {
    return {
      running: this.isRunning,
      checkIntervalMs: this.CHECK_INTERVAL_MS,
      maxTenantsPerCycle: this.MAX_TENANTS_PER_CYCLE
    };
  }
}
