import { describe, expect, it } from 'vitest';
import { MemoryService } from './memory-service.js';

const tenantId = 'tenant-search-metadata';

function createMockDb() {
  return {
    getTenantPlan: async () => ({
      tenant_id: tenantId,
      plan: 'pro',
      memory_limit: 1000,
      search_limit_daily: 1000,
      project_limit: 10
    }),
    getMemoryCount: async () => 4,
    getEmbeddingCount: async () => 3,
    getTodaySearchCount: async () => 0,
    reserveSearchQuota: async () => undefined,
    searchMemories: async () => [
      {
        id: 'memory-text-hit',
        tenant_id: tenantId,
        project_id: 'project-a',
        content: 'The release checklist requires a smoke test after deploy.',
        category: 'facts',
        metadata: {},
        created_at: new Date('2026-07-05T08:00:00Z'),
        updated_at: new Date('2026-07-05T08:00:00Z'),
        relevance_score: 1
      }
    ],
    query: async (sql: string) => ({
      rows: sql.includes('COUNT(*)::int AS total')
        ? [{ total: 4, indexed: 3 }]
        : []
    })
  } as any;
}

describe('MemoryService search diagnostics', () => {
  it('returns text results with explicit semantic fallback metadata when hybrid has no provider', async () => {
    const service = new MemoryService(tenantId, 'project-a', createMockDb());

    const results = await service.searchMemory({
      query: 'smoke test deploy',
      search_mode: 'hybrid'
    });

    expect(results).toHaveLength(1);
    expect(results.search_metadata).toMatchObject({
      semantic_status: 'unavailable',
      semantic_error: 'No embedding provider configured',
      fallback_used: true,
      min_similarity: 0.5,
      embedding_coverage: 0.75,
      embedding_pending: 1,
      embedding_total: 4
    });
  });

  it('throws a clear semantic unavailable error when semantic mode has no provider', async () => {
    const service = new MemoryService(tenantId, 'project-a', createMockDb());

    await expect(service.searchMemory({
      query: 'smoke test deploy',
      search_mode: 'semantic'
    })).rejects.toThrow('Semantic search unavailable: no embedding provider configured');
  });

  it('returns hybrid text fallback metadata when semantic embedding generation fails', async () => {
    const embeddingProvider = {
      name: 'test-provider',
      model: 'test-model',
      dimensions: 3,
      isAvailable: async () => true,
      generateEmbedding: async () => {
        throw new Error('embedding endpoint unavailable');
      },
      getModelFingerprint: () => 'test-provider:test-model:3'
    };
    const service = new MemoryService(tenantId, 'project-a', createMockDb(), embeddingProvider as any);

    const results = await service.searchMemory({
      query: 'smoke test deploy',
      search_mode: 'hybrid'
    });

    expect(results).toHaveLength(1);
    expect(results.search_metadata).toMatchObject({
      semantic_status: 'failed',
      semantic_error: 'Embedding-backed search failed',
      fallback_used: true,
      min_similarity: 0.5,
      embedding_coverage: 0.75
    });
  });

  it('uses the openai-compatible tuned default threshold when available', async () => {
    const embeddingProvider = {
      name: 'openai-compatible',
      model: 'text-embedding-nomic-embed-text-v1.5',
      dimensions: 768,
      isAvailable: async () => true,
      generateEmbedding: async () => [0.1, 0.2, 0.3],
      getModelFingerprint: () => 'openai-compatible:text-embedding-nomic-embed-text-v1.5:768'
    };
    const db = {
      ...createMockDb(),
      semanticSearch: async () => []
    };
    const service = new MemoryService(tenantId, 'project-a', db as any, embeddingProvider as any);

    const results = await service.searchMemory({
      query: 'smoke test deploy',
      search_mode: 'hybrid'
    });

    expect(results.search_metadata).toMatchObject({
      semantic_status: 'succeeded',
      min_similarity: 0.35
    });
  });
});
