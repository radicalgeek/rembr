import { describe, expect, it, vi } from 'vitest';
import { buildSemanticGroups, semanticRootGroupCount, SemanticClusterService } from './semantic-cluster-service.js';

function vector(x: number, y: number): number[] {
  return Array.from({ length: 12 }, (_, index) => index % 2 ? y : x);
}

describe('buildSemanticGroups', () => {
  it('forms cross-category groups from embedding proximity', () => {
    const groups = buildSemanticGroups([
      { id: '1', content: 'Orchard harvest schedule', category: 'facts', embedding: vector(1, 0) },
      { id: '2', content: 'Orchard harvest checklist', category: 'goals', embedding: vector(0.98, 0.02) },
      { id: '3', content: 'Harbour shipping schedule', category: 'facts', embedding: vector(0, 1) },
      { id: '4', content: 'Harbour shipping checklist', category: 'workflows', embedding: vector(0.02, 0.98) },
    ], 2, 'fixture-seed');

    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.items.map(item => item.id).sort())).toEqual(
      expect.arrayContaining([['1', '2'], ['3', '4']]),
    );
    expect(groups.every(group => Object.keys(group.categoryCounts).length === 2)).toBe(true);
  });

  it('returns stable groups for the same seed', () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      content: `Fixture topic ${index % 3}`,
      category: index % 2 ? 'facts' : 'goals',
      embedding: vector(index % 3, 3 - (index % 3)),
    }));

    const first = buildSemanticGroups(items, 3, 'stable-seed').map(group => group.items.map(item => item.id));
    const second = buildSemanticGroups(items, 3, 'stable-seed').map(group => group.items.map(item => item.id));
    expect(second).toEqual(first);
  });

  it('deduplicates memories and returns unique categorised labels', () => {
    const groups = buildSemanticGroups([
      { id: '1', content: 'Repeated fixture topic', category: 'facts', embedding: vector(1, 0) },
      { id: '2', content: '  repeated   fixture topic  ', category: 'facts', embedding: vector(1, 0) },
      { id: '3', content: 'Distinct fixture topic', category: 'goals', embedding: vector(0, 1) },
      { id: '4', content: 'Another fixture topic', category: 'facts', embedding: vector(0.5, 0.5) },
    ], 3, 'deduplicated-seed');

    expect(groups.flatMap(group => group.items.map(item => item.id))).toHaveLength(3);
    expect(groups.flatMap(group => group.items.map(item => item.id))).not.toContain('2');
    expect(new Set(groups.map(group => group.label.toLowerCase())).size).toBe(groups.length);
    expect(groups.every(group => group.label.includes(' / '))).toBe(true);
  });

  it('uses one root level with at most 50 topic bubbles for 100-memory graphs', () => {
    expect(semanticRootGroupCount(201)).toBe(2);
    expect(semanticRootGroupCount(7_000)).toBe(20);
    expect(semanticRootGroupCount(100_000)).toBe(50);
  });
});

describe('SemanticClusterService audience boundary', () => {
  const tenantId = '10000000-0000-4000-8000-000000000001';
  const projectId = '10000000-0000-4000-8000-000000000002';
  const userId = '10000000-0000-4000-8000-000000000003';
  const clusterId = '10000000-0000-4000-8000-000000000004';

  it('returns an empty semantic root when the audience has no embedded memories', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ count: 0, latest: null }] })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    const database = {
      dbPool: { connect: vi.fn().mockResolvedValue(client) },
      setTenantContext: vi.fn(),
    };
    const service = new SemanticClusterService(database as any);

    const view = await service.getView(tenantId);

    expect(view).toMatchObject({
      cluster: { level: 0, label: 'All memories', memory_count: 0, is_leaf: false },
      breadcrumbs: [],
      children: [],
      memories: [],
      total_children: 0,
    });
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('derives topic labels, counts, and centroids only from the authorised audience', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: clusterId,
      tenant_id: tenantId,
      parent_id: null,
      level: 1,
      label: 'Unscoped stored label',
      centroid: '[1,0]',
      memory_count: 2,
      category_counts: { facts: 2 },
      is_leaf: true,
      generated_at: new Date(),
      sample_contents: ['Orchard harvest schedule', 'Orchard harvest checklist'],
    }] });
    const service = new SemanticClusterService({ query } as any);

    const clusters = await (service as any).getAudienceClusters(
      tenantId, [clusterId], projectId, userId, 'orchard',
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0].label).not.toBe('Unscoped stored label');
    const [sql, params, scopedTenant] = query.mock.calls[0];
    expect(sql).toContain("COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $3::uuid");
    expect(sql).toContain("COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL");
    expect(sql).toContain('p.id IS NOT NULL');
    expect(sql).toContain('project_members pm');
    expect(sql).toContain('AVG(embedding)::text');
    expect(params).toEqual([tenantId, projectId, userId, [clusterId], 'orchard']);
    expect(scopedTenant).toBe(tenantId);
  });

  it('applies the same audience predicate before returning leaf memories', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new SemanticClusterService({ query } as any);

    await (service as any).getClusterMemories(tenantId, clusterId, projectId, userId, undefined);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("COALESCE(m.visibility, 'shared') = 'personal' AND m.user_id = $4::uuid");
    expect(sql).toContain("COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL");
    expect(sql).toContain('project_members pm');
    expect(sql).toContain('duplicate_rank = 1');
    expect(params).toEqual([clusterId, tenantId, projectId, userId, null]);
    expect(sql).toContain('LIMIT 100');
  });
});
