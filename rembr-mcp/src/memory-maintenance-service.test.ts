import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryMaintenanceService } from './memory-maintenance-service.js';
import { MemoryRelationshipService } from './memory-relationship-service.js';
import { AdvancedAnalyticsService } from './advanced-analytics-service.js';

const relationshipMocks = vi.hoisted(() => ({
  inferRelationshipsForMemory: vi.fn(),
  storeRelationships: vi.fn()
}));

const analyticsMocks = vi.hoisted(() => ({
  detectContradictionsForMemory: vi.fn()
}));

const ollamaMocks = vi.hoisted(() => ({
  generateText: vi.fn()
}));

vi.mock('./memory-relationship-service.js', () => ({
  MemoryRelationshipService: vi.fn(() => relationshipMocks)
}));

vi.mock('./advanced-analytics-service.js', () => ({
  AdvancedAnalyticsService: vi.fn(() => analyticsMocks)
}));

vi.mock('./ollama-client.js', () => ({
  OllamaClient: {
    getInstance: vi.fn(() => ollamaMocks)
  }
}));

function createDb(rows: any[][]) {
  const query = vi.fn();
  for (const rowSet of rows) {
    query.mockResolvedValueOnce({ rows: rowSet, rowCount: rowSet.length });
  }
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  return { query };
}

const embeddingProvider = {
  name: 'test-provider',
  model: 'test-model',
  generateEmbedding: vi.fn(),
  getModelFingerprint: vi.fn(() => 'fingerprint')
} as any;

describe('MemoryMaintenanceService scheduled batches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes relationship inference jobs through MemoryRelationshipService', async () => {
    relationshipMocks.inferRelationshipsForMemory.mockResolvedValue([
      { source_memory_id: 'm1', target_memory_id: 'm2', confidence: 0.8, relationship_type: 'relates_to', evidence: 'similar' },
      { source_memory_id: 'm1', target_memory_id: 'm3', confidence: 0.4, relationship_type: 'relates_to', evidence: 'weak' }
    ]);
    relationshipMocks.storeRelationships.mockResolvedValue(undefined);

    const db = createDb([
      [{ id: 'job-1', tenant_id: 'tenant-1', memory_id: 'm1', job_type: 'relationship_inference', attempt_count: 1, metadata: {} }],
      [{ id: 'm1', tenant_id: 'tenant-1', project_id: 'project-1' }],
      []
    ]);
    const service = new MemoryMaintenanceService(db as any, 'worker-1', embeddingProvider);

    const result = await service.processRelationshipInferenceBatch('tenant-1', 10, 0.65);

    expect(MemoryRelationshipService).toHaveBeenCalledWith(db, embeddingProvider);
    expect(relationshipMocks.inferRelationshipsForMemory).toHaveBeenCalledWith('m1', 'tenant-1', 'project-1');
    expect(relationshipMocks.storeRelationships).toHaveBeenCalledWith([
      { source_memory_id: 'm1', target_memory_id: 'm2', confidence: 0.8, relationship_type: 'relates_to', evidence: 'similar' }
    ], 'tenant-1');
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, added: 1 });
  });

  it('processes contradiction detection jobs through AdvancedAnalyticsService', async () => {
    analyticsMocks.detectContradictionsForMemory.mockResolvedValue([
      { memory_a: { id: 'm1' }, memory_b: { id: 'm2' }, confidence: 0.9 }
    ]);

    const db = createDb([
      [{ id: 'job-1', tenant_id: 'tenant-1', memory_id: 'm1', job_type: 'contradiction_detection', attempt_count: 1, metadata: {} }],
      [{ id: 'm1', tenant_id: 'tenant-1', content: 'Prod is pinned.' }],
      []
    ]);
    const service = new MemoryMaintenanceService(db as any, 'worker-1', embeddingProvider);

    const result = await service.processContradictionDetectionBatch('tenant-1', 5, 0.7);

    expect(AdvancedAnalyticsService).toHaveBeenCalledWith(db, embeddingProvider);
    expect(analyticsMocks.detectContradictionsForMemory).toHaveBeenCalledWith(
      'm1',
      'Prod is pinned.',
      'tenant-1',
      0.7
    );
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, added: 1 });
  });

  it('processes expired retention cleanup jobs and records applied actions', async () => {
    const db = createDb([
      [{ id: 'job-1', tenant_id: 'tenant-1', memory_id: 'm1', job_type: 'cleanup', attempt_count: 1, metadata: {} }],
      [{ deleted_count: 1 }],
      []
    ]);
    const service = new MemoryMaintenanceService(db as any, 'worker-1');

    const result = await service.processCleanupBatch('tenant-1', 10);

    expect(db.query.mock.calls[1][0]).toContain('memory_cleanup_actions');
    expect(db.query.mock.calls[1][1]).toEqual(['m1', 'tenant-1', 'job-1']);
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, deleted: 1 });
  });

  it('enqueues recurring memory evolution jobs based on last evaluation timestamp', async () => {
    const db = createDb([[{ id: 'job-1' }, { id: 'job-2' }]]);
    const service = new MemoryMaintenanceService(db as any, 'worker-1');

    const result = await service.enqueueMemoryEvolutionJobs('tenant-1', 25);

    expect(db.query.mock.calls[0][0]).toContain("m.metadata #>> '{memory_evolution,last_evaluated_at}'");
    expect(db.query.mock.calls[0][0]).toContain("j.status IN ('pending', 'leased')");
    expect(db.query.mock.calls[0][1]).toEqual([25, 'tenant-1']);
    expect(result).toEqual({ job_type: 'memory_evolution', created: 2 });
  });

  it('processes high-confidence LLM rewrite decisions as background memory evolution', async () => {
    ollamaMocks.generateText.mockResolvedValue(JSON.stringify({
      action: 'rewrite',
      confidence: 0.93,
      reason: 'Newer context makes the production endpoint wording clearer.',
      rewrittenContent: 'Production Rembr uses the OpenAI-compatible MCP endpoint.'
    }));

    const db = createDb([
      [{ id: 'job-1', tenant_id: 'tenant-1', memory_id: 'm1', job_type: 'memory_evolution', attempt_count: 1, metadata: {} }],
      [{
        id: 'm1',
        tenant_id: 'tenant-1',
        project_id: 'project-1',
        content: 'Production Rembr uses the old MCP endpoint.',
        category: 'facts',
        metadata: {},
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z')
      }],
      [{
        id: 'm2',
        content: 'Production Rembr now uses the OpenAI-compatible MCP endpoint.',
        category: 'facts',
        relationship_type: 'supersedes',
        confidence: 0.9,
        created_at: new Date('2026-07-01T00:00:00Z'),
        updated_at: new Date('2026-07-01T00:00:00Z')
      }],
      [],
      []
    ]);
    const service = new MemoryMaintenanceService(db as any, 'worker-1');

    const result = await service.processMemoryEvolutionBatch('tenant-1', 3, 0.85);

    expect(ollamaMocks.generateText).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[3][0]).toContain('rewrite_memory');
    expect(db.query.mock.calls[3][0]).toContain('SET is_stale = TRUE');
    expect(db.query.mock.calls[3][1]).toEqual([
      'm1',
      'tenant-1',
      'Production Rembr uses the OpenAI-compatible MCP endpoint.',
      0.93,
      'Newer context makes the production endpoint wording clearer.',
      'Production Rembr uses the old MCP endpoint.',
      'job-1'
    ]);
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, processed: 1, added: 1 });
  });

  it('treats missing retention columns as an optional cleanup no-op', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(Object.assign(
        new Error('column m.retention_expires_at does not exist'),
        { code: '42703' }
      ))
    };
    const service = new MemoryMaintenanceService(db as any, 'worker-1');

    await expect(service.enqueueExpiredMemoryCleanupJobs('tenant-1')).resolves.toEqual({
      job_type: 'cleanup',
      created: 0
    });
  });
});
