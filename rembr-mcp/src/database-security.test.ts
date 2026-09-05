import { describe, expect, it, vi } from 'vitest';
import { MemoryDatabase, normaliseMetadataFilter } from './database.js';

describe('MemoryDatabase metadata filter binding', () => {
  it('rejects unsafe keys at the internal database boundary', () => {
    expect(() => normaliseMetadataFilter({ "x') OR TRUE --": 'value' }))
      .toThrow('Invalid metadata filter key');
    expect(() => normaliseMetadataFilter({ nested: { value: 'no' } }))
      .toThrow('must be a scalar');
  });

  it('binds the complete filter as JSONB without interpolating values into SQL', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM memories m')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const db = Object.create(MemoryDatabase.prototype) as any;
    db.pool = { connect: vi.fn(async () => client) };
    db.readPool = null;
    const attackerValue = "x'); DROP TABLE memories; --";

    await db.searchMemories(
      '550e8400-e29b-41d4-a716-446655440000',
      'deployment',
      undefined,
      10,
      false,
      { 'project.tag': attackerValue },
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );

    const searchCall = client.query.mock.calls.find(([sql]) => String(sql).includes('FROM memories m'))!;
    const sql = String(searchCall[0]);
    const params = searchCall[1] as unknown[];
    expect(sql).toContain('m.metadata @>');
    expect(sql).not.toContain(attackerValue);
    expect(params).toContain(JSON.stringify({ 'project.tag': attackerValue }));
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('MemoryDatabase atomic storage and search quotas', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const projectId = '22222222-2222-4222-8222-222222222222';

  it('serialises concurrent memory inserts so only the final quota slot is spent', async () => {
    let storedItems = 1;
    let lockTail = Promise.resolve();
    let inserted = 0;

    const makeClient = () => {
      let releaseLock: (() => void) | undefined;
      return {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('pg_advisory_xact_lock')) {
            const prior = lockTail;
            lockTail = new Promise<void>(resolve => { releaseLock = resolve; });
            await prior;
            expect(params).toEqual([`storage-quota:${tenantId}`]);
            return { rows: [{ pg_advisory_xact_lock: null }] };
          }
          if (sql.includes('FROM tenant_plans')) return { rows: [{ memory_limit: 2 }] };
          if (sql.includes('AS stored_items')) return { rows: [{ stored_items: storedItems }] };
          if (sql.includes('INSERT INTO memories')) {
            inserted++;
            storedItems++;
            return {
              rows: [{
                id: params?.[0], tenant_id: tenantId, project_id: projectId,
                content: params?.[4], category: params?.[5], metadata: '{}',
              }],
            };
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') releaseLock?.();
          return { rows: [] };
        }),
        release: vi.fn(),
      };
    };

    const db = Object.create(MemoryDatabase.prototype) as any;
    db.pool = { connect: vi.fn(async () => makeClient()) };
    db.readPool = null;
    const write = (id: string) => db.createMemory(
      id, tenantId, projectId, 'bounded', 'general', {}, 1, undefined, undefined,
    );

    const outcomes = await Promise.allSettled([
      write('11111111-1111-4111-8111-111111111111'),
      write('33333333-3333-4333-8333-333333333333'),
    ]);

    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(inserted).toBe(1);
    expect(storedItems).toBe(2);
    expect(String((outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult).reason))
      .toContain('Memory limit reached');
  });

  it('atomically reserves one search and repairs nullable-project accounting', async () => {
    let searches = 1;
    let lockTail = Promise.resolve();
    let reservations = 0;

    const makeClient = () => {
      let releaseLock: (() => void) | undefined;
      return {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('pg_advisory_xact_lock')) {
            const prior = lockTail;
            lockTail = new Promise<void>(resolve => { releaseLock = resolve; });
            await prior;
            expect(params).toEqual([`search-quota:${tenantId}`]);
            return { rows: [] };
          }
          if (sql.includes('FROM tenant_plans')) return { rows: [{ search_limit_daily: 2 }] };
          if (sql.includes('SUM(searches_performed)')) return { rows: [{ searches }] };
          if (sql.includes('FROM usage_daily') && sql.includes('IS NOT DISTINCT FROM')) {
            expect(params).toEqual([tenantId, null]);
            return { rows: [{ id: '44444444-4444-4444-8444-444444444444' }] };
          }
          if (sql.includes('UPDATE usage_daily')) {
            searches++;
            reservations++;
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') releaseLock?.();
          return { rows: [] };
        }),
        release: vi.fn(),
      };
    };

    const db = Object.create(MemoryDatabase.prototype) as any;
    db.pool = { connect: vi.fn(async () => makeClient()) };
    db.readPool = null;

    const outcomes = await Promise.allSettled([
      db.reserveSearchQuota(tenantId),
      db.reserveSearchQuota(tenantId),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(reservations).toBe(1);
    expect(searches).toBe(2);
  });

  it('does not increment usage inside semantic search after the shared reservation', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM memories m')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const db = Object.create(MemoryDatabase.prototype) as any;
    db.pool = { connect: vi.fn(async () => client) };
    db.readPool = null;

    await db.semanticSearch(tenantId, projectId, [0.1, 0.2], 5, undefined, undefined,
      '11111111-1111-4111-8111-111111111111');

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO usage_daily')))
      .toBe(false);
  });
});
