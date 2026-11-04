import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDatabase } from './database.js';

describe('MemoryDatabase.getEmbeddingSimilarityEdges', () => {
  let db: MemoryDatabase | undefined;

  afterEach(async () => {
    await db?.dbPool.end();
  });

  it('computes tenant-scoped cosine edges for the requested memory IDs', async () => {
    db = new MemoryDatabase('postgresql://unused:unused@localhost/unused');
    const ids = [
      'a5d8463a-7e30-423d-8fc3-aede3d8ffd0c',
      'b5d8463a-7e30-423d-8fc3-aede3d8ffd0c'
    ];
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('AS similarity')
        ? [{ source: ids[0], target: ids[1], similarity: '0.81234' }]
        : []
    }));
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => undefined) };
    (db as any).pool = pool;
    (db as any).readPool = null;

    const edges = await db.getEmbeddingSimilarityEdges('tenant-1', ids, 0.68);

    const select = query.mock.calls.find(([sql]) => sql.includes('AS similarity'))!;
    expect(select[0]).toContain('1 - (e1.embedding <=> e2.embedding)');
    expect(select[0]).toContain('m1.tenant_id = $1');
    expect(select[0]).toContain('m2.tenant_id = $1');
    expect(select[0]).toContain('e1.memory_id = ANY($2::uuid[])');
    expect(select[1]).toEqual(['tenant-1', ids, 0.68]);
    expect(edges).toEqual([{ source: ids[0], target: ids[1], similarity: 0.81234 }]);
    expect(client.release).toHaveBeenCalled();
  });
});
