/**
 * Enhanced Search & Filtering (REM-39)
 *
 * Provides:
 * - Advanced filtering: date range, multi-category, metadata operators,
 *   content length, PII flag, sort order
 * - Batch operations: delete, update category/metadata for filtered sets
 * - Saved search queries: save, list, execute, delete named queries
 * - Result export: JSON, CSV, Markdown
 */

import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type SortField = 'created_at' | 'updated_at' | 'content_length' | 'category';
export type SortOrder = 'asc' | 'desc';
export type ExportFormat = 'json' | 'csv' | 'markdown';

export interface MetadataCondition {
  key: string;
  operator: 'eq' | 'neq' | 'contains' | 'exists' | 'gt' | 'lt';
  value?: unknown;
}

export interface AdvancedFilter {
  /** Full-text search query (optional when filtering by other fields) */
  query?: string;
  /** One or more categories (OR logic) */
  categories?: string[];
  /** Single category (alias for categories:[category]) */
  category?: string;
  /** Memories created after this ISO date */
  created_after?: string;
  /** Memories created before this ISO date */
  created_before?: string;
  /** Memories updated after this ISO date */
  updated_after?: string;
  /** Memories updated before this ISO date */
  updated_before?: string;
  /** Min content length in characters */
  min_content_length?: number;
  /** Max content length in characters */
  max_content_length?: number;
  /** Filter to only PII or only non-PII memories */
  pii_only?: boolean;
  /** Exclude memories with PII */
  exclude_pii?: boolean;
  /** Structured metadata conditions (AND logic) */
  metadata_conditions?: MetadataCondition[];
  /** Simple key=value metadata filter (existing compat) */
  metadata_filter?: Record<string, unknown>;
  /** Sort results */
  sort_by?: SortField;
  sort_order?: SortOrder;
  /** Pagination */
  limit?: number;
  offset?: number;
}

export interface FilteredMemory {
  id: string;
  content: string;
  category: string | null;
  metadata: Record<string, unknown>;
  pii_detected: boolean;
  created_at: string;
  updated_at: string;
  content_length: number;
}

export interface BatchResult {
  affected: number;
  ids: string[];
  errors: string[];
}

export interface SavedSearch {
  id: string;
  name: string;
  description: string | null;
  filter: AdvancedFilter;
  tenant_id: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
}

// ─────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────

export class EnhancedSearchService {
  constructor(
    private pool: Pool,
    private tenantId: string,
    private projectId?: string,
  ) {}

  // ─── Advanced Filter Query ───────────────────────────────

  /**
   * Build and execute an advanced filter query against the memories table.
   */
  async filterMemories(filter: AdvancedFilter): Promise<{
    items: FilteredMemory[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const conditions: string[] = ['m.tenant_id = $1'];
    const params: unknown[] = [this.tenantId];
    let p = 2;

    // Project filter
    if (this.projectId) {
      conditions.push(`m.project_id = $${p++}`);
      params.push(this.projectId);
    }

    // Category filter (multi)
    const cats = filter.categories ?? (filter.category ? [filter.category] : undefined);
    if (cats && cats.length > 0) {
      conditions.push(`m.category = ANY($${p++})`);
      params.push(cats);
    }

    // Date range
    if (filter.created_after) {
      conditions.push(`m.created_at >= $${p++}`);
      params.push(new Date(filter.created_after));
    }
    if (filter.created_before) {
      conditions.push(`m.created_at <= $${p++}`);
      params.push(new Date(filter.created_before));
    }
    if (filter.updated_after) {
      conditions.push(`m.updated_at >= $${p++}`);
      params.push(new Date(filter.updated_after));
    }
    if (filter.updated_before) {
      conditions.push(`m.updated_at <= $${p++}`);
      params.push(new Date(filter.updated_before));
    }

    // Content length
    if (filter.min_content_length != null) {
      conditions.push(`LENGTH(m.content) >= $${p++}`);
      params.push(filter.min_content_length);
    }
    if (filter.max_content_length != null) {
      conditions.push(`LENGTH(m.content) <= $${p++}`);
      params.push(filter.max_content_length);
    }

    // PII filter
    if (filter.pii_only === true) {
      conditions.push(`m.pii_detected = true`);
    } else if (filter.exclude_pii === true) {
      conditions.push(`(m.pii_detected = false OR m.pii_detected IS NULL)`);
    }

    // Full-text query
    if (filter.query) {
      conditions.push(`to_tsvector('english', m.content) @@ plainto_tsquery('english', $${p++})`);
      params.push(filter.query);
    }

    // Simple metadata filter
    if (filter.metadata_filter) {
      for (const [key, val] of Object.entries(filter.metadata_filter)) {
        conditions.push(`m.metadata->>'${key.replace(/'/g, "''")}' = $${p++}`);
        params.push(String(val));
      }
    }

    // Structured metadata conditions
    for (const cond of (filter.metadata_conditions ?? [])) {
      const safeKey = cond.key.replace(/'/g, "''");
      switch (cond.operator) {
        case 'eq':
          conditions.push(`m.metadata->>'${safeKey}' = $${p++}`);
          params.push(String(cond.value));
          break;
        case 'neq':
          conditions.push(`m.metadata->>'${safeKey}' != $${p++}`);
          params.push(String(cond.value));
          break;
        case 'contains':
          conditions.push(`m.metadata->>'${safeKey}' ILIKE $${p++}`);
          params.push(`%${cond.value}%`);
          break;
        case 'exists':
          conditions.push(`m.metadata ? '${safeKey}'`);
          break;
        case 'gt':
          conditions.push(`(m.metadata->>'${safeKey}')::numeric > $${p++}`);
          params.push(Number(cond.value));
          break;
        case 'lt':
          conditions.push(`(m.metadata->>'${safeKey}')::numeric < $${p++}`);
          params.push(Number(cond.value));
          break;
      }
    }

    const whereClause = conditions.join(' AND ');

    // Sort
    const sortField: Record<SortField, string> = {
      created_at:     'm.created_at',
      updated_at:     'm.updated_at',
      content_length: 'LENGTH(m.content)',
      category:       'm.category',
    };
    const orderBy = `${sortField[filter.sort_by ?? 'created_at']} ${filter.sort_order === 'asc' ? 'ASC' : 'DESC'}`;

    const limit  = Math.min(filter.limit  ?? 50, 500);
    const offset = filter.offset ?? 0;

    // Count query (no limit/offset)
    const countResult = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM memories m WHERE ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    // Data query
    const dataResult = await this.pool.query<{
      id: string;
      content: string;
      category: string | null;
      metadata: Record<string, unknown>;
      pii_detected: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT m.id, m.content, m.category, m.metadata, m.pii_detected, m.created_at, m.updated_at
       FROM memories m
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset],
    );

    const items: FilteredMemory[] = dataResult.rows.map(r => ({
      id:             r.id,
      content:        r.content,
      category:       r.category,
      metadata:       r.metadata ?? {},
      pii_detected:   r.pii_detected ?? false,
      created_at:     r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at ?? new Date(0).toISOString()),
      updated_at:     r.updated_at instanceof Date ? r.updated_at.toISOString() : (r.updated_at ?? new Date(0).toISOString()),
      content_length: r.content.length,
    }));

    return { items, total, limit, offset };
  }

  // ─── Batch Operations ────────────────────────────────────

  /**
   * Delete all memories matching the filter.
   * Returns count of deleted memories and their IDs.
   */
  async batchDelete(filter: AdvancedFilter): Promise<BatchResult> {
    // First get matching IDs (safety: never delete without explicit filter)
    const hasFilter = filter.query || filter.categories || filter.category ||
                      filter.created_after || filter.created_before ||
                      filter.pii_only || filter.exclude_pii ||
                      filter.metadata_filter || filter.metadata_conditions?.length;
    if (!hasFilter) {
      return { affected: 0, ids: [], errors: ['batch_delete requires at least one filter condition'] };
    }

    const { items } = await this.filterMemories({ ...filter, limit: 500, offset: 0 });
    const ids = items.map(m => m.id);
    if (ids.length === 0) return { affected: 0, ids: [], errors: [] };

    await this.pool.query(
      `DELETE FROM memories WHERE tenant_id = $1 AND id = ANY($2)`,
      [this.tenantId, ids],
    );

    return { affected: ids.length, ids, errors: [] };
  }

  /**
   * Update category and/or metadata for all memories matching the filter.
   */
  async batchUpdate(
    filter: AdvancedFilter,
    updates: { category?: string; metadata_merge?: Record<string, unknown> },
  ): Promise<BatchResult> {
    const hasFilter = filter.query || filter.categories || filter.category ||
                      filter.created_after || filter.created_before ||
                      filter.pii_only || filter.exclude_pii ||
                      filter.metadata_filter || filter.metadata_conditions?.length;
    if (!hasFilter) {
      return { affected: 0, ids: [], errors: ['batch_update requires at least one filter condition'] };
    }
    if (!updates.category && !updates.metadata_merge) {
      return { affected: 0, ids: [], errors: ['batch_update requires category or metadata_merge'] };
    }

    const { items } = await this.filterMemories({ ...filter, limit: 500, offset: 0 });
    const ids = items.map(m => m.id);
    if (ids.length === 0) return { affected: 0, ids: [], errors: [] };

    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [this.tenantId, ids];
    let p = 3;

    if (updates.category) {
      setClauses.push(`category = $${p++}`);
      params.push(updates.category);
    }
    if (updates.metadata_merge) {
      setClauses.push(`metadata = metadata || $${p++}::jsonb`);
      params.push(JSON.stringify(updates.metadata_merge));
    }

    await this.pool.query(
      `UPDATE memories SET ${setClauses.join(', ')} WHERE tenant_id = $1 AND id = ANY($2)`,
      params,
    );

    return { affected: ids.length, ids, errors: [] };
  }

  // ─── Saved Searches ──────────────────────────────────────

  private async ensureSavedSearchTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS saved_searches (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   TEXT        NOT NULL,
        name        TEXT        NOT NULL,
        description TEXT,
        filter      JSONB       NOT NULL DEFAULT '{}',
        use_count   INTEGER     NOT NULL DEFAULT 0,
        last_used_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, name)
      )
    `);
  }

  async saveSearch(name: string, filter: AdvancedFilter, description?: string): Promise<SavedSearch> {
    await this.ensureSavedSearchTable();

    const result = await this.pool.query<SavedSearch & { created_at: Date; last_used_at: Date | null }>(
      `INSERT INTO saved_searches (tenant_id, name, description, filter)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name)
       DO UPDATE SET filter = EXCLUDED.filter, description = COALESCE(EXCLUDED.description, saved_searches.description)
       RETURNING *`,
      [this.tenantId, name, description ?? null, JSON.stringify(filter)],
    );

    return this._formatSavedSearch(result.rows[0] as any);
  }

  async listSavedSearches(): Promise<SavedSearch[]> {
    await this.ensureSavedSearchTable();
    const result = await this.pool.query(
      `SELECT * FROM saved_searches WHERE tenant_id = $1 ORDER BY use_count DESC, created_at DESC`,
      [this.tenantId],
    );
    return result.rows.map(r => this._formatSavedSearch(r));
  }

  async executeSavedSearch(name: string): Promise<{
    search: SavedSearch;
    results: Awaited<ReturnType<EnhancedSearchService['filterMemories']>>;
  }> {
    await this.ensureSavedSearchTable();

    const row = await this.pool.query(
      `UPDATE saved_searches SET use_count = use_count + 1, last_used_at = NOW()
       WHERE tenant_id = $1 AND name = $2
       RETURNING *`,
      [this.tenantId, name],
    );

    if (row.rows.length === 0) throw new Error(`Saved search '${name}' not found`);

    const search = this._formatSavedSearch(row.rows[0]);
    const results = await this.filterMemories(search.filter);

    return { search, results };
  }

  async deleteSavedSearch(name: string): Promise<boolean> {
    await this.ensureSavedSearchTable();
    const result = await this.pool.query(
      `DELETE FROM saved_searches WHERE tenant_id = $1 AND name = $2`,
      [this.tenantId, name],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private _formatSavedSearch(row: Record<string, unknown>): SavedSearch {
    return {
      id:           row.id as string,
      name:         row.name as string,
      description:  row.description as string | null,
      filter:       (typeof row.filter === 'string' ? JSON.parse(row.filter) : row.filter) as AdvancedFilter,
      tenant_id:    row.tenant_id as string,
      created_at:   row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at as string,
      last_used_at: row.last_used_at instanceof Date ? (row.last_used_at as Date).toISOString() : (row.last_used_at as string | null),
      use_count:    row.use_count as number,
    };
  }

  // ─── Export ──────────────────────────────────────────────

  exportAsJSON(items: FilteredMemory[], meta?: Record<string, unknown>): string {
    return JSON.stringify({ exported_at: new Date().toISOString(), count: items.length, ...meta, items }, null, 2);
  }

  exportAsCSV(items: FilteredMemory[]): string {
    const headers = ['id', 'category', 'pii_detected', 'content_length', 'created_at', 'updated_at', 'content'];
    const escape  = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = items.map(m => headers.map(h => escape(m[h as keyof FilteredMemory])).join(','));
    return [headers.join(','), ...rows].join('\n');
  }

  exportAsMarkdown(items: FilteredMemory[], title?: string): string {
    const lines = [
      `# ${title ?? 'Search Results'}`,
      ``,
      `**Exported:** ${new Date().toISOString()}  **Count:** ${items.length}`,
      ``,
      `| id | category | pii | length | created_at |`,
      `|----|----------|-----|--------|------------|`,
      ...items.map(m =>
        `| ${m.id.slice(0, 8)}… | ${m.category ?? '—'} | ${m.pii_detected ? '⚠️' : '✅'} | ${m.content_length} | ${m.created_at.slice(0, 10)} |`
      ),
    ];
    return lines.join('\n');
  }

  export(items: FilteredMemory[], format: ExportFormat, meta?: Record<string, unknown>): string {
    switch (format) {
      case 'csv':      return this.exportAsCSV(items);
      case 'markdown': return this.exportAsMarkdown(items, meta?.title as string);
      default:         return this.exportAsJSON(items, meta);
    }
  }
}
