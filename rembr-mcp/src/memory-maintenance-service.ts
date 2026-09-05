import { randomUUID } from 'crypto';
import { MemoryDatabase } from './database.js';
import { EmbeddingProvider } from './ollama-provider.js';
import { AdvancedAnalyticsService } from './advanced-analytics-service.js';
import { MemoryRelationshipService } from './memory-relationship-service.js';
import { OllamaClient } from './ollama-client.js';

export type MemoryMaintenanceJobType =
  | 'embedding'
  | 'stale_embedding'
  | 'relationship_inference'
  | 'contradiction_detection'
  | 'memory_evolution'
  | 'cleanup'
  | 'compaction';

export type MemoryMaintenanceJobStatus =
  | 'pending'
  | 'leased'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface MemoryProcessingJob {
  id: string;
  tenant_id: string;
  project_id?: string;
  memory_id?: string;
  job_type: MemoryMaintenanceJobType;
  status: MemoryMaintenanceJobStatus;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  available_at: Date;
  leased_until?: Date;
  lease_owner?: string;
  last_error?: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date;
}

export interface MaintenanceHealth {
  total_memories: number;
  total_embeddings: number;
  missing_embeddings: number;
  stale_embeddings: number;
  pending_jobs: number;
  leased_jobs: number;
  failed_jobs: number;
  pending_by_type: Record<string, number>;
  failed_by_type: Record<string, number>;
  oldest_pending_job_age_seconds: number | null;
  oldest_unembedded_memory_age_seconds: number | null;
  last_successful_run_at: Date | null;
}

export interface GlobalMaintenanceHealth extends MaintenanceHealth {
  tenants_checked: number;
  tenants: Record<string, MaintenanceHealth>;
}

export interface EnqueueResult {
  job_type: MemoryMaintenanceJobType;
  created: number;
}

export interface ProcessBatchResult {
  claimed: number;
  succeeded: number;
  failed: number;
  processed?: number;
  added?: number;
  deleted?: number;
}

export interface TenantMaintenanceTarget {
  tenant_id: string;
}

export type MaintenanceRunType =
  | 'embedding_backfill'
  | 'stale_embedding_refresh'
  | 'relationship_inference'
  | 'contradiction_detection'
  | 'memory_evolution'
  | 'cleanup'
  | 'compaction'
  | 'full_cycle';

type MemoryEvolutionAction = 'keep' | 'rewrite' | 'archive_source';

interface MemoryEvolutionDecision {
  action: MemoryEvolutionAction;
  confidence: number;
  reason: string;
  rewrittenContent?: string;
  supersededByMemoryId?: string | null;
}

export class MemoryMaintenanceService {
  constructor(
    private db: MemoryDatabase,
    private workerId: string = `maintenance-${process.pid}-${randomUUID()}`,
    private embeddingProvider?: EmbeddingProvider
  ) {}

  async listActiveTenants(limit = 100): Promise<TenantMaintenanceTarget[]> {
    const result = await this.db.query(`
      SELECT id::text AS tenant_id
      FROM tenants
      WHERE COALESCE(status, 'active') = 'active'
      ORDER BY created_at ASC
      LIMIT $1
    `, [limit]);

    return result.rows;
  }

  async enqueueMissingEmbeddingJobs(tenantId: string, limit = 500): Promise<EnqueueResult> {
    const result = await this.db.query(`
      INSERT INTO memory_processing_jobs (
        tenant_id,
        project_id,
        memory_id,
        job_type,
        status,
        priority,
        metadata
      )
      SELECT
        m.tenant_id,
        m.project_id,
        m.id,
        'embedding',
        'pending',
        50,
        jsonb_build_object('reason', 'missing_embedding', 'source', 'maintenance_backfill')
      FROM memories m
      LEFT JOIN memory_embeddings me ON me.memory_id = m.id
      WHERE me.memory_id IS NULL
        AND m.tenant_id = $2
        AND NOT EXISTS (
          SELECT 1
          FROM memory_processing_jobs j
          WHERE j.tenant_id = m.tenant_id
            AND j.memory_id = m.id
            AND j.job_type = 'embedding'
            AND j.status IN ('pending', 'leased')
        )
      ORDER BY m.created_at ASC
      LIMIT $1
      RETURNING id
    `, [limit, tenantId], tenantId);

    return {
      job_type: 'embedding',
      created: result.rowCount ?? 0
    };
  }

  async startRun(runType: MaintenanceRunType, metadata: Record<string, unknown> = {}): Promise<string> {
    const result = await this.db.query(`
      INSERT INTO memory_maintenance_runs (worker_id, run_type, status, metadata)
      VALUES ($1, $2, 'running', $3::jsonb)
      RETURNING id
    `, [this.workerId, runType, JSON.stringify(metadata)]);

    return result.rows[0].id;
  }

  async finishRun(
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    stats: {
      tenants_processed?: number;
      memories_processed?: number;
      jobs_created?: number;
      jobs_succeeded?: number;
      jobs_failed?: number;
      cleanup_actions?: number;
      error_message?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    await this.db.query(`
      UPDATE memory_maintenance_runs
      SET status = $2,
          completed_at = NOW(),
          duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::int * 1000,
          tenants_processed = $3,
          memories_processed = $4,
          jobs_created = $5,
          jobs_succeeded = $6,
          jobs_failed = $7,
          cleanup_actions = $8,
          error_message = $9,
          metadata = COALESCE(metadata, '{}'::jsonb) || $10::jsonb
      WHERE id = $1
    `, [
      runId,
      status,
      stats.tenants_processed ?? 0,
      stats.memories_processed ?? 0,
      stats.jobs_created ?? 0,
      stats.jobs_succeeded ?? 0,
      stats.jobs_failed ?? 0,
      stats.cleanup_actions ?? 0,
      stats.error_message ?? null,
      JSON.stringify(stats.metadata ?? {})
    ]);
  }

  async enqueueStaleEmbeddingJobs(tenantId: string, limit = 500): Promise<EnqueueResult> {
    const result = await this.db.query(`
      INSERT INTO memory_processing_jobs (
        tenant_id,
        project_id,
        memory_id,
        job_type,
        status,
        priority,
        metadata
      )
      SELECT
        m.tenant_id,
        m.project_id,
        m.id,
        'stale_embedding',
        'pending',
        60,
        jsonb_build_object('reason', 'stale_embedding', 'source', 'maintenance_backfill')
      FROM memories m
      JOIN memory_embeddings me ON me.memory_id = m.id
      WHERE COALESCE(me.is_stale, FALSE) = TRUE
        AND m.tenant_id = $2
        AND NOT EXISTS (
          SELECT 1
          FROM memory_processing_jobs j
          WHERE j.tenant_id = m.tenant_id
            AND j.memory_id = m.id
            AND j.job_type = 'stale_embedding'
            AND j.status IN ('pending', 'leased')
        )
      ORDER BY COALESCE(me.stale_since, me.created_at, m.created_at) ASC
      LIMIT $1
      RETURNING id
    `, [limit, tenantId], tenantId);

    return {
      job_type: 'stale_embedding',
      created: result.rowCount ?? 0
    };
  }

  async enqueueRelationshipInferenceJobs(tenantId: string, limit = 500): Promise<EnqueueResult> {
    const result = await this.db.query(`
      INSERT INTO memory_processing_jobs (
        tenant_id,
        project_id,
        memory_id,
        job_type,
        status,
        priority,
        metadata
      )
      SELECT
        m.tenant_id,
        m.project_id,
        m.id,
        'relationship_inference',
        'pending',
        70,
        jsonb_build_object('reason', 'scheduled_relationship_inference', 'source', 'maintenance_worker')
      FROM memories m
      JOIN memory_embeddings me ON me.memory_id = m.id
      WHERE m.tenant_id = $2
        AND NOT EXISTS (
          SELECT 1
          FROM memory_processing_jobs j
          WHERE j.tenant_id = m.tenant_id
            AND j.memory_id = m.id
            AND j.job_type = 'relationship_inference'
            AND j.status IN ('pending', 'leased', 'succeeded')
        )
      ORDER BY m.created_at ASC
      LIMIT $1
      RETURNING id
    `, [limit, tenantId], tenantId);

    return {
      job_type: 'relationship_inference',
      created: result.rowCount ?? 0
    };
  }

  async enqueueContradictionDetectionJobs(
    tenantId: string,
    limit = 500,
    scope?: { projectId?: string; userId?: string },
  ): Promise<EnqueueResult> {
    const result = await this.db.query(`
      INSERT INTO memory_processing_jobs (
        tenant_id,
        project_id,
        memory_id,
        job_type,
        status,
        priority,
        metadata
      )
      SELECT
        m.tenant_id,
        m.project_id,
        m.id,
        'contradiction_detection',
        'pending',
        80,
        jsonb_build_object('reason', 'scheduled_contradiction_detection', 'source', 'maintenance_worker')
      FROM memories m
      JOIN memory_embeddings me ON me.memory_id = m.id
      LEFT JOIN projects p ON p.id = m.project_id
      WHERE m.tenant_id = $2
        AND (
          $3::boolean = false
          OR (
            ($4::uuid IS NULL OR m.project_id = $4::uuid)
            AND (
              (COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $5::uuid)
              OR (
                COALESCE(m.visibility, 'shared') IN ('shared', 'project')
                AND (p.id IS NULL OR p.is_personal = false OR p.owner_id = $5::uuid
                     OR EXISTS (SELECT 1 FROM project_members pm
                                WHERE pm.project_id = p.id AND pm.user_id = $5::uuid))
              )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM memory_processing_jobs j
          WHERE j.tenant_id = m.tenant_id
            AND j.memory_id = m.id
            AND j.job_type = 'contradiction_detection'
            AND j.status IN ('pending', 'leased', 'succeeded')
        )
      ORDER BY m.created_at ASC
      LIMIT $1
      RETURNING id
    `, [limit, tenantId, Boolean(scope), scope?.projectId || null, scope?.userId || null], tenantId);

    return {
      job_type: 'contradiction_detection',
      created: result.rowCount ?? 0
    };
  }

  async enqueueContradictionDetectionJobForMemory(tenantId: string, memoryId: string): Promise<EnqueueResult> {
    const result = await this.db.query(`
      INSERT INTO memory_processing_jobs (
        tenant_id,
        project_id,
        memory_id,
        job_type,
        status,
        priority,
        metadata
      )
      SELECT
        m.tenant_id,
        m.project_id,
        m.id,
        'contradiction_detection',
        'pending',
        90,
        jsonb_build_object('reason', 'memory_changed', 'source', 'mcp_server')
      FROM memories m
      WHERE m.tenant_id = $1
        AND m.id = $2
        AND NOT EXISTS (
          SELECT 1
          FROM memory_processing_jobs j
          WHERE j.tenant_id = m.tenant_id
            AND j.memory_id = m.id
            AND j.job_type = 'contradiction_detection'
            AND j.status IN ('pending', 'leased')
        )
      RETURNING id
    `, [tenantId, memoryId], tenantId);

    return {
      job_type: 'contradiction_detection',
      created: result.rowCount ?? 0
    };
  }

  async enqueueMemoryEvolutionJobs(tenantId: string, limit = 200): Promise<EnqueueResult> {
    const result = await this.db.query(`
      INSERT INTO memory_processing_jobs (
        tenant_id,
        project_id,
        memory_id,
        job_type,
        status,
        priority,
        metadata
      )
      SELECT
        m.tenant_id,
        m.project_id,
        m.id,
        'memory_evolution',
        'pending',
        85,
        jsonb_build_object('reason', 'scheduled_memory_evolution', 'source', 'maintenance_worker')
      FROM memories m
      WHERE m.tenant_id = $2
        AND NOT EXISTS (
          SELECT 1
          FROM memory_processing_jobs j
          WHERE j.tenant_id = m.tenant_id
            AND j.memory_id = m.id
            AND j.job_type = 'memory_evolution'
            AND j.status IN ('pending', 'leased')
        )
        AND (
          m.metadata #>> '{memory_evolution,last_evaluated_at}' IS NULL
          OR m.updated_at > (m.metadata #>> '{memory_evolution,last_evaluated_at}')::timestamptz
        )
      ORDER BY m.updated_at ASC
      LIMIT $1
      RETURNING id
    `, [limit, tenantId], tenantId);

    return {
      job_type: 'memory_evolution',
      created: result.rowCount ?? 0
    };
  }

  async enqueueExpiredMemoryCleanupJobs(tenantId: string, limit = 500): Promise<EnqueueResult> {
    try {
      const result = await this.db.query(`
        INSERT INTO memory_processing_jobs (
          tenant_id,
          project_id,
          memory_id,
          job_type,
          status,
          priority,
          metadata
        )
        SELECT
          m.tenant_id,
          m.project_id,
          m.id,
          'cleanup',
          'pending',
          90,
          jsonb_build_object(
            'reason', 'expired_retention',
            'source', 'maintenance_worker',
            'cleanup_type', 'expired_retention',
            'retention_expires_at', m.retention_expires_at
          )
        FROM memories m
        WHERE m.tenant_id = $2
          AND m.retention_expires_at IS NOT NULL
          AND m.retention_expires_at <= NOW()
          AND COALESCE(m.retention_policy, 'standard') != 'gdpr_deleted'
          AND NOT EXISTS (
            SELECT 1
            FROM memory_processing_jobs j
            WHERE j.tenant_id = m.tenant_id
              AND j.memory_id = m.id
              AND j.job_type = 'cleanup'
              AND j.status IN ('pending', 'leased', 'succeeded')
          )
        ORDER BY m.retention_expires_at ASC
        LIMIT $1
        RETURNING id
      `, [limit, tenantId], tenantId);

      return {
        job_type: 'cleanup',
        created: result.rowCount ?? 0
      };
    } catch (error) {
      if (this.isOptionalSchemaMissing(error)) {
        return { job_type: 'cleanup', created: 0 };
      }
      throw error;
    }
  }

  /** Remove expired immutable snapshots in bounded tenant-scoped batches. */
  async cleanExpiredSnapshots(tenantId: string, limit = 500): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const result = await this.db.query(`
      WITH expired AS (
        SELECT id
        FROM context_snapshots
        WHERE tenant_id = $1
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        ORDER BY expires_at, id
        LIMIT $2
      )
      DELETE FROM context_snapshots s
      USING expired
      WHERE s.id = expired.id
        AND s.tenant_id = $1
      RETURNING s.id
    `, [tenantId, boundedLimit], tenantId);
    return result.rowCount ?? 0;
  }

  async claimJobs(
    jobType: MemoryMaintenanceJobType,
    tenantId: string,
    limit = 10,
    leaseSeconds = 300
  ): Promise<MemoryProcessingJob[]> {
    const result = await this.db.query(`
      WITH candidates AS (
        SELECT id
        FROM memory_processing_jobs
        WHERE job_type = $1
          AND tenant_id = $2
          AND status = 'pending'
          AND available_at <= NOW()
          AND attempt_count < max_attempts
        ORDER BY priority ASC, available_at ASC, created_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      UPDATE memory_processing_jobs j
      SET status = 'leased',
          lease_owner = $4,
          leased_until = NOW() + ($5::text || ' seconds')::interval,
          attempt_count = attempt_count + 1,
          updated_at = NOW()
      FROM candidates
      WHERE j.id = candidates.id
      RETURNING j.*
    `, [jobType, tenantId, limit, this.workerId, leaseSeconds], tenantId);

    return result.rows;
  }

  async processEmbeddingBackfillBatch(tenantId: string, limit = 10): Promise<ProcessBatchResult> {
    if (!this.embeddingProvider) {
      throw new Error('Embedding provider is not configured');
    }

    const jobs = await this.claimJobs('embedding', tenantId, limit);
    let succeeded = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        if (!job.memory_id) {
          throw new Error(`Embedding job ${job.id} has no memory_id`);
        }

        const memoryResult = await this.db.query(`
          SELECT id, tenant_id, content
          FROM memories
          WHERE id = $1
            AND tenant_id = $2
        `, [job.memory_id, job.tenant_id], job.tenant_id);

        const memory = memoryResult.rows[0];
        if (!memory) {
          await this.completeJob(job.id, job.tenant_id);
          succeeded++;
          continue;
        }

        const embedding = await this.embeddingProvider.generateEmbedding(memory.content, { tenantId: memory.tenant_id });
        await this.db.storeEmbedding(
          memory.id,
          memory.tenant_id,
          embedding,
          this.embeddingProvider.name,
          this.embeddingProvider.model,
          this.embeddingProvider.getModelFingerprint()
        );
        await this.completeJob(job.id, job.tenant_id);
        succeeded++;
      } catch (error) {
        failed++;
        await this.failJob(job, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return { claimed: jobs.length, succeeded, failed };
  }

  async processStaleEmbeddingBatch(tenantId: string, limit = 10): Promise<ProcessBatchResult> {
    if (!this.embeddingProvider) {
      throw new Error('Embedding provider is not configured');
    }

    const jobs = await this.claimJobs('stale_embedding', tenantId, limit);
    let succeeded = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        if (!job.memory_id) {
          throw new Error(`Stale embedding job ${job.id} has no memory_id`);
        }

        const memoryResult = await this.db.query(`
          SELECT id, tenant_id, content
          FROM memories
          WHERE id = $1
            AND tenant_id = $2
        `, [job.memory_id, job.tenant_id], job.tenant_id);

        const memory = memoryResult.rows[0];
        if (!memory) {
          await this.completeJob(job.id, job.tenant_id);
          succeeded++;
          continue;
        }

        const embedding = await this.embeddingProvider.generateEmbedding(memory.content, { tenantId: memory.tenant_id });
        await this.db.storeEmbedding(
          memory.id,
          memory.tenant_id,
          embedding,
          this.embeddingProvider.name,
          this.embeddingProvider.model,
          this.embeddingProvider.getModelFingerprint()
        );
        await this.completeJob(job.id, job.tenant_id);
        succeeded++;
      } catch (error) {
        failed++;
        await this.failJob(job, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return { claimed: jobs.length, succeeded, failed };
  }

  async processRelationshipInferenceBatch(
    tenantId: string,
    limit = 10,
    minConfidence = 0.65
  ): Promise<ProcessBatchResult> {
    if (!this.embeddingProvider) {
      throw new Error('Embedding provider is not configured');
    }

    const jobs = await this.claimJobs('relationship_inference', tenantId, limit);
    const relationshipService = new MemoryRelationshipService(this.db, this.embeddingProvider);
    let succeeded = 0;
    let failed = 0;
    let added = 0;

    for (const job of jobs) {
      try {
        if (!job.memory_id) {
          throw new Error(`Relationship inference job ${job.id} has no memory_id`);
        }

        const memoryResult = await this.db.query(`
          SELECT id, tenant_id, project_id
          FROM memories
          WHERE id = $1
            AND tenant_id = $2
        `, [job.memory_id, job.tenant_id], job.tenant_id);

        const memory = memoryResult.rows[0];
        if (!memory) {
          await this.completeJob(job.id, job.tenant_id);
          succeeded++;
          continue;
        }

        const candidates = await relationshipService.inferRelationshipsForMemory(
          memory.id,
          memory.tenant_id,
          memory.project_id
        );
        const qualifying = candidates.filter(candidate => candidate.confidence >= minConfidence);
        await relationshipService.storeRelationships(qualifying, memory.tenant_id);
        added += qualifying.length;

        await this.completeJob(job.id, job.tenant_id);
        succeeded++;
      } catch (error) {
        failed++;
        await this.failJob(job, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return { claimed: jobs.length, succeeded, failed, processed: jobs.length, added };
  }

  async processContradictionDetectionBatch(
    tenantId: string,
    limit = 5,
    minConfidence = 0.7
  ): Promise<ProcessBatchResult> {
    if (!this.embeddingProvider) {
      throw new Error('Embedding provider is not configured');
    }

    const jobs = await this.claimJobs('contradiction_detection', tenantId, limit, 900);
    const analyticsService = new AdvancedAnalyticsService(this.db, this.embeddingProvider);
    let succeeded = 0;
    let failed = 0;
    let added = 0;

    for (const job of jobs) {
      try {
        if (!job.memory_id) {
          throw new Error(`Contradiction detection job ${job.id} has no memory_id`);
        }

        const memoryResult = await this.db.query(`
          SELECT id, tenant_id, content
          FROM memories
          WHERE id = $1
            AND tenant_id = $2
        `, [job.memory_id, job.tenant_id], job.tenant_id);

        const memory = memoryResult.rows[0];
        if (!memory) {
          await this.completeJob(job.id, job.tenant_id);
          succeeded++;
          continue;
        }

        const contradictions = await analyticsService.detectContradictionsForMemory(
          memory.id,
          memory.content,
          memory.tenant_id,
          minConfidence
        );
        added += contradictions.length;

        await this.completeJob(job.id, job.tenant_id);
        succeeded++;
      } catch (error) {
        failed++;
        await this.failJob(job, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return { claimed: jobs.length, succeeded, failed, processed: jobs.length, added };
  }

  async processMemoryEvolutionBatch(
    tenantId: string,
    limit = 3,
    _minConfidence = 0.85
  ): Promise<ProcessBatchResult> {
    const jobs = await this.claimJobs('memory_evolution', tenantId, limit, 900);
    const llm = OllamaClient.getInstance();
    const assessmentEnabled = process.env.MEMORY_EVOLUTION_ASSESSMENT_ENABLED === 'true';
    let succeeded = 0;
    let failed = 0;
    let processed = 0;
    let added = 0;
    let deleted = 0;

    for (const job of jobs) {
      try {
        if (!job.memory_id) {
          throw new Error(`Memory evolution job ${job.id} has no memory_id`);
        }

        const memoryResult = await this.db.query(`
          SELECT id, tenant_id, project_id, user_id, visibility, content, category, metadata, created_at, updated_at
          FROM memories
          WHERE id = $1
            AND tenant_id = $2
        `, [job.memory_id, job.tenant_id], job.tenant_id);

        const memory = memoryResult.rows[0];
        if (!memory) {
          await this.completeJob(job.id, job.tenant_id);
          succeeded++;
          continue;
        }

        const candidates = await this.getEvolutionContext(
          memory.id,
          memory.tenant_id,
          memory.project_id,
          memory.user_id,
          memory.visibility,
        );
        const decision = assessmentEnabled
          ? await this.assessMemoryEvolution(llm, memory, candidates)
          : {
              action: 'keep' as const,
              confidence: 0,
              reason: 'Memory evolution assessment is disabled until explicitly enabled',
            };
        processed++;

        // Model output is evidence for a proposal, never authorisation to
        // rewrite or archive durable tenant knowledge. Application requires a
        // separate reviewed workflow that is intentionally absent here.
        await this.recordMemoryEvolutionDecision(job, memory, decision, true);

        await this.completeJob(job.id, job.tenant_id);
        succeeded++;
      } catch (error) {
        failed++;
        await this.failJob(job, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return { claimed: jobs.length, succeeded, failed, processed, added, deleted };
  }

  async processCleanupBatch(tenantId: string, limit = 10): Promise<ProcessBatchResult> {
    const jobs = await this.claimJobs('cleanup', tenantId, limit);
    let succeeded = 0;
    let failed = 0;
    let deleted = 0;

    for (const job of jobs) {
      try {
        if (!job.memory_id) {
          throw new Error(`Cleanup job ${job.id} has no memory_id`);
        }

        let deletedResult;
        try {
          deletedResult = await this.db.query(`
            WITH deleted AS (
              DELETE FROM memories
              WHERE id = $1
                AND tenant_id = $2
                AND retention_expires_at IS NOT NULL
                AND retention_expires_at <= NOW()
                AND COALESCE(retention_policy, 'standard') != 'gdpr_deleted'
              RETURNING id, tenant_id, project_id, retention_policy, retention_expires_at
            ),
            action AS (
              INSERT INTO memory_cleanup_actions (
                tenant_id,
                project_id,
                action_type,
                status,
                confidence,
                source_memory_id,
                reason,
                dry_run,
                reversible,
                audit_payload,
                applied_at
              )
              SELECT
                tenant_id,
                project_id,
                'archive_stale',
                'applied',
                1.0,
                id,
                'Expired retention policy applied by maintenance worker',
                FALSE,
                FALSE,
                jsonb_build_object(
                  'job_id', $3::uuid,
                  'retention_policy', retention_policy,
                  'retention_expires_at', retention_expires_at,
                  'cleanup_type', 'expired_retention'
                ),
                NOW()
              FROM deleted
              RETURNING id
            )
            SELECT COUNT(*)::int AS deleted_count FROM deleted
          `, [job.memory_id, job.tenant_id, job.id], job.tenant_id);
        } catch (error) {
          if (this.isOptionalSchemaMissing(error)) {
            await this.completeJob(job.id, job.tenant_id);
            succeeded++;
            continue;
          }
          throw error;
        }

        deleted += Number(deletedResult.rows[0]?.deleted_count ?? 0);
        await this.completeJob(job.id, job.tenant_id);
        succeeded++;
      } catch (error) {
        failed++;
        await this.failJob(job, error instanceof Error ? error : new Error(String(error)));
      }
    }

    return { claimed: jobs.length, succeeded, failed, processed: jobs.length, deleted };
  }

  async completeJob(jobId: string, tenantId: string): Promise<void> {
    await this.db.query(`
      UPDATE memory_processing_jobs
      SET status = 'succeeded',
          completed_at = NOW(),
          leased_until = NULL,
          lease_owner = NULL,
          updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2
    `, [jobId, tenantId], tenantId);
  }

  async failJob(
    job: Pick<MemoryProcessingJob, 'id' | 'tenant_id' | 'project_id' | 'memory_id' | 'job_type' | 'attempt_count'>,
    error: Error,
    retryDelaySeconds = 300
  ): Promise<void> {
    const failureReason = this.classifyFailure(error);
    const errorMessage = error.message || String(error);

    await this.db.query(`
      INSERT INTO memory_processing_failures (
        job_id,
        tenant_id,
        project_id,
        memory_id,
        job_type,
        failure_reason,
        error_message,
        attempt_count
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      job.id,
      job.tenant_id,
      job.project_id ?? null,
      job.memory_id ?? null,
      job.job_type,
      failureReason,
      errorMessage,
      job.attempt_count
    ], job.tenant_id);

    await this.db.query(`
      UPDATE memory_processing_jobs
      SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'pending' END,
          available_at = CASE
            WHEN attempt_count >= max_attempts THEN available_at
            ELSE NOW() + ($2::text || ' seconds')::interval
          END,
          leased_until = NULL,
          lease_owner = NULL,
          last_error = $3,
          updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $4
    `, [job.id, retryDelaySeconds, errorMessage, job.tenant_id], job.tenant_id);
  }

  async getHealth(tenantId?: string): Promise<MaintenanceHealth> {
    const memoryTenantFilter = tenantId ? 'WHERE m.tenant_id = $1' : '';
    const jobTenantFilter = tenantId ? 'WHERE tenant_id = $1' : '';
    const pendingTenantFilter = tenantId ? 'AND tenant_id = $1' : '';
    const failedTenantFilter = tenantId ? 'AND tenant_id = $1' : '';
    const result = await this.db.query(`
      WITH memory_counts AS (
        SELECT
          COUNT(*)::int AS total_memories,
          COUNT(me.memory_id)::int AS total_embeddings,
          (COUNT(*) - COUNT(me.memory_id))::int AS missing_embeddings,
          COUNT(*) FILTER (WHERE COALESCE(me.is_stale, FALSE))::int AS stale_embeddings,
          EXTRACT(EPOCH FROM (NOW() - MIN(m.created_at) FILTER (WHERE me.memory_id IS NULL)))::int
            AS oldest_unembedded_memory_age_seconds
        FROM memories m
        LEFT JOIN memory_embeddings me ON me.memory_id = m.id
        ${memoryTenantFilter}
      ),
      job_counts AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_jobs,
          COUNT(*) FILTER (WHERE status = 'leased')::int AS leased_jobs,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_jobs,
          EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'pending')))::int
            AS oldest_pending_job_age_seconds
        FROM memory_processing_jobs
        ${jobTenantFilter}
      ),
      pending_by_type AS (
        SELECT COALESCE(jsonb_object_agg(job_type, count), '{}'::jsonb) AS pending_by_type
        FROM (
          SELECT job_type, COUNT(*)::int AS count
          FROM memory_processing_jobs
          WHERE status = 'pending'
          ${pendingTenantFilter}
          GROUP BY job_type
        ) grouped
      ),
      failed_by_type AS (
        SELECT COALESCE(jsonb_object_agg(job_type, count), '{}'::jsonb) AS failed_by_type
        FROM (
          SELECT job_type, COUNT(*)::int AS count
          FROM memory_processing_jobs
          WHERE status = 'failed'
          ${failedTenantFilter}
          GROUP BY job_type
        ) grouped
      ),
      last_run AS (
        SELECT MAX(completed_at) AS last_successful_run_at
        FROM memory_maintenance_runs
        WHERE status = 'succeeded'
      )
      SELECT *
      FROM memory_counts, job_counts, pending_by_type, failed_by_type, last_run
    `, tenantId ? [tenantId] : undefined, tenantId);

    const row = result.rows[0] ?? {};

    return {
      total_memories: Number(row.total_memories ?? 0),
      total_embeddings: Number(row.total_embeddings ?? 0),
      missing_embeddings: Number(row.missing_embeddings ?? 0),
      stale_embeddings: Number(row.stale_embeddings ?? 0),
      pending_jobs: Number(row.pending_jobs ?? 0),
      leased_jobs: Number(row.leased_jobs ?? 0),
      failed_jobs: Number(row.failed_jobs ?? 0),
      pending_by_type: row.pending_by_type ?? {},
      failed_by_type: row.failed_by_type ?? {},
      oldest_pending_job_age_seconds: this.nullableNumber(row.oldest_pending_job_age_seconds),
      oldest_unembedded_memory_age_seconds: this.nullableNumber(row.oldest_unembedded_memory_age_seconds),
      last_successful_run_at: row.last_successful_run_at ?? null
    };
  }

  async getGlobalHealth(limit = 100): Promise<GlobalMaintenanceHealth> {
    const tenants = await this.listActiveTenants(limit);
    const perTenant: Record<string, MaintenanceHealth> = {};
    const aggregate: GlobalMaintenanceHealth = {
      tenants_checked: tenants.length,
      tenants: perTenant,
      total_memories: 0,
      total_embeddings: 0,
      missing_embeddings: 0,
      stale_embeddings: 0,
      pending_jobs: 0,
      leased_jobs: 0,
      failed_jobs: 0,
      pending_by_type: {},
      failed_by_type: {},
      oldest_pending_job_age_seconds: null,
      oldest_unembedded_memory_age_seconds: null,
      last_successful_run_at: null
    };

    for (const tenant of tenants) {
      const health = await this.getHealth(tenant.tenant_id);
      perTenant[tenant.tenant_id] = health;
      aggregate.total_memories += health.total_memories;
      aggregate.total_embeddings += health.total_embeddings;
      aggregate.missing_embeddings += health.missing_embeddings;
      aggregate.stale_embeddings += health.stale_embeddings;
      aggregate.pending_jobs += health.pending_jobs;
      aggregate.leased_jobs += health.leased_jobs;
      aggregate.failed_jobs += health.failed_jobs;
      this.addCounts(aggregate.pending_by_type, health.pending_by_type);
      this.addCounts(aggregate.failed_by_type, health.failed_by_type);
      aggregate.oldest_pending_job_age_seconds = this.maxNullable(
        aggregate.oldest_pending_job_age_seconds,
        health.oldest_pending_job_age_seconds
      );
      aggregate.oldest_unembedded_memory_age_seconds = this.maxNullable(
        aggregate.oldest_unembedded_memory_age_seconds,
        health.oldest_unembedded_memory_age_seconds
      );
      if (health.last_successful_run_at) {
        const current = aggregate.last_successful_run_at;
        if (!current || health.last_successful_run_at > current) {
          aggregate.last_successful_run_at = health.last_successful_run_at;
        }
      }
    }

    return aggregate;
  }

  private classifyFailure(error: Error): string {
    const message = error.message || '';
    if (message.includes('timeout')) return 'timeout';
    if (message.includes('ECONNREFUSED')) return 'connection_refused';
    if (message.includes('Invalid embedding dimensions')) return 'invalid_embedding_dimensions';
    if (this.isOptionalSchemaMissing(error)) return 'optional_schema_missing';
    return 'unknown';
  }

  private isOptionalSchemaMissing(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    return (code === '42703' && message.includes('retention_')) ||
      (code === '42P01' && message.includes('memory_cleanup_actions')) ||
      (message.includes('retention_') && message.includes('does not exist')) ||
      (message.includes('memory_cleanup_actions') && message.includes('does not exist'));
  }

  private async getEvolutionContext(
    memoryId: string,
    tenantId: string,
    projectId?: string,
    userId?: string,
    visibility?: string,
  ): Promise<any[]> {
    const related = await this.db.query(`
      SELECT
        m.id,
        m.content,
        m.category,
        m.created_at,
        m.updated_at,
        mr.relationship_type,
        mr.confidence
      FROM memory_relationships mr
      JOIN memories m ON m.id = CASE
        WHEN mr.source_memory_id = $1 THEN mr.target_memory_id
        ELSE mr.source_memory_id
      END
      WHERE (mr.source_memory_id = $1 OR mr.target_memory_id = $1)
        AND m.tenant_id = $2
        AND m.project_id IS NOT DISTINCT FROM $3::uuid
        AND (
          ($5::text = 'personal' AND m.visibility = 'personal' AND m.user_id = $4::uuid)
          OR ($5::text <> 'personal' AND COALESCE(m.visibility, 'shared') <> 'personal')
        )
      ORDER BY mr.confidence DESC, m.updated_at DESC
      LIMIT 12
    `, [memoryId, tenantId, projectId || null, userId || null, visibility || 'shared'], tenantId);

    if (related.rows.length > 0) {
      return related.rows;
    }

    const params = [tenantId, memoryId, projectId || null, userId || null, visibility || 'shared'];
    const recent = await this.db.query(`
      SELECT id, content, category, created_at, updated_at, 'recent_context' AS relationship_type, 0.25 AS confidence
      FROM memories
      WHERE tenant_id = $1
        AND id != $2
        AND project_id IS NOT DISTINCT FROM $3::uuid
        AND (
          ($5::text = 'personal' AND visibility = 'personal' AND user_id = $4::uuid)
          OR ($5::text <> 'personal' AND COALESCE(visibility, 'shared') <> 'personal')
        )
      ORDER BY updated_at DESC
      LIMIT 8
    `, params, tenantId);

    return recent.rows;
  }

  private async assessMemoryEvolution(
    llm: OllamaClient,
    memory: any,
    candidates: any[]
  ): Promise<MemoryEvolutionDecision> {
    const systemPrompt = `You maintain a production memory store.
You may decide to keep, rewrite, or archive the source memory.
Return only compact JSON. Never include markdown.

Actions:
- keep: the memory is still useful as written.
- rewrite: the source memory should be rewritten into cleaner, current, non-duplicative content.
- archive_source: the source memory is stale, superseded, duplicate, or low-value and should be archived.

Rules:
- Prefer rewrite for useful memories that need temporal cleanup.
- Prefer archive_source when a newer related memory clearly supersedes the source.
- Preserve user preferences, facts, dates, and caveats.
- Do not invent new facts.
- Confidence must reflect how safe the action is. Use >= 0.85 only when the decision is clear.`;

    const prompt = `Source memory:
id: ${memory.id}
category: ${memory.category ?? 'uncategorized'}
created_at: ${this.formatDate(memory.created_at)}
updated_at: ${this.formatDate(memory.updated_at)}
content: ${memory.content}

Related/recent memories:
${candidates.map((candidate, index) => `${index + 1}. id: ${candidate.id}
relationship: ${candidate.relationship_type ?? 'unknown'} (${candidate.confidence ?? 'unknown'})
created_at: ${this.formatDate(candidate.created_at)}
updated_at: ${this.formatDate(candidate.updated_at)}
content: ${candidate.content}`).join('\n\n')}

Respond as JSON:
{"action":"keep|rewrite|archive_source","confidence":0.0,"reason":"short reason","rewrittenContent":"only for rewrite","supersededByMemoryId":"id or null"}`;

    try {
      const response = await llm.generateText(prompt, systemPrompt, {
        temperature: 0,
        maxTokens: 700,
        tenantId: memory.tenant_id,
      });
      return this.parseMemoryEvolutionDecision(response);
    } catch (error) {
      console.warn(`[MemoryMaintenanceService] Memory evolution LLM assessment failed: ${error}`);
      return {
        action: 'keep',
        confidence: 0,
        reason: `LLM assessment failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private parseMemoryEvolutionDecision(response: string): MemoryEvolutionDecision {
    const jsonText = this.extractJsonObject(response);
    if (!jsonText) {
      return { action: 'keep', confidence: 0, reason: 'LLM returned no JSON decision' };
    }

    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const action = String(parsed.action ?? '').trim() as MemoryEvolutionAction;
      if (!['keep', 'rewrite', 'archive_source'].includes(action)) {
        return { action: 'keep', confidence: 0, reason: 'LLM returned unsupported memory evolution action' };
      }

      const rawConfidence = typeof parsed.confidence === 'number'
        ? parsed.confidence
        : Number(parsed.confidence);
      const confidence = Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence))
        : 0;
      const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 1000)
        : 'No reason provided by LLM';
      const rewrittenContent = typeof parsed.rewrittenContent === 'string'
        ? parsed.rewrittenContent.trim()
        : undefined;
      const parsedSupersededBy = typeof parsed.supersededByMemoryId === 'string'
        ? parsed.supersededByMemoryId
        : null;
      const supersededByMemoryId = parsedSupersededBy && this.isUuid(parsedSupersededBy)
        ? parsedSupersededBy
        : null;

      return { action, confidence, reason, rewrittenContent, supersededByMemoryId };
    } catch {
      return { action: 'keep', confidence: 0, reason: 'LLM returned invalid JSON decision' };
    }
  }

  private async applyMemoryRewrite(job: MemoryProcessingJob, memory: any, decision: MemoryEvolutionDecision): Promise<void> {
    await this.db.query(`
      WITH updated AS (
        UPDATE memories
        SET content = $3,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'memory_evolution',
              jsonb_build_object(
                'last_evaluated_at', NOW(),
                'last_action', 'rewrite',
                'confidence', $4::numeric,
                'reason', $5::text,
                'previous_content', $6,
                'job_id', $7::uuid
              )
            ),
            updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
        RETURNING id, tenant_id, project_id
      ),
      stale_embedding AS (
        UPDATE memory_embeddings
        SET is_stale = TRUE,
            stale_since = NOW()
        WHERE memory_id = $1
        RETURNING memory_id
      )
      INSERT INTO memory_cleanup_actions (
        tenant_id,
        project_id,
        action_type,
        status,
        confidence,
        source_memory_id,
        reason,
        dry_run,
        reversible,
        audit_payload,
        applied_at
      )
      SELECT
        tenant_id,
        project_id,
        'rewrite_memory',
        'applied',
        $4::numeric,
        id,
        $5::text,
        FALSE,
        TRUE,
        jsonb_build_object(
          'job_id', $7::uuid,
          'previous_content', $6,
          'rewritten_content', $3,
          'embedding_marked_stale', EXISTS (SELECT 1 FROM stale_embedding)
        ),
        NOW()
      FROM updated
    `, [
      memory.id,
      memory.tenant_id,
      decision.rewrittenContent,
      decision.confidence,
      decision.reason,
      memory.content,
      job.id
    ], memory.tenant_id);
  }

  private async applyMemoryArchive(job: MemoryProcessingJob, memory: any, decision: MemoryEvolutionDecision): Promise<void> {
    await this.db.query(`
      WITH archived AS (
        INSERT INTO archived_memories (
          id,
          tenant_id,
          project_id,
          content,
          category,
          embedding,
          archived_reason,
          replaced_by_id,
          original_created_at,
          original_updated_at,
          metadata
        )
        SELECT
          m.id,
          m.tenant_id,
          m.project_id,
          m.content,
          COALESCE(m.category, 'uncategorized'),
          me.embedding,
          CASE WHEN $3::uuid IS NULL THEN 'llm_pruned' ELSE 'llm_superseded' END,
          $3::uuid,
          m.created_at,
          m.updated_at,
          COALESCE(m.metadata, '{}'::jsonb) || jsonb_build_object(
            'memory_evolution',
            jsonb_build_object(
              'last_evaluated_at', NOW(),
              'last_action', 'archive_source',
              'confidence', $4::numeric,
              'reason', $5::text,
              'job_id', $6::uuid
            )
          )
        FROM memories m
        LEFT JOIN memory_embeddings me ON me.memory_id = m.id
        WHERE m.id = $1
          AND m.tenant_id = $2
        ON CONFLICT (id) DO NOTHING
        RETURNING id, tenant_id, project_id
      ),
      deleted AS (
        DELETE FROM memories
        WHERE id = $1
          AND tenant_id = $2
          AND EXISTS (SELECT 1 FROM archived)
        RETURNING id
      )
      INSERT INTO memory_cleanup_actions (
        tenant_id,
        project_id,
        action_type,
        status,
        confidence,
        source_memory_id,
        target_memory_id,
        reason,
        dry_run,
        reversible,
        audit_payload,
        applied_at
      )
      SELECT
        tenant_id,
        project_id,
        CASE WHEN $3::uuid IS NULL THEN 'archive_stale' ELSE 'archive_superseded' END,
        'applied',
        $4::numeric,
        id,
        $3::uuid,
        $5::text,
        FALSE,
        TRUE,
        jsonb_build_object('job_id', $6::uuid, 'deleted', EXISTS (SELECT 1 FROM deleted)),
        NOW()
      FROM archived
    `, [
      memory.id,
      memory.tenant_id,
      decision.supersededByMemoryId ?? null,
      decision.confidence,
      decision.reason,
      job.id
    ], memory.tenant_id);
  }

  private async recordMemoryEvolutionDecision(
    job: MemoryProcessingJob,
    memory: any,
    decision: MemoryEvolutionDecision,
    dryRun = false
  ): Promise<void> {
    await this.db.query(`
      WITH marked AS (
        UPDATE memories
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'memory_evolution',
              jsonb_build_object(
                'last_evaluated_at', NOW(),
                'last_action', $3::text,
                'confidence', $4::numeric,
                'reason', $5::text,
                'job_id', $6::uuid,
                'dry_run', $7::boolean
              )
            )
        WHERE id = $1
          AND tenant_id = $2
        RETURNING id, tenant_id, project_id
      )
      INSERT INTO memory_cleanup_actions (
        tenant_id,
        project_id,
        action_type,
        status,
        confidence,
        source_memory_id,
        reason,
        dry_run,
        reversible,
        audit_payload
      )
      SELECT
        tenant_id,
        project_id,
        'review_candidate',
        CASE WHEN $3::text = 'keep' THEN 'skipped' ELSE 'proposed' END,
        $4::numeric,
        id,
        $5::text,
        $7::boolean,
        TRUE,
        jsonb_build_object(
          'job_id', $6::uuid,
          'decision', $3::text,
          'rewritten_content', $8::text,
          'superseded_by_memory_id', $9::uuid,
          'requires_review', TRUE
        )
      FROM marked
    `, [
      memory.id,
      memory.tenant_id,
      decision.action,
      decision.confidence,
      decision.reason,
      job.id,
      dryRun,
      decision.rewrittenContent || null,
      decision.supersededByMemoryId || null,
    ], memory.tenant_id);
  }

  private extractJsonObject(response: string): string | null {
    const start = response.indexOf('{');
    const end = response.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    return response.slice(start, end + 1);
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private formatDate(value: Date | string | undefined): string {
    if (!value) return 'unknown';
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString();
  }

  private nullableNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private addCounts(target: Record<string, number>, source: Record<string, number>): void {
    for (const [key, value] of Object.entries(source)) {
      target[key] = (target[key] ?? 0) + Number(value ?? 0);
    }
  }

  private maxNullable(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return Math.max(a, b);
  }
}
