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

import { Pool, PoolClient } from 'pg';
import {
  assertExportByteBudget,
  encodeCsvCell,
  encodeMarkdownCell,
} from './security/export-encoding.js';

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

const MAX_FILTER_RESULTS = 500;
const MAX_FILTER_OFFSET = 10_000;
const MAX_FILTER_TERMS = 20;
const MAX_QUERY_LENGTH = 2_000;
const MAX_RESULT_CONTENT_BYTES = 1_500_000;
const METADATA_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

interface BuiltFilter {
  whereClause: string;
  params: unknown[];
  nextParameter: number;
  orderBy: string;
  limit: number;
  offset: number;
}

// ─────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────

export class EnhancedSearchService {
  constructor(
    private pool: Pool,
    private tenantId: string,
    private projectId?: string,
    private userId?: string,
    private ownerPrincipal: string = userId
      ? `user:${userId}`
      : `agent-tenant:${tenantId}`,
  ) {}

  private async withTenantContext<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [this.tenantId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private validateMetadataKey(key: string): void {
    if (!METADATA_KEY_PATTERN.test(key)) {
      throw new Error('Metadata filter keys must use 1-64 safe characters');
    }
  }

  private addAudiencePredicate(
    alias: string,
    conditions: string[],
    params: unknown[],
    parameter: number,
  ): number {
    const userParameter = parameter++;
    params.push(this.userId ?? null);
    conditions.push(`(
      (${alias}.visibility = 'personal' AND ${alias}.user_id = $${userParameter}::uuid)
      OR (
        COALESCE(${alias}.visibility, 'shared') IN ('shared', 'project')
        AND (
          ${alias}.project_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM projects audience_project
            WHERE audience_project.id = ${alias}.project_id
              AND audience_project.tenant_id = ${alias}.tenant_id
              AND (
                COALESCE(audience_project.is_personal, FALSE) = FALSE
                OR audience_project.owner_id = $${userParameter}::uuid
                OR EXISTS (
                  SELECT 1 FROM project_members audience_member
                  WHERE audience_member.project_id = audience_project.id
                    AND audience_member.user_id = $${userParameter}::uuid
                )
              )
          )
        )
      )
    )`);
    return parameter;
  }

  private buildFilter(filter: AdvancedFilter): BuiltFilter {
    const conditions: string[] = ['m.tenant_id = $1'];
    const params: unknown[] = [this.tenantId];
    let p = 2;

    if (this.projectId) {
      conditions.push(`m.project_id = $${p++}::uuid`);
      params.push(this.projectId);
    }
    p = this.addAudiencePredicate('m', conditions, params, p);

    const cats = filter.categories ?? (filter.category ? [filter.category] : undefined);
    if (cats && cats.length > 0) {
      if (cats.length > MAX_FILTER_TERMS || cats.some(category => typeof category !== 'string' || category.length > 100)) {
        throw new Error('Category filter exceeds allowed bounds');
      }
      conditions.push(`m.category = ANY($${p++}::text[])`);
      params.push(cats);
    }

    for (const [field, operator] of [
      ['created_after', '>='], ['created_before', '<='],
      ['updated_after', '>='], ['updated_before', '<='],
    ] as const) {
      const raw = filter[field];
      if (!raw) continue;
      const date = new Date(raw);
      if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${field} date`);
      const column = field.startsWith('created') ? 'm.created_at' : 'm.updated_at';
      conditions.push(`${column} ${operator} $${p++}`);
      params.push(date);
    }

    for (const [field, operator] of [
      ['min_content_length', '>='], ['max_content_length', '<='],
    ] as const) {
      const value = filter[field];
      if (value == null) continue;
      if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
        throw new Error(`Invalid ${field}`);
      }
      conditions.push(`LENGTH(m.content) ${operator} $${p++}`);
      params.push(value);
    }

    if (filter.pii_only === true) {
      conditions.push('m.pii_detected = true');
    } else if (filter.exclude_pii === true) {
      conditions.push('(m.pii_detected = false OR m.pii_detected IS NULL)');
    }

    if (filter.query) {
      if (typeof filter.query !== 'string' || filter.query.length > MAX_QUERY_LENGTH) {
        throw new Error('Search query exceeds allowed bounds');
      }
      conditions.push(`to_tsvector('english', m.content) @@ plainto_tsquery('english', $${p++})`);
      params.push(filter.query);
    }

    const metadataEntries = Object.entries(filter.metadata_filter ?? {});
    if (metadataEntries.length > MAX_FILTER_TERMS) throw new Error('Too many metadata filters');
    for (const [key, value] of metadataEntries) {
      this.validateMetadataKey(key);
      conditions.push(`m.metadata ->> $${p++} = $${p++}`);
      params.push(key, String(value));
    }

    const metadataConditions = filter.metadata_conditions ?? [];
    if (metadataConditions.length > MAX_FILTER_TERMS) throw new Error('Too many metadata conditions');
    for (const condition of metadataConditions) {
      this.validateMetadataKey(condition.key);
      const keyParameter = p++;
      params.push(condition.key);
      switch (condition.operator) {
        case 'eq':
          conditions.push(`m.metadata ->> $${keyParameter} = $${p++}`);
          params.push(String(condition.value));
          break;
        case 'neq':
          conditions.push(`m.metadata ->> $${keyParameter} != $${p++}`);
          params.push(String(condition.value));
          break;
        case 'contains':
          conditions.push(`m.metadata ->> $${keyParameter} ILIKE $${p++}`);
          params.push(`%${String(condition.value).slice(0, 1_000)}%`);
          break;
        case 'exists':
          conditions.push(`m.metadata ? $${keyParameter}`);
          break;
        case 'gt':
        case 'lt': {
          const numericValue = Number(condition.value);
          if (!Number.isFinite(numericValue)) throw new Error('Numeric metadata filter requires a finite value');
          const comparison = condition.operator === 'gt' ? '>' : '<';
          conditions.push(`CASE
            WHEN (m.metadata ->> $${keyParameter}) ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN (m.metadata ->> $${keyParameter})::numeric ${comparison} $${p++}
            ELSE FALSE
          END`);
          params.push(numericValue);
          break;
        }
        default:
          throw new Error('Unknown metadata filter operator');
      }
    }

    const sortField: Record<SortField, string> = {
      created_at: 'm.created_at',
      updated_at: 'm.updated_at',
      content_length: 'LENGTH(m.content)',
      category: 'm.category',
    };
    const selectedSort = filter.sort_by ?? 'created_at';
    if (!(selectedSort in sortField)) throw new Error('Invalid sort field');
    const orderBy = `${sortField[selectedSort]} ${filter.sort_order === 'asc' ? 'ASC' : 'DESC'}`;
    const requestedLimit = filter.limit ?? 50;
    const requestedOffset = filter.offset ?? 0;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new Error('Invalid result limit');
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > MAX_FILTER_OFFSET) {
      throw new Error('Invalid result offset');
    }

    return {
      whereClause: conditions.join(' AND '),
      params,
      nextParameter: p,
      orderBy,
      limit: Math.min(requestedLimit, MAX_FILTER_RESULTS),
      offset: requestedOffset,
    };
  }

  // ─── Advanced Filter Query ───────────────────────────────

  /**
   * Build and execute an advanced filter query against the memories table.
   */
  async filterMemories(filter: AdvancedFilter): Promise<{
    items: FilteredMemory[];
    total: number;
    limit: number;
    offset: number;
    truncated: boolean;
  }> {
    return this.withTenantContext(client => this.filterMemoriesWithClient(client, filter));
  }

  private async filterMemoriesWithClient(
    client: PoolClient,
    filter: AdvancedFilter,
  ): Promise<{ items: FilteredMemory[]; total: number; limit: number; offset: number; truncated: boolean }> {
    const built = this.buildFilter(filter);
    const countResult = await client.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM memories m WHERE ${built.whereClause}`,
      built.params,
    );
    const total = Number.parseInt(countResult.rows[0]?.total ?? '0', 10);
    const dataResult = await client.query<{
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
       WHERE ${built.whereClause}
       ORDER BY ${built.orderBy}
       LIMIT $${built.nextParameter} OFFSET $${built.nextParameter + 1}`,
      [...built.params, built.limit, built.offset],
    );

    const items: FilteredMemory[] = [];
    let encodedBytes = 0;
    for (const row of dataResult.rows) {
      const rowBytes = Buffer.byteLength(row.content, 'utf8') +
        Buffer.byteLength(JSON.stringify(row.metadata ?? {}), 'utf8') + 512;
      if (encodedBytes + rowBytes > MAX_RESULT_CONTENT_BYTES) break;
      encodedBytes += rowBytes;
      items.push({
        id: row.id,
        content: row.content,
        category: row.category,
        metadata: row.metadata ?? {},
        pii_detected: row.pii_detected ?? false,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at ?? new Date(0).toISOString()),
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at ?? new Date(0).toISOString()),
        content_length: row.content.length,
      });
    }

    return {
      items,
      total,
      limit: built.limit,
      offset: built.offset,
      truncated: items.length < dataResult.rows.length,
    };
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

    return this.withTenantContext(async client => {
      const { items } = await this.filterMemoriesWithClient(client, { ...filter, limit: MAX_FILTER_RESULTS, offset: 0 });
      const selectedIds = items.map(memory => memory.id);
      if (selectedIds.length === 0) return { affected: 0, ids: [], errors: [] };

      const conditions = ['m.id = ANY($2::uuid[])'];
      const params: unknown[] = [this.tenantId, selectedIds];
      let parameter = 3;
      if (this.projectId) {
        conditions.push(`m.project_id = $${parameter++}::uuid`);
        params.push(this.projectId);
      }
      this.addAudiencePredicate('m', conditions, params, parameter);
      const deleted = await client.query<{ id: string }>(
        `DELETE FROM memories m
          WHERE m.tenant_id = $1
            AND ${conditions.join(' AND ')}
        RETURNING m.id`,
        params,
      );
      const ids = deleted.rows.map(row => row.id);
      return { affected: ids.length, ids, errors: [] };
    });
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

    if (updates.category && (typeof updates.category !== 'string' || updates.category.length > 100)) {
      return { affected: 0, ids: [], errors: ['Invalid category update'] };
    }
    const encodedMetadata = updates.metadata_merge === undefined
      ? undefined
      : JSON.stringify(updates.metadata_merge);
    if (encodedMetadata && Buffer.byteLength(encodedMetadata, 'utf8') > 32_768) {
      return { affected: 0, ids: [], errors: ['Metadata update exceeds 32 KiB'] };
    }

    return this.withTenantContext(async client => {
      const { items } = await this.filterMemoriesWithClient(client, { ...filter, limit: MAX_FILTER_RESULTS, offset: 0 });
      const selectedIds = items.map(memory => memory.id);
      if (selectedIds.length === 0) return { affected: 0, ids: [], errors: [] };

      const setClauses: string[] = ['updated_at = NOW()'];
      const params: unknown[] = [this.tenantId, selectedIds];
      let parameter = 3;
      if (updates.category) {
        setClauses.push(`category = $${parameter++}`);
        params.push(updates.category);
      }
      if (encodedMetadata) {
        setClauses.push(`metadata = metadata || $${parameter++}::jsonb`);
        params.push(encodedMetadata);
      }
      const conditions = ['m.tenant_id = $1', 'm.id = ANY($2::uuid[])'];
      if (this.projectId) {
        conditions.push(`m.project_id = $${parameter++}::uuid`);
        params.push(this.projectId);
      }
      this.addAudiencePredicate('m', conditions, params, parameter);
      const updated = await client.query<{ id: string }>(
        `UPDATE memories m SET ${setClauses.join(', ')}
         WHERE ${conditions.join(' AND ')} RETURNING m.id`,
        params,
      );
      const ids = updated.rows.map(row => row.id);
      return { affected: ids.length, ids, errors: [] };
    });
  }

  // ─── Saved Searches ──────────────────────────────────────

  private async ensureSavedSearchTable(client: PoolClient): Promise<void> {
    const existing = await client.query(`SELECT to_regclass('public.saved_searches') AS table_name`);
    if (!existing.rows[0]?.table_name) {
      throw new Error('Saved searches are unavailable: migration 030 has not been applied');
    }
  }

  async saveSearch(name: string, filter: AdvancedFilter, description?: string): Promise<SavedSearch> {
    const safeName = name?.trim();
    if (!safeName || safeName.length > 100) throw new Error('Saved search name must be 1-100 characters');
    if (description && description.length > 1_000) throw new Error('Saved search description exceeds 1,000 characters');
    // Build once before storage so invalid keys, limits and dates never become
    // a persistent payload that fails later during execution.
    this.buildFilter(filter);
    const encodedFilter = JSON.stringify(filter);
    if (Buffer.byteLength(encodedFilter, 'utf8') > 32_768) throw new Error('Saved search filter exceeds 32 KiB');

    return this.withTenantContext(async client => {
      await this.ensureSavedSearchTable(client);
      const result = await client.query<SavedSearch & { created_at: Date; last_used_at: Date | null }>(
        `INSERT INTO saved_searches
           (tenant_id, project_id, user_id, owner_principal, name, description, filter)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb)
         ON CONFLICT (
           tenant_id,
           owner_principal,
           COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
           name
         )
         DO UPDATE SET
           filter = EXCLUDED.filter,
           description = COALESCE(EXCLUDED.description, saved_searches.description)
         RETURNING *`,
        [
          this.tenantId,
          this.projectId ?? null,
          this.userId ?? null,
          this.ownerPrincipal,
          safeName,
          description ?? null,
          encodedFilter,
        ],
      );
      return this._formatSavedSearch(result.rows[0] as any);
    });
  }

  async listSavedSearches(): Promise<SavedSearch[]> {
    return this.withTenantContext(async client => {
      await this.ensureSavedSearchTable(client);
      const result = await client.query(
        `SELECT * FROM saved_searches
         WHERE tenant_id = $1
           AND owner_principal = $2
           AND project_id IS NOT DISTINCT FROM $3::uuid
         ORDER BY use_count DESC, created_at DESC
         LIMIT 100`,
        [this.tenantId, this.ownerPrincipal, this.projectId ?? null],
      );
      return result.rows.map(row => this._formatSavedSearch(row));
    });
  }

  async executeSavedSearch(name: string): Promise<{
    search: SavedSearch;
    results: Awaited<ReturnType<EnhancedSearchService['filterMemories']>>;
  }> {
    return this.withTenantContext(async client => {
      await this.ensureSavedSearchTable(client);
      const row = await client.query(
        `UPDATE saved_searches SET use_count = use_count + 1, last_used_at = NOW()
         WHERE tenant_id = $1
           AND owner_principal = $2
           AND project_id IS NOT DISTINCT FROM $3::uuid
           AND name = $4
         RETURNING *`,
        [this.tenantId, this.ownerPrincipal, this.projectId ?? null, name],
      );
      if (row.rows.length === 0) throw new Error('Saved search not found');
      const search = this._formatSavedSearch(row.rows[0]);
      const results = await this.filterMemoriesWithClient(client, search.filter);
      return { search, results };
    });
  }

  async deleteSavedSearch(name: string): Promise<boolean> {
    return this.withTenantContext(async client => {
      await this.ensureSavedSearchTable(client);
      const result = await client.query(
        `DELETE FROM saved_searches
         WHERE tenant_id = $1
           AND owner_principal = $2
           AND project_id IS NOT DISTINCT FROM $3::uuid
           AND name = $4`,
        [this.tenantId, this.ownerPrincipal, this.projectId ?? null, name],
      );
      return (result.rowCount ?? 0) > 0;
    });
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
    return assertExportByteBudget(
      JSON.stringify({ exported_at: new Date().toISOString(), count: items.length, ...meta, items }, null, 2),
    );
  }

  exportAsCSV(items: FilteredMemory[]): string {
    const headers = ['id', 'category', 'pii_detected', 'content_length', 'created_at', 'updated_at', 'content'];
    const rows = items.map(memory => headers
      .map(header => encodeCsvCell(memory[header as keyof FilteredMemory]))
      .join(','));
    return assertExportByteBudget([headers.join(','), ...rows].join('\n'));
  }

  exportAsMarkdown(items: FilteredMemory[], title?: string): string {
    const lines = [
      `# ${encodeMarkdownCell(title ?? 'Search Results')}`,
      ``,
      `**Exported:** ${new Date().toISOString()}  **Count:** ${items.length}`,
      ``,
      `| id | category | pii | length | created_at |`,
      `|----|----------|-----|--------|------------|`,
      ...items.map(memory =>
        `| ${encodeMarkdownCell(memory.id.slice(0, 8))}… | ${encodeMarkdownCell(memory.category ?? '—')} | ${memory.pii_detected ? '⚠️' : '✅'} | ${memory.content_length} | ${encodeMarkdownCell(memory.created_at.slice(0, 10))} |`
      ),
    ];
    return assertExportByteBudget(lines.join('\n'));
  }

  export(items: FilteredMemory[], format: ExportFormat, meta?: Record<string, unknown>): string {
    switch (format) {
      case 'csv':      return this.exportAsCSV(items);
      case 'markdown': return this.exportAsMarkdown(items, meta?.title as string);
      default:         return this.exportAsJSON(items, meta);
    }
  }
}
