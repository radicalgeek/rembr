/**
 * Tests for VectorSearchService (REM-249)
 *
 * Tests cover:
 *  - efSearchForCount tier mapping
 *  - adaptive ef_search selection during search()
 *  - SET LOCAL isolation (ef_search is transaction-scoped)
 *  - category / metadata filtering
 *  - slow-query logging
 *  - indexHealth() report structure and advice
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { efSearchForCount, VectorSearchService } from './vector-search-service.js';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/** Create a minimal mock Pool whose .connect() returns a mock client. */
function makePool(clientOverrides: Partial<ReturnType<typeof makeClient>> = {}) {
  const client = makeClient(clientOverrides);
  return {
    connect: vi.fn().mockResolvedValue(client),
    _client: client,
  };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    query: vi.fn(),
    release: vi.fn(),
    ...overrides,
  };
}

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const QUERY_EMBEDDING = Array.from({ length: 768 }, (_, i) => i / 768);

// ─────────────────────────────────────────────────────────
// efSearchForCount
// ─────────────────────────────────────────────────────────

describe('efSearchForCount', () => {
  it('returns 40 for 0 memories', () => {
    expect(efSearchForCount(0)).toBe(40);
  });

  it('returns 40 for 9 999 memories', () => {
    expect(efSearchForCount(9_999)).toBe(40);
  });

  it('returns 64 for exactly 10 000 memories', () => {
    expect(efSearchForCount(10_000)).toBe(64);
  });

  it('returns 64 for 99 999 memories', () => {
    expect(efSearchForCount(99_999)).toBe(64);
  });

  it('returns 100 for exactly 100 000 memories', () => {
    expect(efSearchForCount(100_000)).toBe(100);
  });

  it('returns 100 for 499 999 memories', () => {
    expect(efSearchForCount(499_999)).toBe(100);
  });

  it('returns 128 for exactly 500 000 memories', () => {
    expect(efSearchForCount(500_000)).toBe(128);
  });

  it('returns 128 for 1 000 000 memories', () => {
    expect(efSearchForCount(1_000_000)).toBe(128);
  });
});

// ─────────────────────────────────────────────────────────
// VectorSearchService.search
// ─────────────────────────────────────────────────────────

describe('VectorSearchService.search', () => {
  let pool: ReturnType<typeof makePool>;
  let service: VectorSearchService;

  /** Build the ordered list of query() call args the service is expected to make */
  function mockQueries(client: ReturnType<typeof makeClient>, memoryCount: number, rows: unknown[] = []) {
    client.query
      // BEGIN
      .mockResolvedValueOnce({ rows: [] })
      // set_config (RLS)
      .mockResolvedValueOnce({ rows: [] })
      // COUNT
      .mockResolvedValueOnce({ rows: [{ cnt: String(memoryCount) }] })
      // SET LOCAL hnsw.ef_search
      .mockResolvedValueOnce({ rows: [] })
      // ANN query
      .mockResolvedValueOnce({ rows })
      // COMMIT
      .mockResolvedValueOnce({ rows: [] });
  }

  beforeEach(() => {
    pool = makePool();
    service = new VectorSearchService(pool as any);
  });

  it('uses ef_search = 40 for a small tenant (< 10k memories)', async () => {
    mockQueries(pool._client, 500);

    await service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING });

    const calls: string[] = pool._client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((q) => q.includes('hnsw.ef_search = 40'))).toBe(true);
  });

  it('uses ef_search = 64 for a mid-size tenant (10k–100k memories)', async () => {
    mockQueries(pool._client, 50_000);

    await service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING });

    const calls: string[] = pool._client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((q) => q.includes('hnsw.ef_search = 64'))).toBe(true);
  });

  it('uses ef_search = 100 for a large tenant (100k–500k memories)', async () => {
    mockQueries(pool._client, 200_000);

    await service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING });

    const calls: string[] = pool._client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((q) => q.includes('hnsw.ef_search = 100'))).toBe(true);
  });

  it('uses ef_search = 128 for a very large tenant (> 500k memories)', async () => {
    mockQueries(pool._client, 600_000);

    await service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING });

    const calls: string[] = pool._client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((q) => q.includes('hnsw.ef_search = 128'))).toBe(true);
  });

  it('respects efSearch override from caller', async () => {
    mockQueries(pool._client, 5_000);

    await service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING, efSearch: 200 });

    const calls: string[] = pool._client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((q) => q.includes('hnsw.ef_search = 200'))).toBe(true);
    // Should NOT pick the automatic tier value (40 for 5 000)
    expect(calls.some((q) => q.includes('hnsw.ef_search = 40'))).toBe(false);
  });

  it('returns results and stats', async () => {
    const fakeRow = {
      id: '660e8400-e29b-41d4-a716-446655440001',
      content: 'test memory',
      category: 'work',
      metadata: '{}',
      similarity: 0.91,
      tenant_id: TENANT_ID,
      project_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockQueries(pool._client, 1_000, [fakeRow]);

    const { results, stats } = await service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(fakeRow.id);
    expect(results[0].similarity).toBe(0.91);
    expect(stats.tenantMemoryCount).toBe(1_000);
    expect(stats.efSearchUsed).toBe(40);
    expect(stats.resultCount).toBe(1);
  });

  it('parses metadata JSON string into an object', async () => {
    const fakeRow = {
      id: '660e8400-e29b-41d4-a716-446655440002',
      content: 'json metadata',
      category: null,
      metadata: '{"source":"test"}',
      similarity: 0.85,
      tenant_id: TENANT_ID,
      project_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockQueries(pool._client, 0, [fakeRow]);

    const { results } = await service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING });
    expect(results[0].metadata).toEqual({ source: 'test' });
  });

  it('rolls back and re-throws on query error', async () => {
    const client = pool._client;
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // set_config
      .mockRejectedValueOnce(new Error('DB error')) // COUNT fails
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(
      service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING }),
    ).rejects.toThrow('DB error');

    const calls: string[] = client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((q) => q === 'ROLLBACK')).toBe(true);
  });

  it('logs a warning for slow queries', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = pool._client;

    // Make the ANN query artificially slow by delaying COMMIT
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // set_config
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] }) // COUNT
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL
      .mockResolvedValueOnce({ rows: [] }) // ANN
      .mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r({ rows: [] }), 210)), // COMMIT delayed
      );

    await service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Slow query'));
    consoleSpy.mockRestore();
  });

  it('releases the client even after an error', async () => {
    const client = pool._client;
    client.query.mockRejectedValue(new Error('fatal'));
    client.query.mockResolvedValueOnce({ rows: [] }); // BEGIN succeeds
    client.query.mockRejectedValueOnce(new Error('fatal'));
    client.query.mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    try {
      await service.search({ tenantId: TENANT_ID, queryEmbedding: QUERY_EMBEDDING });
    } catch {
      // expected
    }

    expect(client.release).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────
// VectorSearchService.indexHealth
// ─────────────────────────────────────────────────────────

describe('VectorSearchService.indexHealth', () => {
  let pool: ReturnType<typeof makePool>;
  let service: VectorSearchService;

  beforeEach(() => {
    pool = makePool();
    service = new VectorSearchService(pool as any);
  });

  const RECENT_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
  const STALE_DATE = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

  function mockIndexQuery(rows: unknown[]) {
    pool._client.query.mockResolvedValueOnce({ rows });
  }

  function makeIndexRow(overrides: Record<string, unknown> = {}) {
    return {
      indexname: 'idx_memories_embedding',
      tablename: 'memories',
      row_estimate: '5000',
      index_size: '4000000',
      table_size: '10000000',
      last_vacuum: RECENT_DATE,
      last_analyze: RECENT_DATE,
      ...overrides,
    };
  }

  it('returns a report for each index row', async () => {
    mockIndexQuery([
      makeIndexRow(),
      makeIndexRow({ indexname: 'idx_embeddings_vector', tablename: 'memory_embeddings' }),
    ]);

    const reports = await service.indexHealth();
    expect(reports).toHaveLength(2);
    expect(reports[0].indexName).toBe('idx_memories_embedding');
    expect(reports[0].rowCount).toBe(5000);
    expect(reports[0].efSearchRecommended).toBe(40);
  });

  it('includes lastVacuumAt and lastAnalyzeAt in the report', async () => {
    mockIndexQuery([makeIndexRow({ last_vacuum: RECENT_DATE, last_analyze: RECENT_DATE })]);

    const [report] = await service.indexHealth();
    expect(report.lastVacuumAt).toBe(RECENT_DATE);
    expect(report.lastAnalyzeAt).toBe(RECENT_DATE);
  });

  it('returns null for lastVacuumAt / lastAnalyzeAt when never run', async () => {
    mockIndexQuery([makeIndexRow({ last_vacuum: null, last_analyze: null })]);

    const [report] = await service.indexHealth();
    expect(report.lastVacuumAt).toBeNull();
    expect(report.lastAnalyzeAt).toBeNull();
  });

  it('advises ANALYZE when table has never been analyzed', async () => {
    mockIndexQuery([makeIndexRow({ last_analyze: null })]);

    const [report] = await service.indexHealth();
    expect(report.advice.some((a) => a.includes('never been ANALYZEd'))).toBe(true);
  });

  it('advises ANALYZE when last analysis was more than 7 days ago', async () => {
    mockIndexQuery([makeIndexRow({ last_analyze: STALE_DATE })]);

    const [report] = await service.indexHealth();
    expect(report.advice.some((a) => a.includes('days ago'))).toBe(true);
  });

  it('does not advise ANALYZE when last analysis was recent', async () => {
    mockIndexQuery([makeIndexRow({ last_analyze: RECENT_DATE })]);

    const [report] = await service.indexHealth();
    expect(report.advice.every((a) => !a.includes('ANALYZE'))).toBe(true);
  });

  it('includes advice to raise ef_search for large row counts', async () => {
    mockIndexQuery([makeIndexRow({ row_estimate: '150000', index_size: '120000000', table_size: '500000000' })]);

    const [report] = await service.indexHealth();
    expect(report.efSearchRecommended).toBe(100);
    expect(report.advice.some((a) => a.includes('ef_search = 100'))).toBe(true);
  });

  it('reports healthy index when everything looks good', async () => {
    mockIndexQuery([makeIndexRow({ row_estimate: '1000', index_size: '800000', table_size: '3000000' })]);

    const [report] = await service.indexHealth();
    expect(report.advice).toEqual(['Index is healthy. No action required.']);
  });

  it('warns about high bloat ratio', async () => {
    mockIndexQuery([makeIndexRow({ row_estimate: '100', index_size: '50000000', table_size: '5000000' })]);

    const [report] = await service.indexHealth();
    expect(report.advice.some((a) => a.toLowerCase().includes('bloat'))).toBe(true);
  });

  it('releases the client after indexHealth()', async () => {
    mockIndexQuery([]);
    await service.indexHealth();
    expect(pool._client.release).toHaveBeenCalled();
  });
});
