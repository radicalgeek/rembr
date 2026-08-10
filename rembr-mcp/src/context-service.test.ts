import { describe, expect, it, vi } from 'vitest';
import { ContextService } from './context-service.js';

describe('ContextService atomic context quota', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const projectId = '550e8400-e29b-41d4-a716-446655440001';

  function contextDb(initialCount: number, plan = 'free') {
    let count = initialCount;
    let tail = Promise.resolve();
    const txQueries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        txQueries.push(sql);
        if (sql.includes('SELECT 1 FROM projects')) return { rows: [{ allowed: 1 }] };
        if (sql.includes("LOWER(COALESCE(plan")) return { rows: [{ plan }] };
        if (sql.includes('AS context_count')) return { rows: [{ context_count: count }] };
        if (sql.includes('INSERT INTO contexts')) {
          count += 1;
          return { rows: [{
            id: params[0], project_id: params[1], name: params[2],
            description: params[3], category: params[4],
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: projectId }] }),
      getTenantPlan: vi.fn(),
      getProjectCount: vi.fn(),
      withTenantTransaction: vi.fn(async (_tenant: string, work: (tx: typeof client) => Promise<any>) => {
        let release!: () => void;
        const previous = tail;
        tail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await work(client); } finally { release(); }
      }),
    };
    return { db, txQueries, count: () => count };
  }

  it('uses a dedicated context limit independent of the project count', async () => {
    const fake = contextDb(99);
    const service = new ContextService(tenantId, projectId, fake.db as any, undefined);
    await expect(service.createContext('agent work')).resolves.toMatchObject({ name: 'agent work' });
    expect(fake.db.getProjectCount).not.toHaveBeenCalled();
    expect(fake.db.getTenantPlan).not.toHaveBeenCalled();
    expect(fake.count()).toBe(100);
  });

  it('fails closed when the free-plan context storage limit is exhausted', async () => {
    const fake = contextDb(100);
    const service = new ContextService(tenantId, projectId, fake.db as any);
    await expect(service.createContext('one too many')).rejects.toThrow('Context limit reached (100 contexts)');
    expect(fake.txQueries.some(sql => sql.includes('INSERT INTO contexts'))).toBe(false);
  });

  it('serialises concurrent creates so only one spends the last slot', async () => {
    const fake = contextDb(99);
    const service = new ContextService(tenantId, projectId, fake.db as any);
    const results = await Promise.allSettled([
      service.createContext('first'),
      service.createContext('second'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(fake.count()).toBe(100);
    expect(fake.txQueries.filter(sql => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
  });

  it('preserves userless autonomous-agent creation within its quota', async () => {
    const fake = contextDb(0);
    const service = new ContextService(tenantId, projectId, fake.db as any);
    await expect(service.createContext('bootstrap context')).resolves.toMatchObject({
      project_id: projectId,
      name: 'bootstrap context',
    });
  });

  it('passes a bounded context-list limit through the verified project scope', async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: projectId }] }),
      listContexts: vi.fn().mockResolvedValue([]),
    };
    const service = new ContextService(tenantId, projectId, db as any);

    await service.listContexts('facts', 100);

    expect(db.listContexts).toHaveBeenCalledWith(projectId, tenantId, 'facts', 100);
    expect(db.query.mock.calls[0][0]).toContain('project_members');
  });

  it('converges concurrent default hierarchy creation and charges the context quota once', async () => {
    let storedProject: string | undefined;
    let storedContext: string | undefined;
    let contextCount = 0;
    let tail = Promise.resolve();
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        queries.push(sql);
        if (sql.includes('SELECT id FROM projects')) {
          return { rows: storedProject ? [{ id: storedProject }] : [] };
        }
        if (sql.includes('INSERT INTO projects')) {
          storedProject = params[0];
          return { rows: [{ id: storedProject }], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM contexts')) {
          return { rows: storedContext ? [{ id: storedContext }] : [] };
        }
        if (sql.includes("LOWER(COALESCE(plan")) return { rows: [{ plan: 'free' }] };
        if (sql.includes('AS context_count')) return { rows: [{ context_count: contextCount }] };
        if (sql.includes('INSERT INTO contexts')) {
          storedContext = params[0];
          contextCount += 1;
          return { rows: [{ id: storedContext }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const db = {
      withTenantTransaction: vi.fn(async (_tenant: string, work: (tx: typeof client) => Promise<any>) => {
        let release!: () => void;
        const previous = tail;
        tail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await work(client); } finally { release(); }
      }),
    };
    const service = new ContextService(tenantId, undefined, db as any);

    const [first, second] = await Promise.all([service.ensureDefaults(), service.ensureDefaults()]);
    expect(first).toEqual(second);
    expect(contextCount).toBe(1);
    expect(queries.filter(sql => sql.includes('INSERT INTO projects'))).toHaveLength(1);
    expect(queries.filter(sql => sql.includes('INSERT INTO contexts'))).toHaveLength(1);
    expect(queries.some(sql => sql.includes('default-hierarchy:'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      [`default-hierarchy:${tenantId}`],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      [`context-quota:${tenantId}`],
    );
  });
});
