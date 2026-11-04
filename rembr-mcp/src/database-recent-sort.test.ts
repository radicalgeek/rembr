import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDatabase } from './database.js';

describe('MemoryDatabase.getRecentMemories ordering', () => {
  let db: MemoryDatabase | undefined;

  afterEach(async () => {
    await db?.dbPool.end();
  });

  function setup() {
    db = new MemoryDatabase('postgresql://unused:unused@localhost/unused');
    const query = vi.fn(async (sql: string) => ({ rows: [] }));
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => undefined) };
    (db as any).pool = pool;
    (db as any).readPool = null;
    return { db, query };
  }

  function findSelect(query: ReturnType<typeof vi.fn>) {
    return query.mock.calls.find(([sql]) => (sql as string).startsWith('SELECT m.* FROM memories'))!;
  }

  it('preserves insertion-time ordering by default', async () => {
    const { db, query } = setup();
    await db.getRecentMemories('tenant-1', 2, 'facts');

    const select = findSelect(query);
    expect(select[0]).toContain('AND m.category = $3 ORDER BY m.created_at DESC, m.id DESC LIMIT $4 OFFSET $5');
    expect(select[1]).toEqual(['tenant-1', null, 'facts', 2, 0]);
  });

  it('uses a guarded effective timestamp before applying the limit', async () => {
    const { db, query } = setup();
    await db.getRecentMemories('tenant-1', 50, undefined, undefined, undefined, 'source_created_at');

    const select = findSelect(query);
    expect(select[0]).toContain("pg_input_is_valid(m.metadata->>'source_created_at', 'timestamptz')");
    expect(select[0]).toContain("THEN (m.metadata->>'source_created_at')::timestamptz");
    expect(select[0]).toContain('ELSE m.created_at');
    expect(select[0]).toContain('END DESC, m.created_at DESC, m.id DESC LIMIT $3 OFFSET $4');
    expect(select[1]).toEqual(['tenant-1', null, 50, 0]);
  });
});
