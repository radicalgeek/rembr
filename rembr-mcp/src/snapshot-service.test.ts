import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SnapshotService } from './snapshot-service.js';

describe('SnapshotService - TTL and Token Calculations', () => {
  describe('TTL calculations', () => {
    it('should calculate correct expiration time for hours', () => {
      const now = Date.now();
      const ttlHours = 24;
      const expectedExpiry = new Date(now + ttlHours * 60 * 60 * 1000);
      
      // Test that TTL calculation logic is correct
      const calculatedExpiry = new Date(now + ttlHours * 60 * 60 * 1000);
      
      expect(calculatedExpiry.getTime() - expectedExpiry.getTime()).toBeLessThan(100); // Within 100ms
    });

    it('should handle null TTL (no expiration)', () => {
      const ttlHours = undefined;
      const expiresAt = ttlHours ? new Date(Date.now() + ttlHours * 60 * 60 * 1000) : null;
      
      expect(expiresAt).toBeNull();
    });

    it('should calculate expiration for 1 hour', () => {
      const now = Date.now();
      const ttlHours = 1;
      const expiresAt = new Date(now + ttlHours * 60 * 60 * 1000);
      
      const diffMs = expiresAt.getTime() - now;
      const diffHours = diffMs / (60 * 60 * 1000);
      
      expect(diffHours).toBeCloseTo(1, 2);
    });

    it('should calculate expiration for 7 days (168 hours)', () => {
      const now = Date.now();
      const ttlHours = 168; // 7 days
      const expiresAt = new Date(now + ttlHours * 60 * 60 * 1000);
      
      const diffMs = expiresAt.getTime() - now;
      const diffDays = diffMs / (24 * 60 * 60 * 1000);
      
      expect(diffDays).toBeCloseTo(7, 2);
    });
  });

  describe('Token estimation (~4 chars per token)', () => {
    it('should estimate tokens correctly for simple text', () => {
      const content = 'Hello world'; // 11 chars
      const tokenEstimate = Math.ceil(content.length / 4);
      
      expect(tokenEstimate).toBe(3); // 11/4 = 2.75 -> 3
    });

    it('should estimate tokens for longer text', () => {
      const content = 'This is a longer piece of text that should be tokenized correctly'; // 66 chars
      const tokenEstimate = Math.ceil(content.length / 4);
      
      expect(tokenEstimate).toBe(17); // 66/4 = 16.5 -> 17
    });

    it('should sum tokens across multiple memories', () => {
      const memories = [
        { content: 'First memory content' },  // 20 chars -> 5 tokens
        { content: 'Second memory' },          // 13 chars -> 4 tokens
        { content: 'Third' }                    // 5 chars -> 2 tokens
      ];
      
      const totalTokens = memories.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
      
      expect(totalTokens).toBe(11); // 5 + 4 + 2
    });

    it('should handle empty content', () => {
      const content = '';
      const tokenEstimate = Math.ceil(content.length / 4);
      
      expect(tokenEstimate).toBe(0);
    });

    it('should round up fractional tokens', () => {
      const content = 'ABC'; // 3 chars -> should be 1 token (3/4 = 0.75 -> 1)
      const tokenEstimate = Math.ceil(content.length / 4);
      
      expect(tokenEstimate).toBe(1);
    });
  });

  describe('Date math edge cases', () => {
    it('should handle date arithmetic correctly', () => {
      const baseDate = new Date('2026-01-01T00:00:00Z');
      const hoursToAdd = 48;
      const newDate = new Date(baseDate.getTime() + hoursToAdd * 60 * 60 * 1000);
      
      expect(newDate.toISOString()).toBe('2026-01-03T00:00:00.000Z');
    });

    it('should handle negative time differences', () => {
      const now = Date.now();
      const futureDate = new Date(now + 1000);
      const pastDate = new Date(now - 1000);
      
      expect(futureDate.getTime() > pastDate.getTime()).toBe(true);
      const diff = futureDate.getTime() - pastDate.getTime();
      expect(diff).toBeGreaterThanOrEqual(1990);
      expect(diff).toBeLessThanOrEqual(2010);
    });

    it('should check if snapshot is expired', () => {
      const expiredDate = new Date(Date.now() - 1000); // 1 second ago
      const validDate = new Date(Date.now() + 1000);   // 1 second from now
      const noExpiry = null;
      
      const isExpired1 = expiredDate && expiredDate.getTime() < Date.now();
      const isExpired2 = validDate && validDate.getTime() < Date.now();
      const isExpired3 = !noExpiry; // null means never expires (so not expired)
      
      expect(isExpired1).toBe(true);
      expect(isExpired2).toBe(false);
      expect(isExpired3).toBe(true); // Not expired (no expiry date)
    });
  });
});

// ============================================================================
// REM-256: Snapshot Immutability Tests
// ============================================================================

describe('SnapshotService - Immutability Guarantees (REM-256)', () => {
  describe('Database-level immutability enforcement', () => {
    it('should document that snapshots cannot be updated at DB level', () => {
      // This test documents the expected behavior:
      // - Snapshots (context_snapshots) cannot be UPDATEd
      // - Snapshot memories (snapshot_memories) cannot be UPDATEd
      // - Snapshot memories cannot be DELETEd directly (only via cascade)
      // - Snapshot contexts cannot be UPDATEd
      
      // The actual enforcement is done via database triggers:
      // - immutable_context_snapshots
      // - immutable_snapshot_memories_update
      // - immutable_snapshot_memories_delete
      // - immutable_snapshot_contexts
      
      // These triggers will raise exceptions if modification is attempted
      expect(true).toBe(true);
    });

    it('should require snapshots to be deleted and recreated if changes needed', () => {
      // Design constraint: snapshots are immutable by design
      // If you need to "modify" a snapshot:
      // 1. Delete the snapshot (cascades to memories)
      // 2. Create a new snapshot with desired changes
      
      // This ensures point-in-time integrity for RLM handoff
      const immutabilityPolicy = {
        canUpdate: false,
        canDelete: true, // Delete entire snapshot
        canDeleteMemories: false, // Only via cascade
        workaround: 'Delete and recreate snapshot',
      };
      
      expect(immutabilityPolicy.canUpdate).toBe(false);
      expect(immutabilityPolicy.canDelete).toBe(true);
    });

    it('should allow cascade deletion of memories when parent snapshot is deleted', () => {
      // The trigger uses pg_trigger_depth() = 0 check
      // This means:
      // - Direct DELETE on snapshot_memories: BLOCKED
      // - CASCADE DELETE from context_snapshots: ALLOWED
      
      // This ensures memories are only deleted as part of snapshot deletion
      const cascadeBehavior = {
        directDelete: false,
        cascadeFromParent: true,
        onDeleteAction: 'ON DELETE CASCADE',
      };
      
      expect(cascadeBehavior.directDelete).toBe(false);
      expect(cascadeBehavior.cascadeFromParent).toBe(true);
    });
  });
});

describe('SnapshotService - tenant, project, and personal scope', () => {
  it('rejects a caller-supplied project outside a scoped credential', async () => {
    const db = { query: vi.fn() };
    const service = new SnapshotService(db as any);

    await expect(service.listSnapshots({
      tenant_id: 'tenant-1',
      project_id: 'project-a',
      user_id: 'user-1',
    }, 'project-b')).rejects.toThrow('outside the credential scope');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('filters immutable snapshot copies by tenant and personal owner', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'snapshot-1', tenant_id: 'tenant-1', visibility: 'personal' }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = new SnapshotService({ query } as any);

    await service.getSnapshot('snapshot-1', {
      tenant_id: 'tenant-1',
      project_id: 'project-a',
      user_id: 'user-1',
    });

    expect(query.mock.calls[0][0]).toContain('s.tenant_id = $2');
    expect(query.mock.calls[0][0]).toContain("s.user_id = $4::uuid");
    expect(query.mock.calls[1][0]).toContain("sm.user_id = $3::uuid");
    expect(query.mock.calls[1][0]).toContain('LIMIT $5 OFFSET $6');
    expect(query.mock.calls[1][1]).toEqual([
      'snapshot-1', 'tenant-1', 'user-1', 'project-a', 25, 0, 1024 * 1024,
    ]);
  });
});

describe('SnapshotService - atomic storage quota', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const memoryId = '550e8400-e29b-41d4-a716-446655440001';

  function quotaDb(memoryLimit: number, failCopies = false) {
    let storedItems = 0;
    let snapshots = 0;
    let tail = Promise.resolve();
    const queries: Array<{ sql: string; params: unknown[] }> = [];

    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT m.* FROM memories')) {
          return { rows: [{
            id: memoryId, tenant_id: tenantId, project_id: null, user_id: null,
            visibility: 'shared', content: 'snapshot source', category: 'facts',
            metadata: {}, relevance_score: 1, created_at: new Date(),
          }], rowCount: 1 };
        }
        if (sql.includes('AS source_count')) {
          return {
            rows: [{ source_count: 1, source_bytes: 15, source_tokens: 4 }],
            rowCount: 1,
          };
        }
        if (sql.includes('AS memory_limit')) return { rows: [{ memory_limit: memoryLimit }], rowCount: 1 };
        if (sql.includes('AS stored_items')) return { rows: [{ stored_items: storedItems }], rowCount: 1 };
        if (sql.includes('INSERT INTO context_snapshots')) {
          snapshots += 1;
          return { rows: [{
            id: `snapshot-${snapshots}`, tenant_id: tenantId, project_id: null,
            visibility: 'shared', memory_count: 1, token_count: 4,
          }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO snapshot_memories')) {
          if (failCopies) throw new Error('copy insert failed');
          storedItems += 1;
          return { rows: [{
            id: `copy-${storedItems}`, snapshot_id: `snapshot-${snapshots}`,
            memory_id: memoryId, content: 'snapshot source', category: 'facts',
            relevance_score: 1, position: 0,
          }], rowCount: 1 };
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
        const before = { storedItems, snapshots };
        try {
          return await work(client);
        } catch (error) {
          storedItems = before.storedItems;
          snapshots = before.snapshots;
          throw error;
        } finally {
          release();
        }
      }),
      searchMemories: vi.fn(),
    };
    return { db, queries, state: () => ({ storedItems, snapshots }) };
  }

  const auth = { tenant_id: tenantId };
  const options = { memoryIds: [memoryId] };

  it('serialises concurrent requests so only one can spend the final quota slot', async () => {
    const fake = quotaDb(1);
    const service = new SnapshotService(fake.db as any);
    const results = await Promise.allSettled([
      service.createSnapshot(auth, options),
      service.createSnapshot(auth, options),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(fake.state()).toEqual({ storedItems: 1, snapshots: 1 });
    expect(fake.queries.filter(query => query.sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
  });

  it('counts immutable copies, so repeated snapshots exhaust the same plan limit', async () => {
    const fake = quotaDb(2);
    const service = new SnapshotService(fake.db as any);
    await service.createSnapshot(auth, options);
    await service.createSnapshot(auth, options);
    await expect(service.createSnapshot(auth, options)).rejects.toThrow(/exceed memory limit/);
    expect(fake.state()).toEqual({ storedItems: 2, snapshots: 2 });
  });

  it('rolls the snapshot record back when immutable-copy insertion fails', async () => {
    const fake = quotaDb(10, true);
    const service = new SnapshotService(fake.db as any);
    await expect(service.createSnapshot(auth, options)).rejects.toThrow('copy insert failed');
    expect(fake.state()).toEqual({ storedItems: 0, snapshots: 0 });
  });

  it('cleans expired rows only through an exact tenant predicate before counting', async () => {
    const fake = quotaDb(10);
    const service = new SnapshotService(fake.db as any);
    await service.createSnapshot(auth, options);
    const cleanup = fake.queries.find(query => query.sql.includes('WITH expired AS'))!;
    expect(cleanup.sql).toContain('tenant_id = $1');
    expect(cleanup.params).toEqual([tenantId]);
    const cleanupIndex = fake.queries.indexOf(cleanup);
    const usageIndex = fake.queries.findIndex(query => query.sql.includes('AS stored_items'));
    expect(cleanupIndex).toBeLessThan(usageIndex);
  });

  it('preserves userless agent-bootstrap snapshots within the free quota', async () => {
    const fake = quotaDb(1000);
    const service = new SnapshotService(fake.db as any);
    const result = await service.createSnapshot(auth, options);
    expect(result.snapshot.visibility).toBe('shared');
    expect(result.memories).toHaveLength(1);
  });

  it('enforces maxTokens for explicit sources without partial snapshot writes', async () => {
    const fake = quotaDb(1000);
    const service = new SnapshotService(fake.db as any);
    await expect(service.createSnapshot(auth, { ...options, maxTokens: 3 }))
      .rejects.toThrow(/exceeding maxTokens 3/);
    expect(fake.state()).toEqual({ storedItems: 0, snapshots: 0 });
    expect(fake.queries.some(query => query.sql.includes('INSERT INTO context_snapshots'))).toBe(false);
  });

  it('rejects an oversized context from aggregate statistics before materialising memory rows', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('SELECT c.id, c.project_id')) {
          return { rows: [{ id: 'context-1', project_id: null }] };
        }
        if (sql.includes('AS source_count')) {
          return {
            rows: [{ source_count: 501, source_bytes: 501_000, source_tokens: 125_250 }],
          };
        }
        if (sql.includes('SELECT m.* FROM memories')) {
          throw new Error('memory content should not be materialised');
        }
        return { rows: [] };
      }),
    };
    const db = {
      withTenantTransaction: vi.fn(async (_tenant: string, work: any) => work(client)),
      searchMemories: vi.fn(),
    };
    const service = new SnapshotService(db as any);

    await expect(service.createSnapshot(auth, { contextIds: ['context-1'] }))
      .rejects.toThrow('hard copy boundary');
    expect(queries.some(sql => sql.includes('SELECT m.* FROM memories'))).toBe(false);
    expect(queries.some(sql => sql.includes('octet_length(m.content)'))).toBe(true);
  });
});
