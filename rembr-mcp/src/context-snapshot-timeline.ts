/**
 * Context Snapshot Timeline — REM-34
 *
 * Chronological view of how context evolved across snapshots:
 *  - Timeline listing with adjacent diffs
 *  - Memory growth / churn metrics between snapshots
 *  - Category evolution over time
 *  - Point-in-time lookup (nearest snapshot to a given timestamp)
 *  - Markdown + JSON export
 */

import type { Pool } from 'pg';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SnapshotRow {
  id: string;
  snapshot_name: string;
  snapshot_time: Date | string;
  total_memories: number;
  categories_snapshot: Record<string, number> | string;
  created_at: Date | string;
}

export interface CategoryDiff {
  category: string;
  before: number;
  after: number;
  delta: number;
  pct_change: number | null;
}

export interface SnapshotDiff {
  from_snapshot: string;
  to_snapshot: string;
  from_time: string;
  to_time: string;
  elapsed_seconds: number;
  memory_delta: number;
  memory_growth_pct: number | null;
  added_categories: string[];
  removed_categories: string[];
  changed_categories: CategoryDiff[];
  unchanged_categories: string[];
}

export interface TimelineEntry {
  index: number;               // 0-based, chronological
  snapshot_id: string;
  snapshot_name: string;
  snapshot_time: string;       // ISO
  total_memories: number;
  categories: Record<string, number>;
  diff_from_previous: SnapshotDiff | null;
}

export interface TimelineResult {
  tenant_id: string;
  from: string | null;
  to: string | null;
  total_snapshots: number;
  entries: TimelineEntry[];
  summary: {
    first_snapshot: string | null;
    last_snapshot: string | null;
    total_memory_growth: number;
    peak_memories: number;
    peak_snapshot: string | null;
    most_active_category: string | null;
    avg_memories_per_snapshot: number;
  };
}

export interface NearestSnapshotResult {
  snapshot_id: string;
  snapshot_name: string;
  snapshot_time: string;
  total_memories: number;
  categories: Record<string, number>;
  distance_seconds: number;
  direction: 'before' | 'after' | 'exact';
}

// ─── Helper utilities ─────────────────────────────────────────────────────────

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function parseCategories(v: Record<string, number> | string): Record<string, number> {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return v || {};
}

function isoStr(v: Date | string): string {
  return toDate(v).toISOString();
}

function diffCategories(
  before: Record<string, number>,
  after: Record<string, number>,
): Pick<SnapshotDiff, 'added_categories' | 'removed_categories' | 'changed_categories' | 'unchanged_categories'> {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: CategoryDiff[] = [];
  const unchanged: string[] = [];

  for (const cat of allKeys) {
    const b = before[cat] ?? 0;
    const a = after[cat] ?? 0;
    if (b === 0 && a > 0) {
      added.push(cat);
    } else if (b > 0 && a === 0) {
      removed.push(cat);
    } else if (b !== a) {
      const delta = a - b;
      changed.push({
        category: cat,
        before: b,
        after: a,
        delta,
        pct_change: b > 0 ? Math.round((delta / b) * 1000) / 10 : null,
      });
    } else {
      unchanged.push(cat);
    }
  }

  return { added_categories: added, removed_categories: removed, changed_categories: changed, unchanged_categories: unchanged };
}

function buildDiff(prev: SnapshotRow, curr: SnapshotRow): SnapshotDiff {
  const fromTime = toDate(prev.snapshot_time);
  const toTime = toDate(curr.snapshot_time);
  const elapsedSec = Math.round((toTime.getTime() - fromTime.getTime()) / 1000);
  const memDelta = curr.total_memories - prev.total_memories;
  const growthPct = prev.total_memories > 0
    ? Math.round((memDelta / prev.total_memories) * 1000) / 10
    : null;

  const catBefore = parseCategories(prev.categories_snapshot);
  const catAfter = parseCategories(curr.categories_snapshot);

  return {
    from_snapshot: prev.snapshot_name,
    to_snapshot: curr.snapshot_name,
    from_time: isoStr(prev.snapshot_time),
    to_time: isoStr(curr.snapshot_time),
    elapsed_seconds: elapsedSec,
    memory_delta: memDelta,
    memory_growth_pct: growthPct,
    ...diffCategories(catBefore, catAfter),
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ContextSnapshotTimelineService {
  constructor(private readonly pool: Pool) {}

  private async fetchSnapshots(
    tenantId: string,
    projectId?: string,
    from?: Date,
    to?: Date,
    limit = 100,
  ): Promise<SnapshotRow[]> {
    const temporalParams: unknown[] = [tenantId];
    const temporalConditions: string[] = ['tenant_id = $1'];
    let idx = 2;

    if (projectId) {
      temporalConditions.push(`(project_id = $${idx} OR project_id IS NULL)`);
      temporalParams.push(projectId); idx++;
    }
    if (from) {
      temporalConditions.push(`snapshot_time >= $${idx}`);
      temporalParams.push(from); idx++;
    }
    if (to) {
      temporalConditions.push(`snapshot_time <= $${idx}`);
      temporalParams.push(to); idx++;
    }

    temporalParams.push(limit);

    const temporalSql = `
      SELECT id, snapshot_name, snapshot_time, total_memories, categories_snapshot, created_at
      FROM temporal_snapshots
      WHERE ${temporalConditions.join(' AND ')}
      ORDER BY snapshot_time ASC
      LIMIT $${idx}
    `;

    const contextParams: unknown[] = [tenantId];
    const contextConditions: string[] = ['cs.tenant_id = $1'];
    idx = 2;

    if (projectId) {
      contextConditions.push(`(cs.project_id = $${idx} OR cs.project_id IS NULL)`);
      contextParams.push(projectId); idx++;
    }
    if (from) {
      contextConditions.push(`cs.created_at >= $${idx}`);
      contextParams.push(from); idx++;
    }
    if (to) {
      contextConditions.push(`cs.created_at <= $${idx}`);
      contextParams.push(to); idx++;
    }

    contextParams.push(limit);

    const contextSql = `
      WITH category_counts AS (
        SELECT snapshot_id, category, COUNT(*)::int AS count
        FROM snapshot_memories
        GROUP BY snapshot_id, category
      ),
      category_json AS (
        SELECT snapshot_id, jsonb_object_agg(COALESCE(category, 'uncategorized'), count) AS categories_snapshot
        FROM category_counts
        GROUP BY snapshot_id
      )
      SELECT
        cs.id,
        COALESCE(cs.name, cs.id::text) AS snapshot_name,
        cs.created_at AS snapshot_time,
        cs.memory_count AS total_memories,
        COALESCE(cj.categories_snapshot, '{}'::jsonb) AS categories_snapshot,
        cs.created_at
      FROM context_snapshots cs
      LEFT JOIN category_json cj ON cj.snapshot_id = cs.id
      WHERE ${contextConditions.join(' AND ')}
        AND (cs.expires_at IS NULL OR cs.expires_at > NOW())
      ORDER BY cs.created_at ASC
      LIMIT $${idx}
    `;

    const [temporalResult, contextResult] = await Promise.all([
      this.pool.query<SnapshotRow>(temporalSql, temporalParams),
      this.pool.query<SnapshotRow>(contextSql, contextParams),
    ]);

    return [...temporalResult.rows, ...contextResult.rows]
      .sort((a, b) => toDate(a.snapshot_time).getTime() - toDate(b.snapshot_time).getTime())
      .slice(0, limit);
  }

  /**
   * Build the full chronological timeline with adjacent diffs.
   */
  async getTimeline(options: {
    tenantId: string;
    projectId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<TimelineResult> {
    const rows = await this.fetchSnapshots(
      options.tenantId,
      options.projectId,
      options.from,
      options.to,
      options.limit ?? 100,
    );

    const entries: TimelineEntry[] = rows.map((row, i) => ({
      index: i,
      snapshot_id: row.id,
      snapshot_name: row.snapshot_name,
      snapshot_time: isoStr(row.snapshot_time),
      total_memories: Number(row.total_memories),
      categories: parseCategories(row.categories_snapshot),
      diff_from_previous: i === 0 ? null : buildDiff(rows[i - 1], row),
    }));

    // Summary stats
    const first = entries[0] ?? null;
    const last = entries[entries.length - 1] ?? null;
    const peak = entries.reduce<TimelineEntry | null>(
      (best, e) => (best === null || e.total_memories > best.total_memories ? e : best), null,
    );
    const totalGrowth = last && first ? last.total_memories - first.total_memories : 0;
    const avgMem = entries.length > 0
      ? Math.round(entries.reduce((s, e) => s + e.total_memories, 0) / entries.length)
      : 0;

    // Most active category (highest total count in last snapshot)
    const lastCats = last?.categories ?? {};
    const mostActive = Object.entries(lastCats).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      tenant_id: options.tenantId,
      from: options.from?.toISOString() ?? null,
      to: options.to?.toISOString() ?? null,
      total_snapshots: rows.length,
      entries,
      summary: {
        first_snapshot: first?.snapshot_name ?? null,
        last_snapshot: last?.snapshot_name ?? null,
        total_memory_growth: totalGrowth,
        peak_memories: peak?.total_memories ?? 0,
        peak_snapshot: peak?.snapshot_name ?? null,
        most_active_category: mostActive,
        avg_memories_per_snapshot: avgMem,
      },
    };
  }

  /**
   * Get diff between two named snapshots.
   */
  async diffSnapshots(
    tenantId: string,
    nameA: string,
    nameB: string,
  ): Promise<SnapshotDiff> {
    const temporalSql = `
      SELECT id, snapshot_name, snapshot_time, total_memories, categories_snapshot, created_at
      FROM temporal_snapshots
      WHERE tenant_id = $1 AND snapshot_name = ANY($2)
      ORDER BY snapshot_time ASC
    `;
    const contextSql = `
      WITH category_counts AS (
        SELECT snapshot_id, category, COUNT(*)::int AS count
        FROM snapshot_memories
        GROUP BY snapshot_id, category
      ),
      category_json AS (
        SELECT snapshot_id, jsonb_object_agg(COALESCE(category, 'uncategorized'), count) AS categories_snapshot
        FROM category_counts
        GROUP BY snapshot_id
      )
      SELECT
        cs.id,
        COALESCE(cs.name, cs.id::text) AS snapshot_name,
        cs.created_at AS snapshot_time,
        cs.memory_count AS total_memories,
        COALESCE(cj.categories_snapshot, '{}'::jsonb) AS categories_snapshot,
        cs.created_at
      FROM context_snapshots cs
      LEFT JOIN category_json cj ON cj.snapshot_id = cs.id
      WHERE cs.tenant_id = $1
        AND cs.name = ANY($2)
        AND (cs.expires_at IS NULL OR cs.expires_at > NOW())
      ORDER BY cs.created_at ASC
    `;

    const [temporalResult, contextResult] = await Promise.all([
      this.pool.query<SnapshotRow>(temporalSql, [tenantId, [nameA, nameB]]),
      this.pool.query<SnapshotRow>(contextSql, [tenantId, [nameA, nameB]]),
    ]);

    const rows = [...temporalResult.rows, ...contextResult.rows]
      .sort((a, b) => toDate(a.snapshot_time).getTime() - toDate(b.snapshot_time).getTime());

    if (rows.length < 2) {
      const found = rows.map(r => r.snapshot_name).join(', ');
      throw new Error(`Could not find both snapshots. Found: [${found}]. Requested: [${nameA}, ${nameB}]`);
    }

    return buildDiff(rows[0], rows[1]);
  }

  /**
   * Find the nearest snapshot to a given timestamp.
   */
  async getNearestSnapshot(
    tenantId: string,
    timestamp: Date,
    projectId?: string,
  ): Promise<NearestSnapshotResult | null> {
    const rows = await this.fetchSnapshots(tenantId, projectId, undefined, undefined, 500);
    if (rows.length === 0) return null;

    const targetMs = timestamp.getTime();
    const row = rows.reduce((best, current) => {
      const bestDistance = Math.abs(toDate(best.snapshot_time).getTime() - targetMs);
      const currentDistance = Math.abs(toDate(current.snapshot_time).getTime() - targetMs);
      return currentDistance < bestDistance ? current : best;
    });

    const signedMs = toDate(row.snapshot_time).getTime() - targetMs;
    const distSec = Math.round(Math.abs(signedMs) / 1000);
    const direction: 'before' | 'after' | 'exact' =
      distSec === 0 ? 'exact' : signedMs < 0 ? 'before' : 'after';

    return {
      snapshot_id: row.id,
      snapshot_name: row.snapshot_name,
      snapshot_time: isoStr(row.snapshot_time),
      total_memories: Number(row.total_memories),
      categories: parseCategories(row.categories_snapshot),
      distance_seconds: distSec,
      direction,
    };
  }

  /**
   * Category evolution: how each category changed across all snapshots.
   */
  async getCategoryEvolution(options: {
    tenantId: string;
    projectId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<{
    categories: string[];
    timeline: Array<{ snapshot_name: string; snapshot_time: string; counts: Record<string, number> }>;
  }> {
    const rows = await this.fetchSnapshots(
      options.tenantId,
      options.projectId,
      options.from,
      options.to,
      options.limit ?? 100,
    );

    const allCats = new Set<string>();
    const timeline = rows.map(row => {
      const counts = parseCategories(row.categories_snapshot);
      Object.keys(counts).forEach(c => allCats.add(c));
      return {
        snapshot_name: row.snapshot_name,
        snapshot_time: isoStr(row.snapshot_time),
        counts,
      };
    });

    return { categories: [...allCats].sort(), timeline };
  }

  /**
   * Export timeline as Markdown.
   */
  async exportAsMarkdown(options: {
    tenantId: string;
    projectId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<string> {
    const tl = await this.getTimeline(options);
    const lines: string[] = [
      `# Context Snapshot Timeline`,
      ``,
      `**Tenant:** ${tl.tenant_id}`,
      `**Snapshots:** ${tl.total_snapshots}`,
      tl.from ? `**From:** ${tl.from}` : '',
      tl.to ? `**To:** ${tl.to}` : '',
      ``,
      `## Summary`,
      ``,
      `| Metric | Value |`,
      `| --- | --- |`,
      `| First snapshot | ${tl.summary.first_snapshot ?? '—'} |`,
      `| Last snapshot | ${tl.summary.last_snapshot ?? '—'} |`,
      `| Total memory growth | ${tl.summary.total_memory_growth >= 0 ? '+' : ''}${tl.summary.total_memory_growth} |`,
      `| Peak memories | ${tl.summary.peak_memories} (${tl.summary.peak_snapshot ?? '—'}) |`,
      `| Most active category | ${tl.summary.most_active_category ?? '—'} |`,
      `| Avg memories/snapshot | ${tl.summary.avg_memories_per_snapshot} |`,
      ``,
      `## Timeline`,
      ``,
    ].filter(l => l !== undefined);

    for (const entry of tl.entries) {
      lines.push(`### ${entry.index + 1}. ${entry.snapshot_name}`);
      lines.push(`**Time:** ${entry.snapshot_time} | **Memories:** ${entry.total_memories}`);
      lines.push('');

      if (entry.diff_from_previous) {
        const d = entry.diff_from_previous;
        const growthStr = d.memory_growth_pct !== null ? ` (${d.memory_growth_pct > 0 ? '+' : ''}${d.memory_growth_pct}%)` : '';
        lines.push(`**Δ from previous:** ${d.memory_delta >= 0 ? '+' : ''}${d.memory_delta} memories${growthStr} over ${d.elapsed_seconds}s`);
        if (d.added_categories.length > 0) lines.push(`**New categories:** ${d.added_categories.join(', ')}`);
        if (d.removed_categories.length > 0) lines.push(`**Removed categories:** ${d.removed_categories.join(', ')}`);
        if (d.changed_categories.length > 0) {
          lines.push(`**Changed categories:** ${d.changed_categories.map(c => `${c.category} ${c.delta >= 0 ? '+' : ''}${c.delta}`).join(', ')}`);
        }
        lines.push('');
      }

      const cats = Object.entries(entry.categories).sort((a, b) => b[1] - a[1]);
      if (cats.length > 0) {
        lines.push('| Category | Count |');
        lines.push('| --- | --- |');
        for (const [cat, count] of cats) {
          lines.push(`| ${cat} | ${count} |`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }
}
