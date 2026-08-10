import { describe, expect, it, vi } from 'vitest';
import { TemporalQueryService } from './temporal-query-service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const MEMORY = '44444444-4444-4444-8444-444444444444';

function mockPool(handler?: (sql: string, params?: unknown[]) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const response = handler?.(sql, params);
    return response || { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  return {
    pool: {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const response = handler?.(sql, params);
        return response || { rows: [], rowCount: 0 };
      }),
    },
    client,
  };
}

function memorySqlCalls(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls.filter(([sql]) => /\bmemories\b/.test(String(sql)));
}

describe('TemporalQueryService audience isolation', () => {
  it('binds tenant, project and user scope for vector and non-vector temporal search', async () => {
    const { pool, client } = mockPool();
    const service = new TemporalQueryService(pool as any);

    await service.searchAtTime(TENANT, 'query', new Date('2026-01-01T00:00:00Z'), {
      embedding: [0.1, 0.2],
      projectId: PROJECT,
      userId: USER,
      category: 'facts',
      limit: 5,
    });

    const [sql, params] = memorySqlCalls(client.query)[0];
    expect(sql).toContain("m.user_id = $4::uuid");
    expect(sql).toContain('pm.project_id = p.id AND pm.user_id = $4::uuid');
    expect(sql).toContain('m.project_id = $3::uuid');
    expect(sql).not.toContain('search_memories_at_time');
    expect(params).toEqual(expect.arrayContaining([TENANT, PROJECT, USER, 'facts']));
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("set_config('app.current_tenant'"),
      [TENANT],
    );
  });

  it('scopes history to personal owners or explicit personal-project members', async () => {
    const { pool, client } = mockPool();
    const service = new TemporalQueryService(pool as any);

    await service.getMemoryHistory(TENANT, MEMORY, PROJECT, USER);

    const [sql, params] = memorySqlCalls(client.query)[0];
    expect(sql).toContain("m.user_id = $4::uuid");
    expect(sql).toContain('p.owner_id = $4::uuid');
    expect(sql).toContain('project_members pm');
    expect(params).toEqual([MEMORY, TENANT, PROJECT, USER]);
  });

  it('applies the same audience predicate to both sides of a comparison', async () => {
    const { pool, client } = mockPool();
    const service = new TemporalQueryService(pool as any);

    await service.compareSnapshots(
      TENANT,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-02-01T00:00:00Z'),
      PROJECT,
      USER,
    );

    const calls = memorySqlCalls(client.query);
    expect(calls).toHaveLength(2);
    for (const [sql, params] of calls) {
      expect(sql).toContain("m.user_id = $4::uuid");
      expect(sql).toContain('project_members pm');
      expect(params).toEqual(expect.arrayContaining([TENANT, PROJECT, USER]));
    }
  });

  it('does not mutate a rollback target when the audience recheck matches no row', async () => {
    const { pool, client } = mockPool((sql) => {
      if (sql.includes('SELECT m.*') && sql.includes('LIMIT 1')) {
        return {
          rows: [{
            id: MEMORY,
            valid_from: new Date('2025-12-01T00:00:00Z'),
            content: 'historic',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE memories')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    const service = new TemporalQueryService(pool as any);

    const result = await service.rollbackMemory(
      TENANT,
      MEMORY,
      new Date('2025-12-15T00:00:00Z'),
      PROJECT,
      USER,
    );

    expect(result).toBeNull();
    const update = client.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE memories'))!;
    expect(update[0]).toContain("m.user_id = $4::uuid");
    expect(update[0]).toContain('project_members pm');
    expect(update[1]).toEqual([MEMORY, TENANT, PROJECT, USER]);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO memories'))).toBe(false);
  });
});
