/**
 * Tests for Context Snapshot Timeline (REM-34)
 */
import { describe, it, expect, vi } from 'vitest';
import { ContextSnapshotTimelineService } from './context-snapshot-timeline.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TENANT = 'tenant-001';

function makeRow(overrides: Partial<{
  id: string;
  snapshot_name: string;
  snapshot_time: string;
  total_memories: number;
  categories_snapshot: Record<string, number> | string;
  created_at: string;
}> = {}) {
  return {
    id: overrides.id ?? 'snap-001',
    snapshot_name: overrides.snapshot_name ?? 'baseline',
    snapshot_time: overrides.snapshot_time ?? '2026-01-01T00:00:00.000Z',
    total_memories: overrides.total_memories ?? 10,
    categories_snapshot: overrides.categories_snapshot ?? { general: 8, personal: 2 },
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
  };
}

function makePool(rows: ReturnType<typeof makeRow>[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as any;
}

// ─── getTimeline ──────────────────────────────────────────────────────────────

describe('getTimeline', () => {
  it('returns empty timeline when no snapshots', async () => {
    const svc = new ContextSnapshotTimelineService(makePool([]));
    const tl = await svc.getTimeline({ tenantId: TENANT });
    expect(tl.total_snapshots).toBe(0);
    expect(tl.entries).toHaveLength(0);
    expect(tl.summary.total_memory_growth).toBe(0);
    expect(tl.summary.first_snapshot).toBeNull();
  });

  it('builds single-entry timeline with no diff', async () => {
    const svc = new ContextSnapshotTimelineService(makePool([makeRow()]));
    const tl = await svc.getTimeline({ tenantId: TENANT });
    expect(tl.total_snapshots).toBe(1);
    expect(tl.entries[0].diff_from_previous).toBeNull();
    expect(tl.entries[0].snapshot_name).toBe('baseline');
  });

  it('computes adjacent diffs for two snapshots', async () => {
    const rows = [
      makeRow({ id: 's1', snapshot_name: 'v1', snapshot_time: '2026-01-01T00:00:00.000Z', total_memories: 10, categories_snapshot: { a: 10 } }),
      makeRow({ id: 's2', snapshot_name: 'v2', snapshot_time: '2026-01-02T00:00:00.000Z', total_memories: 15, categories_snapshot: { a: 12, b: 3 } }),
    ];
    const svc = new ContextSnapshotTimelineService(makePool(rows));
    const tl = await svc.getTimeline({ tenantId: TENANT });

    expect(tl.entries[0].diff_from_previous).toBeNull();
    const diff = tl.entries[1].diff_from_previous!;
    expect(diff.memory_delta).toBe(5);
    expect(diff.memory_growth_pct).toBe(50);
    expect(diff.added_categories).toContain('b');
    expect(diff.changed_categories.find(c => c.category === 'a')?.delta).toBe(2);
    expect(diff.elapsed_seconds).toBe(86400);
  });

  it('summary: peak_memories and most_active_category', async () => {
    const rows = [
      makeRow({ id: 's1', snapshot_name: 'v1', total_memories: 5, categories_snapshot: { a: 5 } }),
      makeRow({ id: 's2', snapshot_name: 'v2', total_memories: 20, categories_snapshot: { a: 10, b: 10 } }),
      makeRow({ id: 's3', snapshot_name: 'v3', total_memories: 15, categories_snapshot: { a: 15 } }),
    ];
    const svc = new ContextSnapshotTimelineService(makePool(rows));
    const tl = await svc.getTimeline({ tenantId: TENANT });
    expect(tl.summary.peak_memories).toBe(20);
    expect(tl.summary.peak_snapshot).toBe('v2');
    expect(tl.summary.total_memory_growth).toBe(10); // 15 - 5
  });

  it('summary: avg_memories_per_snapshot', async () => {
    const rows = [
      makeRow({ total_memories: 10 }),
      makeRow({ total_memories: 20 }),
      makeRow({ total_memories: 30 }),
    ];
    const svc = new ContextSnapshotTimelineService(makePool(rows));
    const tl = await svc.getTimeline({ tenantId: TENANT });
    expect(tl.summary.avg_memories_per_snapshot).toBe(20);
  });

  it('handles categories_snapshot as JSON string', async () => {
    const rows = [
      makeRow({ categories_snapshot: '{"work":5,"personal":3}' }),
    ];
    const svc = new ContextSnapshotTimelineService(makePool(rows));
    const tl = await svc.getTimeline({ tenantId: TENANT });
    expect(tl.entries[0].categories).toEqual({ work: 5, personal: 3 });
  });
});

// ─── diffSnapshots ────────────────────────────────────────────────────────────

describe('diffSnapshots', () => {
  it('computes diff between two named snapshots', async () => {
    const rows = [
      makeRow({ snapshot_name: 'alpha', snapshot_time: '2026-01-01T00:00:00.000Z', total_memories: 5, categories_snapshot: { a: 5 } }),
      makeRow({ snapshot_name: 'beta',  snapshot_time: '2026-01-02T00:00:00.000Z', total_memories: 8, categories_snapshot: { a: 6, b: 2 } }),
    ];
    const svc = new ContextSnapshotTimelineService(makePool(rows));
    const diff = await svc.diffSnapshots(TENANT, 'alpha', 'beta');

    expect(diff.from_snapshot).toBe('alpha');
    expect(diff.to_snapshot).toBe('beta');
    expect(diff.memory_delta).toBe(3);
    expect(diff.added_categories).toContain('b');
    expect(diff.changed_categories[0].category).toBe('a');
    expect(diff.changed_categories[0].delta).toBe(1);
  });

  it('throws when snapshots not found', async () => {
    const svc = new ContextSnapshotTimelineService(makePool([makeRow({ snapshot_name: 'alpha' })]));
    await expect(svc.diffSnapshots(TENANT, 'alpha', 'missing')).rejects.toThrow('Could not find both snapshots');
  });
});

// ─── getNearestSnapshot ───────────────────────────────────────────────────────

describe('getNearestSnapshot', () => {
  it('returns null when no snapshots exist', async () => {
    const svc = new ContextSnapshotTimelineService(makePool([]));
    const r = await svc.getNearestSnapshot(TENANT, new Date());
    expect(r).toBeNull();
  });

  it('maps direction from signed_diff', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: 's1',
          snapshot_name: 'v1',
          snapshot_time: '2026-01-01T12:00:00.000Z',
          total_memories: 10,
          categories_snapshot: { a: 10 },
          distance_seconds: '3600',
          signed_diff: '-3600', // snapshot is 1h before target → 'before'
        }],
      }),
    } as any;
    const svc = new ContextSnapshotTimelineService(pool);
    const r = await svc.getNearestSnapshot(TENANT, new Date('2026-01-01T13:00:00.000Z'));
    expect(r).not.toBeNull();
    expect(r!.direction).toBe('before');
    expect(r!.distance_seconds).toBe(3600);
  });

  it('returns direction "exact" when distance is 0', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: 's1', snapshot_name: 'v1',
          snapshot_time: '2026-01-01T00:00:00.000Z',
          total_memories: 5,
          categories_snapshot: {},
          distance_seconds: '0',
          signed_diff: '0',
        }],
      }),
    } as any;
    const svc = new ContextSnapshotTimelineService(pool);
    const r = await svc.getNearestSnapshot(TENANT, new Date('2026-01-01T00:00:00.000Z'));
    expect(r!.direction).toBe('exact');
  });
});

// ─── getCategoryEvolution ─────────────────────────────────────────────────────

describe('getCategoryEvolution', () => {
  it('returns all unique categories across snapshots', async () => {
    const rows = [
      makeRow({ categories_snapshot: { a: 1, b: 2 } }),
      makeRow({ categories_snapshot: { b: 3, c: 4 } }),
    ];
    const svc = new ContextSnapshotTimelineService(makePool(rows));
    const evo = await svc.getCategoryEvolution({ tenantId: TENANT });
    expect(evo.categories).toEqual(['a', 'b', 'c']);
    expect(evo.timeline).toHaveLength(2);
    expect(evo.timeline[0].counts).toEqual({ a: 1, b: 2 });
  });
});

// ─── exportAsMarkdown ─────────────────────────────────────────────────────────

describe('exportAsMarkdown', () => {
  it('produces markdown with heading and summary table', async () => {
    const rows = [
      makeRow({ snapshot_name: 'v1', snapshot_time: '2026-01-01T00:00:00.000Z', total_memories: 5, categories_snapshot: { general: 5 } }),
      makeRow({ snapshot_name: 'v2', snapshot_time: '2026-01-02T00:00:00.000Z', total_memories: 10, categories_snapshot: { general: 10 } }),
    ];
    const svc = new ContextSnapshotTimelineService(makePool(rows));
    const md = await svc.exportAsMarkdown({ tenantId: TENANT });

    expect(md).toContain('# Context Snapshot Timeline');
    expect(md).toContain('| Total memory growth |');
    expect(md).toContain('+5'); // delta
    expect(md).toContain('v1');
    expect(md).toContain('v2');
    expect(md).toContain('| general |');
  });

  it('includes diff section for second snapshot', async () => {
    const rows = [
      makeRow({ snapshot_name: 'before', snapshot_time: '2026-01-01T00:00:00.000Z', total_memories: 3, categories_snapshot: { a: 3 } }),
      makeRow({ snapshot_name: 'after',  snapshot_time: '2026-01-02T00:00:00.000Z', total_memories: 7, categories_snapshot: { a: 4, b: 3 } }),
    ];
    const svc = new ContextSnapshotTimelineService(makePool(rows));
    const md = await svc.exportAsMarkdown({ tenantId: TENANT });

    expect(md).toContain('Δ from previous');
    expect(md).toContain('New categories');
  });

  it('returns empty timeline markdown gracefully', async () => {
    const svc = new ContextSnapshotTimelineService(makePool([]));
    const md = await svc.exportAsMarkdown({ tenantId: TENANT });
    expect(md).toContain('# Context Snapshot Timeline');
    expect(md).toContain('0'); // total_snapshots
  });
});
