import { MemoryDatabase } from './database.js';
import { MemoryMaintenanceService } from './memory-maintenance-service.js';
import {
  EmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider
} from './ollama-provider.js';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EMBEDDING_PROVIDER || 'ollama';
  const model = process.env.EMBEDDING_MODEL || process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
  const dimensions = parsePositiveInt(process.env.EMBEDDING_DIMENSIONS, 768);

  if (provider === 'openai-compatible') {
    const baseUrl = process.env.EMBEDDING_BASE_URL || process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1';
    return new OpenAICompatibleEmbeddingProvider(baseUrl, model, dimensions);
  }

  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  return OllamaEmbeddingProvider.createDefault(ollamaHost);
}

class MaintenanceWorker {
  private readonly db = new MemoryDatabase();
  private readonly embeddingProvider = createEmbeddingProvider();
  private readonly service = new MemoryMaintenanceService(
    this.db,
    process.env.MAINTENANCE_WORKER_ID || `rembr-maintenance-${process.pid}`,
    this.embeddingProvider
  );
  private readonly intervalMs = parsePositiveInt(process.env.MAINTENANCE_INTERVAL_MS, 60_000);
  private readonly enqueueLimit = parsePositiveInt(process.env.MAINTENANCE_ENQUEUE_LIMIT, 500);
  private readonly batchSize = parsePositiveInt(process.env.MAINTENANCE_EMBEDDING_BATCH_SIZE, 10);
  private readonly relationshipBatchSize = parsePositiveInt(process.env.MAINTENANCE_RELATIONSHIP_BATCH_SIZE, 10);
  private readonly contradictionBatchSize = parsePositiveInt(process.env.MAINTENANCE_CONTRADICTION_BATCH_SIZE, 3);
  private readonly evolutionBatchSize = parsePositiveInt(process.env.MAINTENANCE_EVOLUTION_BATCH_SIZE, 2);
  private readonly cleanupBatchSize = parsePositiveInt(process.env.MAINTENANCE_CLEANUP_BATCH_SIZE, 10);
  private readonly relationshipMinConfidence = Number.parseFloat(process.env.MAINTENANCE_RELATIONSHIP_MIN_CONFIDENCE || '0.65');
  private readonly contradictionMinConfidence = Number.parseFloat(process.env.MAINTENANCE_CONTRADICTION_MIN_CONFIDENCE || '0.7');
  private readonly evolutionMinConfidence = Number.parseFloat(process.env.MAINTENANCE_EVOLUTION_MIN_CONFIDENCE || '0.85');
  private running = false;
  private stopping = false;
  private interval?: NodeJS.Timeout;

  async start(): Promise<void> {
    console.log('[MaintenanceWorker] Starting', {
      intervalMs: this.intervalMs,
      enqueueLimit: this.enqueueLimit,
      batchSize: this.batchSize,
      relationshipBatchSize: this.relationshipBatchSize,
      contradictionBatchSize: this.contradictionBatchSize,
      evolutionBatchSize: this.evolutionBatchSize,
      cleanupBatchSize: this.cleanupBatchSize,
      embeddingProvider: this.embeddingProvider.name,
      embeddingModel: this.embeddingProvider.model
    });

    this.interval = setInterval(() => {
      this.runCycle().catch(error => {
        console.error('[MaintenanceWorker] Cycle failed:', error);
      });
    }, this.intervalMs);

    await this.runCycle().catch(error => {
      console.error('[MaintenanceWorker] Initial cycle failed:', error);
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    await this.db.close();
    console.log('[MaintenanceWorker] Stopped');
  }

  private async runCycle(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;

    const runId = await this.service.startRun('full_cycle', {
      batchSize: this.batchSize,
      relationshipBatchSize: this.relationshipBatchSize,
      contradictionBatchSize: this.contradictionBatchSize,
      cleanupBatchSize: this.cleanupBatchSize,
      evolutionBatchSize: this.evolutionBatchSize,
      enqueueLimit: this.enqueueLimit
    });

    try {
      const tenants = await this.service.listActiveTenants();
      const tenantHealth: Record<string, unknown> = {};
      let jobsCreated = 0;
      let jobsSucceeded = 0;
      let jobsFailed = 0;
      let memoriesProcessed = 0;
      let relationshipsAdded = 0;
      let contradictionsAdded = 0;
      let memoriesEvolved = 0;
      let memoriesPruned = 0;
      let cleanupActions = 0;

      for (const tenant of tenants) {
        const missing = await this.service.enqueueMissingEmbeddingJobs(tenant.tenant_id, this.enqueueLimit);
        const stale = await this.service.enqueueStaleEmbeddingJobs(tenant.tenant_id, this.enqueueLimit);
        const relationships = await this.service.enqueueRelationshipInferenceJobs(tenant.tenant_id, this.enqueueLimit);
        const contradictions = await this.service.enqueueContradictionDetectionJobs(tenant.tenant_id, this.enqueueLimit);
        const evolution = await this.service.enqueueMemoryEvolutionJobs(tenant.tenant_id, this.enqueueLimit);
        const cleanup = await this.service.enqueueExpiredMemoryCleanupJobs(tenant.tenant_id, this.enqueueLimit);
        const processedMissing = await this.service.processEmbeddingBackfillBatch(tenant.tenant_id, this.batchSize);
        const processedStale = await this.service.processStaleEmbeddingBatch(tenant.tenant_id, this.batchSize);
        const processedRelationships = await this.service.processRelationshipInferenceBatch(
          tenant.tenant_id,
          this.relationshipBatchSize,
          this.relationshipMinConfidence
        );
        const processedContradictions = await this.service.processContradictionDetectionBatch(
          tenant.tenant_id,
          this.contradictionBatchSize,
          this.contradictionMinConfidence
        );
        const processedEvolution = await this.service.processMemoryEvolutionBatch(
          tenant.tenant_id,
          this.evolutionBatchSize,
          this.evolutionMinConfidence
        );
        const processedCleanup = await this.service.processCleanupBatch(tenant.tenant_id, this.cleanupBatchSize);
        const health = await this.service.getHealth(tenant.tenant_id);

        jobsCreated += missing.created + stale.created + relationships.created + contradictions.created + evolution.created + cleanup.created;
        jobsSucceeded += processedMissing.succeeded + processedStale.succeeded +
          processedRelationships.succeeded + processedContradictions.succeeded + processedEvolution.succeeded + processedCleanup.succeeded;
        jobsFailed += processedMissing.failed + processedStale.failed +
          processedRelationships.failed + processedContradictions.failed + processedEvolution.failed + processedCleanup.failed;
        memoriesProcessed += processedMissing.claimed + processedStale.claimed +
          processedRelationships.claimed + processedContradictions.claimed + processedEvolution.claimed + processedCleanup.claimed;
        relationshipsAdded += processedRelationships.added ?? 0;
        contradictionsAdded += processedContradictions.added ?? 0;
        memoriesEvolved += processedEvolution.added ?? 0;
        memoriesPruned += processedEvolution.deleted ?? 0;
        cleanupActions += processedCleanup.deleted ?? 0;
        tenantHealth[tenant.tenant_id] = {
          missingEmbeddings: health.missing_embeddings,
          staleEmbeddings: health.stale_embeddings,
          pendingJobs: health.pending_jobs,
          failedJobs: health.failed_jobs,
          pendingByType: health.pending_by_type,
          failedByType: health.failed_by_type
        };
      }

      await this.service.finishRun(runId, jobsFailed === 0 ? 'succeeded' : 'failed', {
        tenants_processed: tenants.length,
        memories_processed: memoriesProcessed,
        jobs_created: jobsCreated,
        jobs_succeeded: jobsSucceeded,
        jobs_failed: jobsFailed,
        cleanup_actions: cleanupActions,
        metadata: { tenantHealth, relationshipsAdded, contradictionsAdded, memoriesEvolved, memoriesPruned }
      });

      console.log('[MaintenanceWorker] Cycle complete', {
        tenantsProcessed: tenants.length,
        jobsCreated,
        jobsSucceeded,
        jobsFailed,
        relationshipsAdded,
        contradictionsAdded,
        memoriesEvolved,
        memoriesPruned,
        cleanupActions,
        tenantHealth
      });
    } catch (error) {
      await this.service.finishRun(runId, 'failed', {
        error_message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      this.running = false;
    }
  }
}

const worker = new MaintenanceWorker();

process.on('SIGTERM', () => {
  worker.stop().then(() => process.exit(0)).catch(error => {
    console.error('[MaintenanceWorker] Failed to stop after SIGTERM:', error);
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  worker.stop().then(() => process.exit(0)).catch(error => {
    console.error('[MaintenanceWorker] Failed to stop after SIGINT:', error);
    process.exit(1);
  });
});

worker.start().catch(error => {
  console.error('[MaintenanceWorker] Failed to start:', error);
  process.exit(1);
});
