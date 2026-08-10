import { describe, expect, it, vi } from 'vitest';
import { AdvancedAnalyticsService } from './advanced-analytics-service.js';
import { CompilationService } from './compilation-service.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const contextId = '00000000-0000-4000-8000-000000000002';

function largeMemoryRows(count = 10_000) {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    content: 'x'.repeat(100_000),
    category: 'facts',
    metadata: { payload: 'y'.repeat(100_000) },
    created_at: new Date(1_700_000_000_000 - index),
    total_count: count,
  }));
}

describe('graph resource boundaries', () => {
  it('bounds advanced graph SQL, nodes, content and pair work for a 10k context', async () => {
    const query = vi.fn().mockResolvedValue({ rows: largeMemoryRows() });
    const service = new AdvancedAnalyticsService({ query } as any, {} as any);
    const edge = vi.spyOn(service as any, 'calculateMemoryEdge').mockResolvedValue(null);

    const graph = await service.generateContextGraph(tenantId, contextId, true);

    expect(graph.nodes).toHaveLength(100);
    expect(graph.nodes[0].content).toHaveLength(2_048);
    expect(graph.nodes[0].metadata).toEqual({});
    expect(edge).toHaveBeenCalledTimes(485);
    expect(graph).toMatchObject({ truncated: true, returned_count: 100, total_count: 10_000 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/LEFT\(m\.content, \$5::integer\)/);
    expect(sql).toMatch(/LIMIT \$6::integer/);
    expect(sql).toContain('c.project_id = m.project_id');
    expect(sql).toContain('cp.tenant_id = m.tenant_id');
    expect(sql).toContain('cp.is_personal = false');
    expect(params[5]).toBe(100);
  });

  it('bounds compilation graph reads, edges and tags even if a driver over-returns', async () => {
    const rows = largeMemoryRows();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: Array.from({ length: 2_000 }, (_, index) => ({
        id: `relationship-${index}`,
        source_memory_id: rows[0].id,
        target_memory_id: rows[1].id,
        confidence: 0.9,
      })) })
      .mockResolvedValueOnce({ rows: Array.from({ length: 2_000 }, (_, index) => ({
        id: `tag-${index}`,
        memory_id: rows[index % 100].id,
        tag: 'tag',
        confidence: 1,
      })) });
    const getContextMemories = vi.fn().mockResolvedValue(rows);
    const service = new CompilationService({ query, getContextMemories } as any);

    const graph = await service.getMemoryGraph(contextId, { tenant_id: tenantId });

    expect(graph.memories).toHaveLength(100);
    expect(graph.memories[0].content).toHaveLength(2_048);
    expect(graph.relationships).toHaveLength(500);
    expect(Object.values(graph.tags).flat()).toHaveLength(1_000);
    expect(graph).toMatchObject({ truncated: true, returned_count: 100, total_count: 10_000 });
    expect(getContextMemories).toHaveBeenCalledWith(contextId, tenantId, undefined, undefined, 100, 2_048, false);
    expect(query.mock.calls[0][0]).toMatch(/LIMIT \$2::integer/);
    expect(query.mock.calls[0][0]).toMatch(/LEFT\(evidence, \$3::integer\)/);
    expect(query.mock.calls[0][1]).toEqual([expect.any(Array), 500, 2_048]);
    expect(query.mock.calls[1][0]).toMatch(/tag_rank <= 10/);
    expect(query.mock.calls[1][0]).toMatch(/LIMIT \$2::integer/);
  });

  it('computes graph metrics from the bounded graph instead of returning placeholders', () => {
    const service = new AdvancedAnalyticsService({} as any, {} as any);
    const node = (id: string) => ({ id } as any);
    const nodes = ['a', 'b', 'c', 'isolated'].map(node);
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
      // Unknown endpoints and self-loops must not distort the result.
      { source: 'unknown', target: 'a' },
      { source: 'a', target: 'a' },
    ] as any;

    const metrics = (service as any).calculateGraphMetrics(nodes, edges);

    expect(metrics.connected_components).toBe(2);
    expect(metrics.avg_clustering_coefficient).toBe(0.75);
    expect(metrics.total_edges).toBe(3);
    expect(metrics.density).toBe(0.5);
    expect((service as any).countConnectedComponents([], [])).toBe(0);
  });
});
