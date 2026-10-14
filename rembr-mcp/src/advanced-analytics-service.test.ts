import { describe, expect, it, vi } from 'vitest';
import { AdvancedAnalyticsService } from './advanced-analytics-service.js';

describe('AdvancedAnalyticsService contradiction patterns', () => {
  it('detects one-sided negation over the same subject as a factual contradiction', async () => {
    const service = new AdvancedAnalyticsService({ query: async () => ({ rows: [] }) } as any, {} as any);

    const result = await (service as any).analyzeContradiction(
      {
        id: 'memory-a',
        content: 'The Rembr synthetic datastore uses PostgreSQL for durable memory storage.',
        category: 'facts',
        created_at: new Date('2026-07-05T07:00:00Z')
      },
      {
        id: 'memory-b',
        content: 'The Rembr synthetic datastore does not use PostgreSQL for durable memory storage.',
        category: 'facts',
        created_at: new Date('2026-07-05T07:01:00Z')
      }
    );

    expect(result).toMatchObject({
      contradiction_type: 'factual',
      severity: 'high'
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('does not flag unrelated one-sided negation as a contradiction', async () => {
    const service = new AdvancedAnalyticsService({ query: async () => ({ rows: [] }) } as any, {} as any);

    const result = await (service as any).analyzeContradiction(
      {
        id: 'memory-a',
        content: 'The Rembr datastore uses PostgreSQL for durable memory storage.',
        category: 'facts',
        created_at: new Date('2026-07-05T07:00:00Z')
      },
      {
        id: 'memory-b',
        content: 'The dashboard does not display invoices on the billing page.',
        category: 'facts',
        created_at: new Date('2026-07-05T07:01:00Z')
      }
    );

    expect(result).toBeNull();
  });
});

describe('AdvancedAnalyticsService context graph', () => {
  it('uses embedding cosine edges across memory categories', async () => {
    const memoryIds = [
      'a5d8463a-7e30-423d-8fc3-aede3d8ffd0c',
      'b5d8463a-7e30-423d-8fc3-aede3d8ffd0c'
    ];
    const query = vi.fn(async () => ({ rows: [
      { id: memoryIds[0], content: 'first', category: 'facts', created_at: new Date(), metadata: {} },
      { id: memoryIds[1], content: 'second', category: 'goals', created_at: new Date(), metadata: {} }
    ] }));
    const getEmbeddingSimilarityEdges = vi.fn(async () => [{
      source: memoryIds[0],
      target: memoryIds[1],
      similarity: 0.81
    }]);
    const service = new AdvancedAnalyticsService({ query, getEmbeddingSimilarityEdges } as any, {} as any);

    const graph = await service.generateContextGraph('tenant-1', undefined, true, undefined, undefined, 0.68, memoryIds);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('id = ANY($2::uuid[])'),
      ['tenant-1', memoryIds, null, 2048, 100],
      'tenant-1'
    );
    expect(getEmbeddingSimilarityEdges).toHaveBeenCalledWith('tenant-1', memoryIds, 0.68);
    expect(graph.edges).toEqual([{
      source: memoryIds[0],
      target: memoryIds[1],
      weight: 0.81,
      type: 'similarity',
      label: 'strong'
    }]);
    expect(graph.nodes.map(node => node.category)).toEqual(['facts', 'goals']);
  });
});
