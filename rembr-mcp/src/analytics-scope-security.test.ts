import { describe, expect, it, vi } from 'vitest';
import { MemoryService } from './memory-service.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const projectId = '10000000-0000-4000-8000-000000000002';
const userId = '10000000-0000-4000-8000-000000000003';

function statsDb(searches = 7) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('COUNT(e.memory_id)')) {
      return { rows: [{ total: 3_000, indexed: 2_900 }] };
    }
    if (sql.includes('GROUP BY m.category')) {
      return { rows: [{ category: 'facts', count: 2_500 }] };
    }
    return { rows: [] };
  });
  return {
    query,
    getTenantPlan: vi.fn().mockResolvedValue({
      plan: 'free', memory_limit: 10_000, search_limit_daily: 10_000,
    }),
    getTodaySearchCount: vi.fn().mockResolvedValue(searches),
  };
}

describe('scoped memory analytics', () => {
  it('reports exact authorised category totals without exposing tenant search usage to a human read principal', async () => {
    const db = statsDb();
    const service = new MemoryService(tenantId, undefined, db as any, undefined, userId);

    const stats = await service.getStats(false);

    expect(stats).toMatchObject({
      total_memories: 3_000,
      searches_today: null,
      searches_today_scope: 'unavailable',
      scope: 'authorised_audience',
    });
    expect(stats.by_category.facts).toBe(2_500);
    expect(db.getTodaySearchCount).not.toHaveBeenCalled();

    const categorySql = db.query.mock.calls.find(([sql]) => sql.includes('GROUP BY m.category'))?.[0] as string;
    expect(categorySql).toContain("COALESCE(m.visibility, 'shared') = 'shared' AND m.project_id IS NULL");
    expect(categorySql).toContain('p.id IS NOT NULL');
    expect(categorySql).toContain('project_members');
    expect(categorySql).not.toContain('LIMIT 1000');
  });

  it('uses the exact project key for project-scoped search counters', async () => {
    const db = statsDb(11);
    const service = new MemoryService(tenantId, projectId, db as any, undefined, userId);

    const stats = await service.getStats(false);

    expect(stats.searches_today).toBe(11);
    expect(stats.searches_today_scope).toBe('project');
    expect(db.getTodaySearchCount).toHaveBeenCalledWith(tenantId, projectId);
  });

  it('bounds domain analysis at SQL and denies malformed project-visible legacy rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ content: 'API architecture', category: 'facts' }] });
    const service = new MemoryService(tenantId, projectId, { query } as any, undefined, userId);

    const insights = await service.getMemoryInsights('domains', 30);

    expect(insights).toMatchObject({ total_analyzed: 1, dominant_domain: 'software_engineering' });
    const [sql, params, scopedTenant] = query.mock.calls[0];
    expect(sql).toContain('LEFT(m.content, $5::integer)');
    expect(sql).toContain('LIMIT 100');
    expect(sql).toContain('p.id IS NOT NULL');
    expect(sql).toContain("m.visibility, 'shared') = 'shared' AND m.project_id IS NULL");
    expect(params[4]).toBe(2_048);
    expect(scopedTenant).toBe(tenantId);
  });

  it('requires both relationship endpoints to satisfy the canonical audience predicate', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ relationship_type: 'supports', count: '2', avg_confidence: '0.8' }] });
    const service = new MemoryService(tenantId, projectId, { query } as any, undefined, userId);

    await service.getMemoryInsights('relationships', 30);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("COALESCE(ms.visibility, 'shared') = 'shared' AND ms.project_id IS NULL");
    expect(sql).toContain("COALESCE(mt.visibility, 'shared') = 'shared' AND mt.project_id IS NULL");
    expect(sql).toContain('ps.id IS NOT NULL');
    expect(sql).toContain('pt.id IS NOT NULL');
    expect(sql).toContain('LIMIT 100');
  });
});
