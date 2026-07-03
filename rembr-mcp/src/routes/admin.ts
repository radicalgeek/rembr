/**
 * Admin route handlers for the Rembr MCP server.
 *
 * Extracted from index-http.ts as part of the monolith refactor (REM-262).
 * These endpoints are operationally-focused (optimization, embeddings, backfill)
 * and have no dependency on MCP session state, making them a clean first module.
 *
 * Mount with: app.use('/admin', createAdminRouter(deps))
 */

import { Router, Request, Response } from 'express';
import { MemoryDatabase } from '../database.js';
import { OptimizationScheduler } from '../optimization/scheduler.js';
import { MemoryRelationshipService } from '../memory-relationship-service.js';
import { EmbeddingProvider } from '../ollama-provider.js';
import { VectorSearchService } from '../vector-search-service.js';

export interface AdminRouterDeps {
  db: MemoryDatabase;
  optimizationScheduler?: OptimizationScheduler;
  embeddingProvider?: EmbeddingProvider;
  /** pg Pool, used by VectorSearchService for index health checks */
  pool?: import('pg').Pool;
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  const { db, optimizationScheduler, embeddingProvider, pool } = deps;

  // POST /admin/optimize/:tenantId? — trigger optimization manually
  router.post('/optimize/:tenantId?', async (req: Request, res: Response) => {
    try {
      if (!optimizationScheduler) {
        return res.status(503).json({ error: 'Optimization scheduler not enabled' });
      }

      const { tenantId } = req.params;

      if (tenantId) {
        console.log(`[Admin] Manual optimization triggered for tenant: ${tenantId}`);
        await (optimizationScheduler as any).optimizeTenant(tenantId);
        res.json({
          status: 'success',
          message: `Optimization completed for tenant ${tenantId}`,
          timestamp: new Date().toISOString()
        });
      } else {
        console.log('[Admin] Manual optimization cycle triggered');
        await (optimizationScheduler as any).runOptimizationCycle();
        const status = optimizationScheduler.getStatus();
        res.json({
          status: 'success',
          message: 'Optimization cycle completed',
          schedulerStatus: status,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('[Admin] Optimization trigger failed:', error);
      res.status(500).json({
        error: 'Optimization failed',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // GET /admin/optimize/status — scheduler status
  router.get('/optimize/status', (_req: Request, res: Response) => {
    if (!optimizationScheduler) {
      return res.status(503).json({ error: 'Optimization scheduler not enabled' });
    }
    res.json(optimizationScheduler.getStatus());
  });

  // POST /admin/embeddings/:tenantId — bulk generate embeddings for memories lacking them
  router.post('/embeddings/:tenantId', async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    try {
      if (!embeddingProvider) {
        return res.status(503).json({ error: 'Embedding provider not configured' });
      }
      console.log(`[Admin] Generating embeddings for tenant ${tenantId}`);

      const result = await db.query(
        `SELECT m.id, m.content
         FROM memories m
         LEFT JOIN memory_embeddings me ON m.id = me.memory_id
         WHERE m.tenant_id = $1 AND me.memory_id IS NULL
         ORDER BY m.created_at DESC
         LIMIT 100`,
        [tenantId]
      );

      let generated = 0;
      let failed = 0;

      for (const row of result.rows) {
        try {
          const embedding = await embeddingProvider.generateEmbedding(row.content);
          await db.storeEmbedding(
            row.id,
            tenantId,
            embedding,
            embeddingProvider.name,
            embeddingProvider.model,
            embeddingProvider.getModelFingerprint()
          );
          generated++;
        } catch (err) {
          console.error(`[Admin] Embedding failed for memory ${row.id}:`, err);
          failed++;
        }
      }

      res.json({
        status: 'success',
        message: `Generated ${generated} embeddings`,
        generated,
        failed,
        total: result.rows.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[Admin] Embedding generation failed:', error);
      res.status(500).json({
        error: 'Embedding generation failed',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // POST /admin/backfill-relationships/:tenantId — idempotent relationship backfill (REM-270)
  // Body (all optional): { batch_size, min_confidence, cursor, dry_run }
  // Returns: { processed, added, skipped_no_embedding, next_cursor, done }
  // Safe to call repeatedly — already-processed memories are skipped.
  router.post('/backfill-relationships/:tenantId', async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    try {
      if (!embeddingProvider) {
        return res.status(503).json({ error: 'Embedding provider not available — cannot infer relationships' });
      }

      const svc = new MemoryRelationshipService(db, embeddingProvider);
      const { batch_size, min_confidence, cursor, dry_run } = req.body || {};

      console.log(`[Admin] Starting relationship backfill for tenant ${tenantId}`, {
        batch_size, min_confidence, cursor, dry_run
      });

      const result = await svc.backfillRelationships(tenantId, {
        batchSize: batch_size,
        minConfidence: min_confidence,
        cursor,
        dryRun: dry_run
      });

      console.log(`[Admin] Backfill complete for tenant ${tenantId}:`, result);
      res.json({ success: true, tenant_id: tenantId, ...result });
    } catch (error) {
      console.error('[Admin] Backfill error:', error);
      res.status(500).json({ error: 'Backfill failed', detail: (error as Error).message });
    }
  });

  // POST /admin/compact/:tenantId — trigger memory compaction (REM-88)
  router.post('/compact/:tenantId', async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.tenantId as string;
      const { target_limit, similarity_threshold, max_group_size, dry_run, priority_strategy } = req.body || {};

      console.log(`[Admin] Compaction request for tenant ${tenantId}:`, {
        target_limit, similarity_threshold, max_group_size, dry_run, priority_strategy
      });

      // Import compaction service dynamically
      const { compactMemories, getPlanMemoryLimit, isCompactionNeeded } = await import('../optimization/compaction-service.js');

      // If no target_limit provided, use plan limit
      let targetLimit = target_limit;
      if (!targetLimit) {
        const planLimit = await getPlanMemoryLimit(db.dbPool, tenantId);
        if (planLimit === null) {
          return res.status(400).json({ 
            error: 'No target_limit provided and no plan limit found for tenant' 
          });
        }
        targetLimit = planLimit;
      }

      // Check if compaction is needed
      const { needed, currentCount, limit } = await isCompactionNeeded(db.dbPool, tenantId);
      
      if (!needed && !dry_run) {
        return res.json({
          success: true,
          message: 'Compaction not needed',
          current_count: currentCount,
          limit: limit || targetLimit,
        });
      }

      // Perform compaction
      const result = await compactMemories(db.dbPool, tenantId, targetLimit, {
        similarity_threshold,
        max_group_size,
        dry_run,
        priority_strategy,
      });

      console.log(`[Admin] Compaction complete for tenant ${tenantId}:`, {
        initial: result.initial_count,
        final: result.final_count,
        merged_groups: result.merged_groups.length,
      });

      res.json(result);
    } catch (error) {
      console.error('[Admin] Compaction error:', error);
      res.status(500).json({ error: 'Compaction failed', detail: (error as Error).message });
    }
  });

  // GET /admin/vector-index-health
  // Versioned alias: GET /api/v1/admin/vector-index-health  (mounted via app.use('/admin'))
  //
  // Returns HNSW index health for the two primary embedding indexes.
  // Response shape (IndexHealthReport[]):
  //
  //   [{
  //     indexName: string,           // "idx_memories_embedding" | "idx_embeddings_vector"
  //     tableName: string,           // "memories" | "memory_embeddings"
  //     rowCount: number,            // pg row estimate
  //     indexSizeBytes: number,
  //     tableSizeBytes: number,
  //     bloatRatio: number,          // 0.0–1.0
  //     efSearchRecommended: number, // 40 | 64 | 100 | 128
  //     lastVacuumAt: string | null, // ISO timestamp or null if never run
  //     lastAnalyzeAt: string | null,
  //     advice: string[]             // human-readable remediation steps
  //   }]
  //
  // Used by the admin UI to surface index health, ef_search scale advice,
  // bloat ratio, and vacuum/analyze staleness warnings.
  router.get('/vector-index-health', async (req: Request, res: Response) => {
    if (!pool) {
      return res.status(503).json({ error: 'Database pool not available' });
    }
    try {
      const svc = new VectorSearchService(pool);
      const reports = await svc.indexHealth();
      res.json({
        schema_version: '1',
        generated_at: new Date().toISOString(),
        indexes: reports,
      });
    } catch (error) {
      console.error('[Admin] vector-index-health error:', error);
      res.status(500).json({ error: 'Failed to retrieve index health', detail: (error as Error).message });
    }
  });

  return router;
}
