import { describe, expect, it, vi } from 'vitest';
import {
  exploreAccessibleRelationshipGraph,
  MAX_RELATIONSHIP_GRAPH_BRANCHING,
  MAX_RELATIONSHIP_GRAPH_CONTENT_CHARS,
  MAX_RELATIONSHIP_GRAPH_EVIDENCE_CHARS,
  MAX_RELATIONSHIP_GRAPH_NODES,
} from './relationship-graph-service.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const memoryId = '00000000-0000-4000-8000-000000000004';

function makeHarness(startRows: any[], neighborRows: any[] = []) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('SELECT m.id, LEFT(m.content, $5::integer)')) return { rows: startRows };
    if (sql.includes('WITH RECURSIVE accessible_memory_ids')) return { rows: neighborRows };
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as any;
  return { pool, query, release };
}

describe('accessible relationship graph traversal', () => {
  it('applies the canonical audience predicate to the seed, every edge endpoint and returned evidence', async () => {
    const neighbors = Array.from({ length: MAX_RELATIONSHIP_GRAPH_NODES + 5 }, (_, index) => ({
      id: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`,
      content: 'c'.repeat(MAX_RELATIONSHIP_GRAPH_CONTENT_CHARS + 100),
      category: 'facts',
      created_at: new Date(),
      depth: 1,
      relationship_type: 'supports',
      confidence: '0.9',
      evidence: 'e'.repeat(MAX_RELATIONSHIP_GRAPH_EVIDENCE_CHARS + 100),
      connected_to: memoryId,
    }));
    const { pool, query, release } = makeHarness([{
      id: memoryId,
      content: 'seed',
      category: 'facts',
      created_at: new Date(),
    }], neighbors);

    const result = await exploreAccessibleRelationshipGraph(
      pool,
      { tenantId, projectId, userId },
      { memoryId, depth: 3, minConfidence: 0.75, relationshipTypes: ['supports'] },
    );

    expect(result).not.toBeNull();
    expect(result!.neighbors).toHaveLength(MAX_RELATIONSHIP_GRAPH_NODES);
    expect(result!.truncated).toBe(true);
    expect(result!.neighbors[0].content).toHaveLength(MAX_RELATIONSHIP_GRAPH_CONTENT_CHARS);
    expect(result!.neighbors[0].evidence).toHaveLength(MAX_RELATIONSHIP_GRAPH_EVIDENCE_CHARS);
    expect(release).toHaveBeenCalledOnce();

    const startCall = query.mock.calls.find(([sql]) => String(sql).includes('LEFT(m.content, $5::integer'))!;
    expect(startCall[0]).toContain('m.tenant_id = $2::uuid');
    expect(startCall[0]).toContain('m.project_id = $3::uuid');
    expect(startCall[0]).toContain("m.visibility, 'shared') = 'personal'");
    expect(startCall[0]).toContain('project_members');
    expect(startCall[1]).toEqual([
      memoryId,
      tenantId,
      projectId,
      userId,
      MAX_RELATIONSHIP_GRAPH_CONTENT_CHARS,
    ]);

    const traversalCall = query.mock.calls.find(([sql]) => String(sql).includes('WITH RECURSIVE accessible_memory_ids'))!;
    const traversalSql = String(traversalCall[0]);
    expect(traversalSql).toContain('accessible_memory_ids AS NOT MATERIALIZED');
    expect(traversalSql).toContain('JOIN accessible_memory_ids source_memory ON source_memory.id = mr.source_memory_id');
    expect(traversalSql).toContain('JOIN accessible_memory_ids target_memory ON target_memory.id = mr.target_memory_id');
    expect(traversalSql).toContain('JOIN LATERAL (');
    expect(traversalSql).toContain('LIMIT $9::integer');
    expect(traversalSql).toContain('LEFT(mr.evidence, $11::integer)');
    expect(traversalSql).not.toContain('LEFT JOIN LATERAL');
    expect(traversalCall[1][4]).toBe(projectId);
    expect(traversalCall[1][5]).toBe(userId);
    expect(traversalCall[1][8]).toBe(MAX_RELATIONSHIP_GRAPH_BRANCHING);
    expect(traversalCall[1][9]).toBe(MAX_RELATIONSHIP_GRAPH_NODES + 1);
  });

  it('rejects an inaccessible seed before relationship traversal', async () => {
    const { pool, query, release } = makeHarness([]);

    await expect(exploreAccessibleRelationshipGraph(
      pool,
      { tenantId, projectId, userId },
      { memoryId },
    )).resolves.toBeNull();

    expect(query.mock.calls.some(([sql]) => String(sql).includes('WITH RECURSIVE accessible_memory_ids'))).toBe(false);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
